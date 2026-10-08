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
  const allow = new Set(['README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'package.json', 'bin/sts.js', 'docs/CLI.md', 'docs/AUTHENTICATION.md', 'docs/DEVELOPMENT.md', 'docs/RESPONSES.md']);
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
  const apiHelp = execute(['menu', 'get', '--help']);
  assert.equal(apiHelp.status, 0); assert.match(apiHelp.stdout, /16 KiB/); assert.match(apiHelp.stdout, /500 lines/);
  const delivery = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import http from 'node:http';
     import { main } from ${JSON.stringify(installedModule('cli.js'))};
     import { StateStore } from ${JSON.stringify(installedModule('state.js'))};
     const server = http.createServer((req,res) => { req.resume(); res.end(Buffer.alloc(20000,120)); });
     await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
     try {
       const store = new StateStore(${JSON.stringify(path.join(temp, 'delivery-state'))});
       await store.save({auth:{clientId:Buffer.from('synthetic.11111111-1111-4111-8111-111111111111').toString('base64'),stsUrl:'http://127.0.0.1:'+server.address().port,authUrl:'http://127.0.0.1:'+server.address().port},
         tokens:{accessToken:'synthetic-access',refreshToken:'synthetic-refresh',codeVerifier:'a'.repeat(43),obtainedAt:new Date().toISOString(),expiresIn:3600}});
       process.exitCode = await main(['node','sts','menu','get','--location','synthetic','--rvc','1','--quiet'],store);
     } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }`
  ], { encoding: 'utf8', timeout: 30000 });
  assert.equal(delivery.status, 0, delivery.stderr);
  const receipt = JSON.parse(delivery.stdout);
  assert.equal(receipt.delivery, 'file'); assert.equal(receipt.bytes, 20000);
  assert.ok(receipt.path.startsWith(path.join(temp, 'delivery-state') + path.sep));
  assert.deepEqual(readFileSync(receipt.path), Buffer.alloc(20000, 120));
  const notice = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { notifyForUpdates } from ${JSON.stringify(installedModule('updates.js'))};
     const directory = ${JSON.stringify(path.join(temp, 'update-state'))};
     let calls = 0;
     const check = async () => { calls++; return { updateAvailable: true, latestVersion: '99.0.0' }; };
     await notifyForUpdates(directory, ${JSON.stringify(pkg.version)}, check);
     await notifyForUpdates(directory, ${JSON.stringify(pkg.version)}, check);
     if (calls !== 1) throw Error('Expected one daily lookup');`
  ], { encoding: 'utf8', timeout: 10000 });
  assert.equal(notice.status, 0, notice.stderr); assert.equal(notice.stdout, '');
  assert.match(notice.stderr, /99\.0\.0 is available/);
  const failure = execute(['unknown-command']);
  assert.equal(failure.status, 6); assert.equal(failure.stdout, '');
  console.log(`Package ${packed.filename}: ${packed.files.length} allowlisted files, installed sts shim/version/state/feedback preview/automatic file delivery/daily update notice/exit code verified.`);
} finally { rmSync(temp, { recursive: true, force: true }); }
