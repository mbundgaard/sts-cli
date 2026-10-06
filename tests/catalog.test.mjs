import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportCatalog, documents } from '../scripts/export-catalog.mjs';
const release = { name: '@muneris/sts-cli', version: '1.2.3', date: '2026-01-02', sourceCommit: 'a'.repeat(40) };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sts-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs')); await mkdir(path.join(root, 'catalog/screenshots'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: release.name, version: release.version }));
  const tool = JSON.parse(await readFile('catalog/tool.json', 'utf8'));
  await writeFile(path.join(root, 'catalog/tool.json'), JSON.stringify(tool));
  for (const [input] of documents) await writeFile(path.join(root, input), '# Public docs\n\n[License](../LICENSE)\n');
  await writeFile(path.join(root, 'README.md'), '# Public docs\n[CLI](docs/CLI.md)\n');
  // Actual release date can differ from its changelog date.
  await writeFile(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n## 1.2.3 - 2026-01-01\n\n- Public release\n');
  for (const [input] of documents.filter(([input]) => !input.includes('/') && input !== 'README.md' && input !== 'CHANGELOG.md')) await writeFile(path.join(root, input), '# Public docs\n[License](LICENSE)\n');
  return { root, tool, out: path.join(root, 'export') };
}
test('catalog exports only allowlisted files, adds tab metadata and immutable version links', async t => {
  const { root, out } = await fixture(t);
  await mkdir(path.join(root, 'references')); await writeFile(path.join(root, 'references/private.txt'), 'PRIVATE SYNTHETIC');
  await writeFile(path.join(root, 'StsCli.json'), 'SYNTHETIC SECRET');
  await writeFile(path.join(root, 'catalog/screenshots/unlisted.png'), 'NOT REVIEWED');
  await exportCatalog(root, out, release);
  assert.deepEqual((await readdir(out)).sort(), [...documents.map(d => d[1]), 'tool.json', 'release.json'].sort());
  const metadata = JSON.parse(await readFile(path.join(out, 'release.json'), 'utf8'));
  assert.equal(metadata.install, 'npm install --global @muneris/sts-cli@1.2.3');
  assert.equal(metadata.sourceCommit, release.sourceCommit);
  const readme = await readFile(path.join(out, 'README.md'), 'utf8');
  assert.match(readme, /^---\ntitle: Overview\norder: 1\n---/);
  assert.ok(readme.includes(`https://github.com/mbundgaard/sts-cli/blob/${release.sourceCommit}/docs/CLI.md`));
  await assert.rejects(exportCatalog(root, out, release), { code: 'EEXIST' });
});
test('catalog fails closed on version mismatch or unpublished notes', async t => {
  const { root, out } = await fixture(t);
  await assert.rejects(exportCatalog(root, out, { ...release, version: '9.9.9' }), /metadata/);
  await writeFile(path.join(root, 'CHANGELOG.md'), '## Unreleased\n\n### Added\n- Not published\n\n## 1.2.3 - 2026-01-01\n');
  await assert.rejects(exportCatalog(root, out, release), /unreleased/);
});
test('only explicitly listed screenshots are copied; path traversal is rejected', async t => {
  const { root, out, tool } = await fixture(t);
  tool.screenshots = ['01-example.png'];
  await writeFile(path.join(root, 'catalog/tool.json'), JSON.stringify(tool));
  const bytes = Buffer.from([137, 80, 78, 71]);
  await writeFile(path.join(root, 'catalog/screenshots/01-example.png'), bytes);
  await exportCatalog(root, out, release);
  assert.deepEqual(await readFile(path.join(out, 'screenshots/01-example.png')), bytes);
  tool.screenshots = ['../../references/private.png'];
  await writeFile(path.join(root, 'catalog/tool.json'), JSON.stringify(tool));
  await assert.rejects(exportCatalog(root, path.join(root, 'second'), release), /safe image/);
});
