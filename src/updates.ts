import { request } from './transport.js';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const updateRegistryUrl = 'https://registry.npmjs.org/@muneris%2Fsts-cli/latest';
interface Version { core: bigint[]; prerelease: string[] }
function parseVersion(value: unknown): Version | undefined {
  if (typeof value !== 'string' || value.length > 256) return;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(id => /^\d+$/.test(id) && id.length > 1 && id.startsWith('0'))) return;
  return { core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], prerelease };
}
function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]! ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i], right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const ln = /^\d+$/.test(left), rn = /^\d+$/.test(right);
    if (ln && rn) return BigInt(left) > BigInt(right) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}
export interface UpdateCheck {
  installedVersion: string; latestVersion?: string;
  checkStatus: 'up-to-date' | 'update-available' | 'ahead' | 'unavailable';
  updateAvailable: boolean | null; updateCommand?: string; registryUrl: string;
  message: string;
}
// Advisory lookup only. No credentials, retries, redirects or installation.
export async function checkForUpdates(installedVersion: string, send: typeof request = request, timeoutMs = 5000): Promise<UpdateCheck> {
  const unavailable: UpdateCheck = { installedVersion, checkStatus: 'unavailable', updateAvailable: null, registryUrl: updateRegistryUrl,
    message: 'Could not verify the latest npm version. Continue with the installed CLI; this is not evidence that it is up to date.' };
  const installed = parseVersion(installedVersion);
  if (!installed) return unavailable;
  try {
    const response = await send({ method: 'GET', url: updateRegistryUrl, headers: { Accept: 'application/json' }, timeoutMs });
    if (response.status !== 200) return unavailable;
    const metadata: unknown = JSON.parse(response.body.toString('utf8'));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return unavailable;
    const { name, version } = metadata as Record<string, unknown>;
    const latest = parseVersion(version);
    if (name !== '@muneris/sts-cli' || !latest || typeof version !== 'string') return unavailable;
    const order = compare(latest, installed);
    return { installedVersion, latestVersion: version, registryUrl: updateRegistryUrl,
      checkStatus: order > 0 ? 'update-available' : order < 0 ? 'ahead' : 'up-to-date', updateAvailable: order > 0,
      ...(order > 0 ? { updateCommand: `npm install --global @muneris/sts-cli@${version}` } : {}),
      message: order > 0 ? 'A newer npm version is available. Ask the user before updating; review release notes and do not interrupt active writes.'
        : order < 0 ? 'Installed version is ahead of the npm latest tag; no downgrade is recommended.' : 'Installed version matches the npm latest tag.' };
  } catch { return unavailable; }
}

// Reserve the next daily attempt before networking, including on failure/crash.
// Separate from auth/feedback state; corruption or contention simply skips the notice.
export async function notifyForUpdates(directory: string, installedVersion: string,
  check = (version: string) => checkForUpdates(version, request, 1000),
  emit = (text: string) => { process.stderr.write(text); }, now = Date.now()): Promise<void> {
  const file = path.join(directory, 'update-notice.json');
  const lockFile = file + '.lock';
  const temp = file + '.' + randomUUID() + '.tmp';
  let lock;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    lock = await open(lockFile, 'wx', 0o600);
    try {
      let saved: unknown;
      try { saved = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
      if (saved !== undefined) {
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
        const { schemaVersion, nextCheckAt } = saved as Record<string, unknown>;
        if (schemaVersion !== 1 || typeof nextCheckAt !== 'number' || !Number.isSafeInteger(nextCheckAt)) return;
        if (now < nextCheckAt) return;
      }
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, nextCheckAt: now + 86_400_000 }) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, file);
    } finally {
      await lock.close(); lock = undefined;
      await unlink(lockFile);
      await unlink(temp).catch(() => {});
    }
    const result = await check(installedVersion);
    if (result.updateAvailable === true && result.latestVersion && parseVersion(result.latestVersion)) {
      emit(`[update] sts ${result.latestVersion} is available (installed ${installedVersion}). Run sts version --check for details; update using your installation method.\n`);
    }
  } catch {
    // Optional notice failures must never change an already delivered STS result.
  }
}
