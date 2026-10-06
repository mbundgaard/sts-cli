import { mkdtemp, readFile, writeFile, rm, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [output, existing] = process.argv.slice(2);
if (!output || !existing) throw new Error('Usage: node scripts/sync-catalog.mjs <new-output-directory> <current-catalog-directory>');
async function json(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'MunerisTools-catalog-sync' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Metadata lookup failed: HTTP ${response.status}`);
  return response.json();
}
const metadata = await json('https://registry.npmjs.org/@muneris%2Fsts-cli/latest');
if (metadata.name !== '@muneris/sts-cli' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(metadata.version)) throw new Error('Expected a published stable STS version');
const release = await json(`https://api.github.com/repos/mbundgaard/sts-cli/releases/tags/v${metadata.version}`);
if (release.draft || release.prerelease || !release.published_at || release.tag_name !== `v${metadata.version}`) throw new Error('Expected matching published GitHub release');
const temp = await mkdtemp(path.join(tmpdir(), 'sts-catalog-sync-'));
try {
  const source = path.join(temp, 'source'), exported = path.join(temp, 'export');
  execFileSync('git', ['clone', '--depth', '1', '--branch', `v${metadata.version}`, 'https://github.com/mbundgaard/sts-cli.git', source], { stdio: 'pipe', timeout: 120000 });
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (metadata.gitHead && metadata.gitHead !== commit) throw new Error('npm source commit does not match the release tag');
  let supported = true;
  try { await access(path.join(source, 'scripts/export-catalog.mjs')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log(`Published ${metadata.version} predates catalog export support; leaving the site unchanged.`);
    supported = false;
  }
  if (supported) {
    const data = path.join(temp, 'release.json');
    await writeFile(data, JSON.stringify({ name: metadata.name, version: metadata.version, date: release.published_at.slice(0, 10), sourceCommit: commit }));
    // Public release code runs without repository-write tokens. Never use main or
    // arbitrary URLs from metadata to select code or installation instructions.
    execFileSync(process.execPath, [path.join(source, 'scripts/export-catalog.mjs'), exported, data], { stdio: 'inherit', timeout: 30000 });
    const target = path.resolve(existing);
    let previous;
    try { previous = JSON.parse(await readFile(path.join(target, 'release.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous && /^\d+\.\d+\.\d+$/.test(previous.version)) {
      const old = previous.version.split('.').map(BigInt), next = metadata.version.split('.').map(BigInt);
      const difference = next.findIndex((value, i) => value !== old[i]);
      if (difference >= 0 && next[difference] < old[difference]) throw new Error('Refusing to downgrade catalog metadata');
      if (difference < 0 && previous.sourceCommit && previous.sourceCommit !== commit) throw new Error('Published tag moved; inspect rather than overwrite the same release');
    }
    // Provider emits a new bundle; only the generic consumer applies it.
    await cp(exported, path.resolve(output), { recursive: true, errorOnExist: true, force: false });
    console.log(`Catalog prepared for STS ${metadata.version} (${commit}); review the diff before publishing.`);
  }
} finally { await rm(temp, { recursive: true, force: true }); }
