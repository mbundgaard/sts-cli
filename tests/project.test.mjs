import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const rootDocs = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'AGENTS.md'];
test('public project has MIT license and repository metadata', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.bin.sts, 'bin/sts.js');
  assert.equal(pkg.repository.url, 'git+https://github.com/mbundgaard/sts-cli.git');
  assert.match(await readFile('LICENSE', 'utf8'), /^MIT License/);
  for (const file of rootDocs) await access(file);
});
test('local Markdown links point to files in the public project', async () => {
  const docs = [...rootDocs, ...(await readdir('docs')).filter(n => n.endsWith('.md')).map(n => `docs/${n}`)];
  for (const file of docs) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const link = match[1];
      if (/^(?:[a-z]+:|#)/i.test(link)) continue;
      const target = path.resolve(path.dirname(file), decodeURIComponent(link.split('#')[0]));
      assert.ok(target.startsWith(root + path.sep), `Link escapes project: ${file}`);
      await access(target).catch(() => assert.fail(`Broken link in ${file}: ${link}`));
    }
  }
});
test('legacy artifacts are not present in the public layout', async () => {
  for (const file of ['legacy', 'references', 'tool', 'azure-pipelines.yml', 'StsCli.json']) {
    await assert.rejects(access(file), { code: 'ENOENT' });
  }
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(!pkg.files.some(file => /legacy|references|node_modules|StsCli\.json/.test(file)));
});
