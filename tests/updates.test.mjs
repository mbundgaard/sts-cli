import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkForUpdates, updateRegistryUrl } from '../dist/updates.js';
import { createProgram } from '../dist/cli.js';
import { StateStore } from '../dist/state.js';

const response = (version, extra = {}) => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ name: '@muneris/sts-cli', version, ...extra })) });
for (const [installed, latest, expected] of [
  ['0.3.0','0.3.0','up-to-date'], ['0.3.0','0.3.1','update-available'], ['0.9.0','0.10.0','update-available'],
  ['0.10.0','0.9.0','ahead'], ['1.0.0','2.0.0','update-available'], ['2.0.0','1.99.99','ahead'],
  ['1.0.0-beta.2','1.0.0-beta.10','update-available'], ['1.0.0-alpha','1.0.0-alpha.1','update-available'],
  ['1.0.0-alpha.1','1.0.0-alpha','ahead'], ['1.0.0-1','1.0.0-alpha','update-available'],
  ['1.0.0-beta','1.0.0-alpha','ahead'], ['1.0.0-rc.1','1.0.0','update-available'],
  ['1.0.0','1.0.0-rc.1','ahead'], ['1.0.0+local','1.0.0+registry','up-to-date'],
]) test(`version precedence ${installed} / ${latest}: ${expected}`, async () => {
  let calls = 0;
  const result = await checkForUpdates(installed, async req => {
    calls++; assert.equal(req.url, updateRegistryUrl); assert.equal(req.method, 'GET');
    assert.deepEqual(req.headers, { Accept: 'application/json' }); assert.equal(req.body, undefined);
    assert.equal(req.timeoutMs, 5000); assert.notEqual(req.insecure, true);
    return response(latest, { updateCommand: 'do-not-trust-registry-command-text' });
  });
  assert.equal(calls, 1); assert.equal(result.checkStatus, expected); assert.equal(result.latestVersion, latest);
  assert.equal(result.updateAvailable, expected === 'update-available');
  assert.equal(result.updateCommand, expected === 'update-available' ? `npm install --global @muneris/sts-cli@${latest}` : undefined);
});
test('registry failures, redirects and invalid metadata are advisory and never called current', async () => {
  const fixtures = [
    { ...response('1.0.0'), status: 503 }, { ...response('1.0.0'), status: 302 },
    { ...response('1.0.0'), body: Buffer.from('private-unreviewed-server-error') },
    { ...response('1.0.0'), body: Buffer.from('null') },
    response('1.0.0', { name: 'different-package' }), response('1.0.0; malicious-command'),
    response('01.0.0'), response('1.0.0-01'), response('1.2'), response(123), response('x'.repeat(300)),
  ];
  for (const fixture of fixtures) {
    let calls = 0;
    const result = await checkForUpdates('0.3.0', async () => { calls++; return fixture; });
    assert.equal(calls, 1); assert.equal(result.checkStatus, 'unavailable'); assert.equal(result.updateAvailable, null);
    assert.equal(result.updateCommand, undefined); assert.equal(result.latestVersion, undefined);
    assert.doesNotMatch(JSON.stringify(result), /malicious-command|private-unreviewed/);
  }
  let calls = 0;
  const result = await checkForUpdates('0.3.0', async () => { calls++; throw new Error('synthetic timeout'); });
  assert.equal(calls, 1); assert.equal(result.checkStatus, 'unavailable');
});
test('version --check is explicit, independent of auth, and unavailable does not fail the command', async t => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const store = new StateStore('nonexistent-version-test-state');
  let calls = 0, stdout = '', exitCode = 0;
  const mock = t.mock.method(process.stdout, 'write', chunk => { stdout += chunk.toString(); return true; });
  const run = async args => {
    stdout = '';
    try { await createProgram(store, code => { exitCode = code; }, async installed => {
      calls++; assert.equal(installed, pkg.version);
      return checkForUpdates(installed, async () => { throw new Error('offline'); });
    }).parseAsync(['node','sts',...args]); }
    catch (e) { if (e.exitCode !== 0) throw e; }
    return stdout;
  };
  try {
    assert.equal(JSON.parse(await run(['version'])).data.version, pkg.version); assert.equal(calls, 0);
    assert.equal((await run(['--version'])).trim(), pkg.version); assert.equal(calls, 0);
    const checked = JSON.parse(await run(['version','--check']));
    assert.equal(checked.data.update.checkStatus, 'unavailable'); assert.equal(exitCode, 0); assert.equal(calls, 1);
    const help = (await run(['version','--help'])).replace(/\s+/g, ' ');
    assert.match(help, /--check/); assert.match(help, /support@muneris\.dk/); assert.equal(calls, 1);
  } finally { mock.mock.restore(); }
});
