import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const temp = mkdtempSync(path.join(tmpdir(), 'sts-package-test-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run via npm run test:package');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
function npmCommand(args) {
  const result = spawnSync(process.execPath, [npm, ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
  return result.stdout;
}
try {
  const [packed] = JSON.parse(npmCommand(['pack', '--ignore-scripts', '--json', '--pack-destination', temp]));
  const allow = new Set(['README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'package.json', 'bin/sts.js', 'docs/CLI.md', 'docs/AUTHENTICATION.md', 'docs/DEVELOPMENT.md']);
  for (const file of packed.files) assert.ok(allow.has(file.path) || /^dist\/[a-z]+\.(?:js|d\.ts)$/.test(file.path), `Unexpected package file: ${file.path}`);
  npmCommand(['install', '--prefix', temp, '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, packed.filename)]);
  const shim = path.join(temp, 'node_modules', '.bin', process.platform === 'win32' ? 'sts.cmd' : 'sts');
  // Exercise npm's actual shim, including its Unix executable-permission handling.
  const execute = args => {
    const options = { encoding: 'utf8' };
    // Arguments here are fixed test literals, never user input.
    return process.platform === 'win32'
      ? spawnSync(`"${shim}" ${args.join(' ')}`, { ...options, shell: true })
      : spawnSync(shim, args, options);
  };
  // Stateful checks use the installed modules with internal dependency injection,
  // never the real user's AppData. There is no production directory override.
  const installedModule = name => pathToFileURL(path.join(temp, 'node_modules', '@muneris', 'sts-cli', 'dist', name)).href;
  const isolated = args => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { main } from ${JSON.stringify(installedModule('cli.js'))};
     import { StateStore } from ${JSON.stringify(installedModule('state.js'))};
     process.exitCode = await main(${JSON.stringify(['node', 'sts', ...args])}, new StateStore(${JSON.stringify(path.join(temp, 'state'))}));`
  ], { encoding: 'utf8' });
  const version = execute(['--version']);
  assert.equal(version.status, 0, version.stderr); assert.equal(version.stdout.trim(), pkg.version);
  const versionHelp = execute(['version', '--help']);
  assert.equal(versionHelp.status, 0, versionHelp.stderr);
  assert.match(versionHelp.stdout, /--check/);
  assert.match(versionHelp.stdout, /support@muneris\.dk/);
  const status = isolated(['auth', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).data.state, 'no-tokens');
  const feedback = isolated(['feedback', 'status']);
  assert.equal(feedback.status, 0, feedback.stderr);
  assert.equal(JSON.parse(feedback.stdout).data.remindersEnabled, true);
  const preview = isolated(['feedback', 'submit', '--rating', '5', '--dry-run']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).data.payload.product, pkg.name);
  const failure = execute(['unknown-command']);
  assert.equal(failure.status, 6); assert.equal(failure.stdout, '');
  console.log(`Package ${packed.filename}: ${packed.files.length} allowlisted files, installed sts shim/version/state/feedback preview/exit code verified.`);
} finally { rmSync(temp, { recursive: true, force: true }); }
