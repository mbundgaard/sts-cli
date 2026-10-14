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
export interface State { product?: 'sts'; auth: AuthConfig; tokens?: TokenSet; debugLog?: boolean }
export interface Company extends State { refreshAfter?: string }
export interface CompanyState {
  schemaVersion: 2;
  product?: 'sts'; // Untagged legacy STS registries migrate on their next save.
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
// Authentication has stricter transport rules than intentionally supported local STS data URLs.
export function baseUrl(value: string): string {
  const url = validateUrl(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new CliError(Exit.usage, 'Authentication requires HTTPS outside loopback tests');
  if (url.search || value.includes('?') || value.includes('#')) throw new CliError(Exit.usage, 'Base URL cannot contain a query or fragment');
  return url.href.replace(/\/$/, '');
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
  if (value.product !== undefined && value.product !== 'sts') throw new Error('Foreign product state cannot be imported into STS');
  if (Object.keys(value).some(key => !['product', 'auth', 'tokens', 'debugLog'].includes(key))) throw new Error('Unknown STS state field');
  const authKeys = ['environment','authUrl','stsUrl','clientId','orgName','username'];
  if (Object.keys(value.auth).some(key => !authKeys.includes(key))) throw new Error('Unknown auth field; passwords must never be saved');
  for (const key of authKeys) {
    if (value.auth[key] === null) delete value.auth[key]; // Historical optional .NET fields.
    const item = value.auth[key];
    if (item !== undefined && (typeof item !== 'string' || !item.trim() || /[\u0000-\u001f\u007f]/.test(item))) throw new Error(`Invalid auth.${key}`);
  }
  if (typeof value.auth.authUrl === 'string') baseUrl(value.auth.authUrl);
  if (typeof value.auth.stsUrl === 'string') {
    const url = validateUrl(value.auth.stsUrl);
    if (url.search || value.auth.stsUrl.includes('?') || value.auth.stsUrl.includes('#')) throw new Error('Invalid STS base URL');
  }
  if (value.debugLog === null) delete value.debugLog;
  if (value.debugLog !== undefined && typeof value.debugLog !== 'boolean') throw new Error('debugLog must be a boolean');
  if (value.tokens === null) delete value.tokens;
  if (value.tokens !== undefined) {
    if (!object(value.tokens)) throw new Error('tokens must be an object');
    const tokenKeys = ['accessToken', 'refreshToken', 'codeVerifier', 'obtainedAt', 'expiresIn'];
    if (Object.keys(value.tokens).some(key => !tokenKeys.includes(key))) throw new Error('Unknown token field; STS requires access_token, not BI/CC id_token');
    for (const key of tokenKeys) if (value.tokens[key] === null) delete value.tokens[key];
    // Legacy STS snapshots may be incomplete/non-refreshable. Preserve their known
    // fields without inventing credentials; newly issued token sets are complete.
    for (const key of ['accessToken','refreshToken','codeVerifier','obtainedAt']) {
      const item = value.tokens[key];
      if (item !== undefined && (typeof item !== 'string' || !item.trim() || /[\u0000-\u001f\u007f]/.test(item))) throw new Error(`Invalid tokens.${key}`);
    }
    if (value.tokens.codeVerifier !== undefined && !/^[A-Za-z0-9._~-]{43,128}$/.test(value.tokens.codeVerifier as string)) throw new Error('Invalid saved PKCE verifier');
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
  return `${organizationFromClientId(auth.clientId)}@${new URL(baseUrl(auth.authUrl)).hostname.toLowerCase()}`;
}
export function emptyCompanies(): CompanyState { return { schemaVersion: 2, product: 'sts', activeCompany: null, companies: {} }; }
function scheduleLegacy(profile: Company): void {
  if (profile.tokens && profile.refreshAfter === undefined) {
    profile.refreshAfter = new Date(profile.tokens.obtainedAt ? Date.parse(profile.tokens.obtainedAt) + DAY : 0).toISOString();
  }
}
export function validateCompanies(value: unknown): CompanyState {
  if (!object(value)) throw new Error('Invalid company state');
  if (value.product !== undefined && value.product !== 'sts') throw new Error('Foreign product state cannot be imported into STS');
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
  if (Object.keys(value).some(key => !['schemaVersion', 'product', 'activeCompany', 'companies', 'pending'].includes(key))) throw new Error('Unknown STS registry field');
  for (const [key, item] of Object.entries(value.companies)) {
    if (!object(item)) throw new Error('Invalid STS company profile');
    const { refreshAfter, ...snapshot } = item;
    const profile: Company = validateState(snapshot);
    if (companyKey(profile.auth) !== key) throw new Error('Company key does not match its client ID/auth hostname');
    if (refreshAfter !== undefined && (typeof refreshAfter !== 'string' || !timestamp(refreshAfter))) throw new Error('Invalid refreshAfter timestamp');
    if (refreshAfter !== undefined) profile.refreshAfter = refreshAfter as string;
    scheduleLegacy(profile); value.companies[key] = profile;
  }
  if (value.activeCompany !== null && !Object.hasOwn(value.companies, value.activeCompany as string)) throw new Error('Active company is not present in the registry');
  if (value.pending !== undefined) validateState(value.pending);
  value.product = 'sts';
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
