import { readFile, writeFile, mkdir, lstat, realpath, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const documents = [
  ['README.md', 'README.md', 'Overview', 1],
  ['docs/CLI.md', 'CLI.md', 'Commands', 2],
  ['docs/AUTHENTICATION.md', 'AUTHENTICATION.md', 'Authentication', 3],
  ['CHANGELOG.md', 'CHANGELOG.md', 'Changelog', 100],
];
async function safeSource(root, relative) {
  const file = path.join(root, relative);
  let component = root;
  for (const part of relative.split('/')) {
    component = path.join(component, part);
    if ((await lstat(component)).isSymbolicLink()) throw new Error('Catalog sources must not use symlinks');
  }
  if (!(await lstat(file)).isFile() || !(await realpath(file)).startsWith((await realpath(root)) + path.sep)) throw new Error('Catalog source must be a regular file inside the source tree');
  return file;
}
export async function exportCatalog(root, output, release) {
  root = path.resolve(root); output = path.resolve(output);
  // Never export over a checkout or merge into an existing directory. The caller
  // stages the complete export separately before replacing only its owned slug.
  if (output === root || root.startsWith(output + path.sep)) throw new Error('Unsafe catalog output directory');
  const pkg = JSON.parse(await readFile(await safeSource(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@muneris/sts-cli' || release.name !== pkg.name || release.version !== pkg.version ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.version) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(release.date) || !/^[a-f0-9]{40}$/.test(release.sourceCommit)) throw new Error('Release metadata must match this stable source version');
  const frame = JSON.parse(await readFile(await safeSource(root, 'catalog/tool.json'), 'utf8'));
  if (frame.distribution?.type !== 'npm' || frame.distribution.package !== pkg.name || !Array.isArray(frame.screenshots)) throw new Error('Invalid catalog metadata');
  const changelog = await readFile(await safeSource(root, 'CHANGELOG.md'), 'utf8');
  if (!changelog.split('\n').some(line => line.startsWith(`## ${release.version} - `) && / - \d{4}-\d{2}-\d{2}$/.test(line))) throw new Error('Changelog does not identify this release');
  const unreleased = changelog.split(/^## /m).find(section => /^Unreleased\s*\n/.test(section));
  if (unreleased && unreleased.slice(unreleased.indexOf('\n') + 1).trim()) throw new Error('Cannot export unreleased notes as published documentation');
  const screenshots = [];
  for (const file of frame.screenshots) {
    if (typeof file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g|gif|webp|avif)$/i.test(file)) throw new Error('Screenshot must be an explicitly listed safe image filename');
    screenshots.push([file, await safeSource(root, 'catalog/screenshots/' + file)]);
  }
  const contents = [];
  for (const [input, name, title, order] of documents) {
    let text = await readFile(await safeSource(root, input), 'utf8');
    text = text.replace(/\]\(([^\s)]+)\)/g, (whole, target) => {
      if (/^[a-z]+:/i.test(target)) return whole;
      const [file, anchor] = target.split('#');
      const resolved = file ? path.posix.normalize(path.posix.join(path.posix.dirname(input), file)) : input;
      if (resolved.startsWith('../') || resolved.startsWith('/')) throw new Error('Documentation link escapes source');
      return `](https://github.com/mbundgaard/sts-cli/blob/${release.sourceCommit}/${resolved}${anchor ? '#' + anchor : ''})`;
    });
    contents.push([name, `---\ntitle: ${title}\norder: ${order}\n---\n\n${text.replace(/\r\n/g, '\n')}`]);
  }
  await mkdir(output); // Must not exist: avoids accidental deletion/unreviewed leftovers.
  const { screenshots: reviewedScreenshots, ...tool } = frame;
  await writeFile(path.join(output, 'tool.json'), JSON.stringify(tool, null, 2) + '\n');
  await writeFile(path.join(output, 'release.json'), JSON.stringify({
    version: release.version, date: release.date,
    url: 'https://www.npmjs.com/package/@muneris/sts-cli',
    install: `npm install --global @muneris/sts-cli@${release.version}`,
    actions: [
      { type: 'command', label: 'Install with npm', text: `npm install --global @muneris/sts-cli@${release.version}` },
      { type: 'link', label: 'View on npm', url: 'https://www.npmjs.com/package/@muneris/sts-cli' },
    ],
    sourceCommit: release.sourceCommit,
    source: `https://github.com/mbundgaard/sts-cli/tree/${release.sourceCommit}`,
  }, null, 2) + '\n');
  for (const [name, text] of contents) await writeFile(path.join(output, name), text);
  if (screenshots.length) await mkdir(path.join(output, 'screenshots'));
  for (const [name, file] of screenshots) await copyFile(file, path.join(output, 'screenshots', name));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [output, metadata] = process.argv.slice(2);
  if (!output || !metadata) throw new Error('Usage: node scripts/export-catalog.mjs <new-output-directory> <release-metadata.json>');
  await exportCatalog(sourceRoot, output, JSON.parse(await readFile(metadata, 'utf8')));
  console.log('Exported allowlisted public catalog content. No private reference/runtime files were copied.');
}
