import { request } from './transport.js';

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
// Explicit, advisory lookup only. No credentials, state writes, retries, redirects,
// automatic installation or background calls from STS commands.
export async function checkForUpdates(installedVersion: string, send: typeof request = request): Promise<UpdateCheck> {
  const unavailable: UpdateCheck = { installedVersion, checkStatus: 'unavailable', updateAvailable: null, registryUrl: updateRegistryUrl,
    message: 'Could not verify the latest npm version. Continue with the installed CLI; this is not evidence that it is up to date.' };
  const installed = parseVersion(installedVersion);
  if (!installed) return unavailable;
  try {
    const response = await send({ method: 'GET', url: updateRegistryUrl, headers: { Accept: 'application/json' }, timeoutMs: 5000 });
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
