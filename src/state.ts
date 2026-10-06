import { mkdir, readFile, rename, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CliError, Exit } from './output.js';

export interface AuthConfig {
  environment?: string; authUrl?: string; stsUrl?: string;
  clientId?: string; orgName?: string; username?: string;
}
export interface TokenSet {
  accessToken?: string; refreshToken?: string; codeVerifier?: string;
  obtainedAt?: string; expiresIn?: number;
}
export interface State { auth: AuthConfig; tokens?: TokenSet; debugLog?: boolean }
export function stateDirectory(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (env.STS_HOME) return path.resolve(env.STS_HOME);
  if (process.platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'StsCli');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'StsCli');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'StsCli');
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
    if (value.tokens.expiresIn != null && (typeof value.tokens.expiresIn !== 'number' || !Number.isFinite(value.tokens.expiresIn))) throw new Error('tokens.expiresIn must be a number');
    if (typeof value.tokens.obtainedAt === 'string' && !Number.isFinite(Date.parse(value.tokens.obtainedAt))) throw new Error('tokens.obtainedAt must be an ISO timestamp');
  }
  // Retain the .NET camelCase state shape, including unknown fields for round-tripping.
  return value as unknown as State;
}
export class StateStore {
  readonly file: string;
  constructor(readonly directory = stateDirectory()) { this.file = path.join(directory, 'StsCli.json'); }
  async load(): Promise<State> {
    try { return validateState(JSON.parse((await readFile(this.file, 'utf8')).replace(/^\uFEFF/, ''))); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { auth: {} };
      throw new CliError(Exit.state, `Cannot read state at ${this.file}: ${(e as Error).message}`, 'Repair the file or select a different STS_HOME; it has not been overwritten.');
    }
  }
  async save(state: State): Promise<void> {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let complete = false;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); await handle.sync(); complete = true; }
      finally { await handle.close(); }
      await rename(temp, this.file);
    } catch (e) {
      throw new CliError(Exit.state, `Cannot save state at ${this.file}: ${(e as Error).message}`,
        complete ? `A complete recovery copy is saved at ${temp}. It may contain rotated tokens; do not retry login/refresh with the old state. Fix the filesystem problem, then run sts auth restore --file "${temp}" --force. Keep this file private and delete it after verifying recovery.` : undefined);
    } finally {
      // Never discard a fully written replacement after a failed rename: Oracle
      // may already have invalidated the refresh token in the previous state.
      if (!complete) await unlink(temp).catch(() => {});
    }
  }
  // Serialize mutations so two processes cannot rotate the same refresh token concurrently.
  // Locks are never stolen automatically: after an interrupted process the operator must inspect.
  async mutate<T>(run: (state: State) => Promise<T>): Promise<T> {
    const lockPath = `${this.file}.lock`;
    let lock;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      lock = await open(lockPath, 'wx', 0o600);
    }
    catch (e) {
      throw new CliError(Exit.state, `Cannot lock state: ${(e as Error).message}`, `If another auth command is running, wait. Otherwise inspect ${lockPath} before removing a stale lock.`);
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      const state = await this.load();
      const result = await run(state);
      await this.save(state);
      return result;
    } finally { await lock.close(); await unlink(lockPath); }
  }
}
export function tokenSummary(tokens?: TokenSet) {
  const expiresAt = tokens?.obtainedAt && tokens.expiresIn != null
    ? new Date(Date.parse(tokens.obtainedAt) + tokens.expiresIn * 1000).toISOString() : undefined;
  const secondsRemaining = expiresAt ? Math.floor((Date.parse(expiresAt) - Date.now()) / 1000) : undefined;
  return { hasAccessToken: !!tokens?.accessToken, hasRefreshToken: !!tokens?.refreshToken,
    obtainedAt: tokens?.obtainedAt, expiresIn: tokens?.expiresIn, expiresAt, secondsRemaining,
    expired: secondsRemaining === undefined ? undefined : secondsRemaining <= 0 };
}
