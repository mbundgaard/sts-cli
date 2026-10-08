import { mkdir, readFile, rename, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CliError, Exit } from './output.js';
import { organizationFromClientId } from './identity.js';
import { validateUrl } from './transport.js';

export interface AuthConfig {
  environment?: string; authUrl?: string; stsUrl?: string;
  clientId?: string; orgName?: string; username?: string;
}
export interface TokenSet {
  accessToken?: string; refreshToken?: string; codeVerifier?: string;
  obtainedAt?: string; expiresIn?: number;
}
// Request/auth clients still consume one coherent company snapshot, never the registry.
export interface State { auth: AuthConfig; tokens?: TokenSet; debugLog?: boolean }
export interface Company extends State { refreshAfter?: string }
export interface CompanyState {
  schemaVersion: 2;
  activeCompany: string | null;
  companies: Record<string, Company>;
  // Normal auth config staging. Incomplete legacy state is retained here as well.
  pending?: State;
}
export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
export function stateDirectory(home = os.homedir()): string {
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'StsCli');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'StsCli');
  return path.join(home, '.config', 'StsCli');
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function timestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const lastDay = new Date(0); lastDay.setUTCFullYear(year!, month!, 0);
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= lastDay.getUTCDate();
}
export function validateState(value: unknown): State {
  if (!object(value) || !object(value.auth)) throw new Error('state must contain an auth object');
  for (const key of ['environment','authUrl','stsUrl','clientId','orgName','username']) {
    if (value.auth[key] !== undefined && value.auth[key] !== null && typeof value.auth[key] !== 'string') throw new Error(`auth.${key} must be a string`);
  }
  if (value.tokens !== undefined && value.tokens !== null) {
    if (!object(value.tokens)) throw new Error('tokens must be an object');
    for (const key of ['accessToken','refreshToken','codeVerifier','obtainedAt']) {
      if (value.tokens[key] != null && typeof value.tokens[key] !== 'string') throw new Error(`tokens.${key} must be a string`);
    }
    if (value.tokens.expiresIn != null && (typeof value.tokens.expiresIn !== 'number' || !Number.isSafeInteger(value.tokens.expiresIn) || value.tokens.expiresIn < 0)) throw new Error('tokens.expiresIn must be nonnegative whole seconds');
    if (typeof value.tokens.obtainedAt === 'string' && !timestamp(value.tokens.obtainedAt)) throw new Error('tokens.obtainedAt must be an ISO timestamp');
    if (value.tokens.obtainedAt && value.tokens.expiresIn != null && !Number.isFinite(new Date(Date.parse(value.tokens.obtainedAt as string) + (value.tokens.expiresIn as number) * 1000).getTime())) throw new Error('Invalid token expiry');
  }
  if (typeof value.auth.clientId === 'string' && value.auth.clientId) value.auth.orgName = organizationFromClientId(value.auth.clientId);
  else delete value.auth.orgName;
  return value as unknown as State;
}
export function companyKey(auth: AuthConfig): string {
  if (!auth.clientId || !auth.authUrl) throw new CliError(Exit.notConfigured, 'Client ID and auth URL are required to identify a company');
  return `${organizationFromClientId(auth.clientId)}@${validateUrl(auth.authUrl).hostname.toLowerCase()}`;
}
export function emptyCompanies(): CompanyState { return { schemaVersion: 2, activeCompany: null, companies: {} }; }
function scheduleLegacy(profile: Company): void {
  if (profile.tokens && profile.refreshAfter === undefined) {
    profile.refreshAfter = new Date(profile.tokens.obtainedAt ? Date.parse(profile.tokens.obtainedAt) + DAY : 0).toISOString();
  }
}
export function validateCompanies(value: unknown): CompanyState {
  if (!object(value)) throw new Error('Invalid company state');
  if (value.schemaVersion === undefined) {
    const legacy = validateState(value);
    const result = emptyCompanies();
    if (legacy.auth.clientId && legacy.auth.authUrl) {
      const key = companyKey(legacy.auth); const profile: Company = { ...legacy };
      scheduleLegacy(profile); result.companies[key] = profile; result.activeCompany = key;
    } else result.pending = legacy;
    return result;
  }
  if (value.schemaVersion !== 2 || !object(value.companies) || (value.activeCompany !== null && typeof value.activeCompany !== 'string')) throw new Error('Invalid company registry schema');
  for (const [key, item] of Object.entries(value.companies)) {
    const profile = validateState(item) as Company;
    if (companyKey(profile.auth) !== key) throw new Error('Company key does not match its client ID/auth hostname');
    if (profile.refreshAfter !== undefined && (typeof profile.refreshAfter !== 'string' || !timestamp(profile.refreshAfter))) throw new Error('Invalid refreshAfter timestamp');
    scheduleLegacy(profile);
  }
  if (value.activeCompany !== null && !Object.hasOwn(value.companies, value.activeCompany as string)) throw new Error('Active company is not present in the registry');
  if (value.pending !== undefined) validateState(value.pending);
  return value as unknown as CompanyState;
}
export function activeState(registry: CompanyState): Company {
  if (!registry.activeCompany) throw new CliError(Exit.notConfigured, 'No active company; log in or use sts company select <exact-key>');
  return registry.companies[registry.activeCompany]!;
}
function configurationState(registry: CompanyState): State {
  const profile = registry.pending ?? (registry.activeCompany ? registry.companies[registry.activeCompany]! : { auth: {} });
  const { refreshAfter: _schedule, ...state } = profile as Company;
  return state;
}
export class StateStore {
  readonly file: string;
  constructor(readonly directory = stateDirectory()) { this.file = path.join(directory, 'StsCli.json'); }
  async loadCompanies(): Promise<CompanyState> {
    try { return validateCompanies(JSON.parse((await readFile(this.file, 'utf8')).replace(/^\uFEFF/, ''))); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyCompanies();
      throw new CliError(Exit.state, `Cannot read company state at ${this.file}; invalid or inaccessible state`, 'Repair from a protected backup; the file has not been overwritten.');
    }
  }
  // Configuration/legacy integration view. API execution explicitly selects activeState instead.
  async load(): Promise<State> { return configurationState(await this.loadCompanies()); }
  async save(state: State): Promise<void> {
    // Internal snapshot helper: never discard sibling companies when updating one.
    const incoming = validateCompanies(state);
    const registry = await this.loadCompanies();
    if (incoming.activeCompany) {
      registry.companies[incoming.activeCompany] = incoming.companies[incoming.activeCompany]!;
      registry.activeCompany = incoming.activeCompany; delete registry.pending;
    } else registry.pending = incoming.pending;
    await this.saveCompanies(registry);
  }
  async saveCompanies(registry: CompanyState): Promise<void> {
    validateCompanies(registry);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let complete = false;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(registry, null, 2) + '\n'); await handle.sync(); complete = true; }
      finally { await handle.close(); }
      await rename(temp, this.file);
    } catch {
      throw new CliError(Exit.state, `Cannot save state at ${this.file}`,
        complete ? `A complete recovery copy is saved at ${temp}. It may contain rotated tokens; do not retry login/refresh with the old state. Fix the filesystem problem, then run sts auth restore --file "${temp}" --force. Keep this file private and delete it after verifying recovery.` : 'No complete replacement was saved. Stop and resolve persistence before further authentication.');
    } finally { if (!complete) await unlink(temp).catch(() => {}); }
  }
  // Serialize registry selection/configuration and token rotation. Never steal a lock.
  async mutateCompanies<T>(run: (registry: CompanyState) => Promise<T>): Promise<T> {
    const lockPath = `${this.file}.lock`;
    let lock;
    try { await mkdir(this.directory, { recursive: true, mode: 0o700 }); lock = await open(lockPath, 'wx', 0o600); }
    catch { throw new CliError(Exit.state, 'Cannot lock company state', `If another state/auth command is running, wait. Otherwise inspect ${lockPath} before removing a stale lock.`); }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      const registry = await this.loadCompanies();
      const result = await run(registry);
      await this.saveCompanies(registry);
      return result;
    } finally { await lock.close(); await unlink(lockPath); }
  }
  // Internal single-profile compatibility for tests/integrations, not a CLI override.
  async mutate<T>(run: (state: State) => Promise<T>): Promise<T> {
    return this.mutateCompanies(async registry => {
      const state = configurationState(registry);
      const result = await run(state);
      if (registry.pending || !registry.activeCompany) {
        const migrated = validateCompanies(state);
        if (migrated.activeCompany) {
          const key = migrated.activeCompany; registry.companies[key] = migrated.companies[key]!; registry.activeCompany = key; delete registry.pending;
        } else registry.pending = state;
      } else {
        if (companyKey(state.auth) !== registry.activeCompany) throw new CliError(Exit.usage, 'Use auth config/login to change company identity');
        const prior = registry.companies[registry.activeCompany]!;
        registry.companies[registry.activeCompany] = { ...state, ...(prior.refreshAfter ? { refreshAfter: prior.refreshAfter } : {}) };
      }
      return result;
    });
  }
}
export function tokenSummary(tokens?: TokenSet, now = Date.now()) {
  const expiresAt = tokens?.obtainedAt && tokens.expiresIn != null
    ? new Date(Date.parse(tokens.obtainedAt) + tokens.expiresIn * 1000).toISOString() : undefined;
  const secondsRemaining = expiresAt ? Math.floor((Date.parse(expiresAt) - now) / 1000) : undefined;
  return { hasAccessToken: !!tokens?.accessToken, hasRefreshToken: !!tokens?.refreshToken,
    obtainedAt: tokens?.obtainedAt, expiresIn: tokens?.expiresIn, expiresAt, secondsRemaining,
    expired: expiresAt === undefined ? undefined : Date.parse(expiresAt) <= now };
}
