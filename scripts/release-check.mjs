import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function validateRelease(tag, pkg, lock) {
  if (pkg.name !== '@muneris/sts-cli') throw new Error('Unexpected npm package name');
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('This workflow publishes stable SemVer releases only');
  if (tag !== `v${pkg.version}`) throw new Error(`Release tag must be v${pkg.version}`);
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('package.json and package-lock.json versions must match');
  }
  return `muneris-sts-cli-${pkg.version}.tgz`;
}

async function main() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const archive = validateRelease(process.env.STS_RELEASE_TAG, pkg, lock);
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`, {
    signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' },
  });
  if (response.ok) throw new Error(`${pkg.name}@${pkg.version} is already published; do not republish`);
  if (response.status !== 404) throw new Error(`Cannot establish version availability: registry HTTP ${response.status}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `archive=${archive}\n`);
  console.log(`Validated ${process.env.STS_RELEASE_TAG}; ${pkg.name}@${pkg.version} is not published.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
