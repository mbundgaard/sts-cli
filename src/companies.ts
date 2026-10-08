import type { Command } from 'commander';
import { AuthClient } from './auth.js';
import { StateStore, companyKey, tokenSummary, DAY, HOUR, type Company, type AuthConfig } from './state.js';
import { CliError, Exit, localResult } from './output.js';

export function clearExpired(profile: Company, now = Date.now()): boolean {
  if (tokenSummary(profile.tokens, now).expired !== true) return false;
  delete profile.tokens; delete profile.refreshAfter; return true;
}
export function registerCompanies(root: Command, store: StateStore): void {
  const company = root.command('company').description('[local] List, select and delete saved company profiles; no Oracle discovery');
  company.command('list').description('[read-only][local] Saved companies and token status, not proof of current Oracle access').action(async () => {
    const registry = await store.loadCompanies();
    localResult('company list', { activeCompany: registry.activeCompany, companies: Object.entries(registry.companies).map(([key, profile]) => ({
      key, active: key === registry.activeCompany, companyCode: profile.auth.orgName,
      authUrl: profile.auth.authUrl, stsUrl: profile.auth.stsUrl, username: profile.auth.username,
      tokens: tokenSummary(profile.tokens), refreshAfter: profile.refreshAfter,
    })) });
  });
  company.command('status').description('[read-only][local] Active saved company, without tokens or network').action(async () => {
    const registry = await store.loadCompanies();
    localResult('company status', { activeCompany: registry.activeCompany });
  });
  company.command('select <key>').description('[writes-state][local] Select an exact companyCode@authHostname key; no shorthand or login').action(async key => {
    await store.mutateCompanies(async registry => {
      if (!Object.hasOwn(registry.companies, key)) throw new CliError(Exit.usage, 'Unknown exact company key; run sts company list');
      registry.activeCompany = key;
      delete registry.pending; // Explicit selection also selects the saved auth configuration.
    });
    localResult('company select', { activeCompany: key });
  });
  company.command('delete <key>').description('[DESTRUCTIVE][local] Delete one exact saved profile and its tokens; no Oracle revocation')
    .addHelpText('after', '\nAgents: confirm the requested deletion with the user. No interactive CLI prompt.\nDeleting the active entry clears activeCompany; another entry is never auto-selected.\n')
    .action(async key => {
      await store.mutateCompanies(async registry => {
        if (!Object.hasOwn(registry.companies, key)) throw new CliError(Exit.usage, 'Unknown exact company key; run sts company list');
        delete registry.companies[key];
        if (registry.pending?.auth.clientId && registry.pending.auth.authUrl && companyKey(registry.pending.auth) === key) delete registry.pending;
        if (registry.activeCompany === key) registry.activeCompany = null;
      });
      localResult('company delete', { deleted: key, activeCompany: (await store.loadCompanies()).activeCompany });
    });
}
export async function loginCompany(store: StateStore, password: string | undefined, username?: string, timeout = 30, quiet = false) {
  let savedKey = '', alreadyStored = false;
  await store.mutateCompanies(async registry => {
    const source = registry.pending ?? (registry.activeCompany ? registry.companies[registry.activeCompany] : undefined);
    const auth: AuthConfig = { ...(source?.auth ?? {}), ...(username !== undefined ? { username } : {}) };
    const key = companyKey(auth);
    const existing = registry.companies[key];
    // Do not mutate stored entries until login succeeds. Expired credentials do not
    // block fresh login; failed login leaves the prior company/selection intact.
    if (existing && auth.username && existing.auth.username === auth.username && existing.tokens?.accessToken && tokenSummary(existing.tokens).expired !== true) {
      alreadyStored = true; savedKey = key; return;
    }
    if (!password) throw new CliError(Exit.usage, 'Supply --password');
    const tokens = await new AuthClient(timeout * 1000, quiet).login(auth, password);
    registry.companies[key] = { auth, tokens, refreshAfter: new Date(Date.now() + DAY).toISOString() };
    registry.activeCompany = key; delete registry.pending; savedKey = key;
  });
  const registry = await store.loadCompanies();
  return { saved: !alreadyStored, alreadyStored, company: savedKey, activeCompany: registry.activeCompany,
    ...(alreadyStored ? { message: 'A token is already saved for this company/environment and username. No login request was sent; active company was not changed. Use company select with the exact key to use it.' } : {}),
    configPath: store.file, tokens: tokenSummary(registry.companies[savedKey]?.tokens) };
}
export interface RefreshResult { company: string; status: string; code?: number; refreshAfter?: string }
// One attempt per eligible profile, under the same lock as select/delete/login.
// Each result is persisted before proceeding; persistence failure escapes immediately.
export async function refreshCompanies(store: StateStore, onlyDue: boolean, timeout = 30, quiet = false): Promise<RefreshResult[]> {
  const initial = await store.loadCompanies();
  const results: RefreshResult[] = [];
  for (const [key, snapshot] of Object.entries(initial.companies)) {
    const due = (profile: Company, now: number) => !profile.refreshAfter || Date.parse(profile.refreshAfter) <= now;
    if (onlyDue && !snapshot.tokens) continue;
    if (onlyDue && tokenSummary(snapshot.tokens).expired !== true && !due(snapshot, Date.now())) continue;
    const result = await store.mutateCompanies(async registry => {
      const profile = registry.companies[key];
      if (!profile) return { company: key, status: 'deleted' };
      const now = Date.now();
      if (clearExpired(profile, now)) return { company: key, status: 'expired-cleared', code: Exit.noTokens };
      if (!profile.tokens) return { company: key, status: 'no-tokens', code: Exit.noTokens };
      // Recheck after locking: another invocation may already have renewed it.
      if (onlyDue && !due(profile, now)) return { company: key, status: 'not-due' };
      if (tokenSummary(profile.tokens, now).expired === undefined) return { company: key, status: 'unknown-expiry', code: Exit.auth };
      let renewed;
      try { renewed = await new AuthClient(timeout * 1000, quiet).refresh(profile.auth, profile.tokens); }
      catch (error) {
        if (clearExpired(profile)) return { company: key, status: 'expired-cleared', code: Exit.noTokens };
        profile.refreshAfter = new Date(Date.now() + HOUR).toISOString();
        return { company: key, status: 'failed', code: error instanceof CliError ? error.exitCode : Exit.auth, refreshAfter: profile.refreshAfter };
      }
      profile.tokens = renewed; profile.refreshAfter = new Date(Date.now() + DAY).toISOString();
      return { company: key, status: 'refreshed', refreshAfter: profile.refreshAfter };
    });
    results.push(result);
    if (onlyDue && result.status !== 'not-due' && result.status !== 'deleted' && (result.code || !quiet)) {
      process.stderr.write(`[auth ${key}] ${result.status}${result.refreshAfter ? `; refreshAfter ${result.refreshAfter}` : ''}\n`);
    }
  }
  return results;
}
