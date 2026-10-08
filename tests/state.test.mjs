import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../dist/state.js';
import { clientIdFor } from './fixtures.mjs';

test('default state uses the OS user application-data directory', () => {
  const expected = process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming', 'StsCli')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'StsCli')
      : path.join(os.homedir(), '.config', 'StsCli');
  assert.equal(new StateStore().directory, expected);
});

async function storeFor(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sts-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return new StateStore(dir);
}
test('failed rename preserves complete rotated-token recovery and old state', async t => {
  const store = await storeFor(t);
  const old = { auth: { orgName: 'synthetic', clientId: clientIdFor('synthetic') }, tokens: { refreshToken: 'old-synthetic-token' } };
  const rotated = { ...old, tokens: { refreshToken: 'rotated-synthetic-token' } };
  await store.save(old);
  t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('synthetic rename denied'), { code: 'EACCES' }); });
  syncBuiltinESMExports();
  let error;
  try { await store.mutate(async state => { state.tokens = rotated.tokens; }); }
  catch (e) { error = e; }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(error?.exitCode, 12);
  assert.deepEqual(await store.load(), old);
  const names = await fs.readdir(store.directory);
  const recovery = names.filter(n => n.endsWith('.tmp'));
  assert.equal(recovery.length, 1);
  assert.ok(!names.some(n => n.endsWith('.lock')));
  const file = path.join(store.directory, recovery[0]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).pending, rotated);
  assert.match(error.hint, /do not retry login\/refresh/);
  assert.ok(error.hint.includes(file));
  assert.ok(!error.message.includes(rotated.tokens.refreshToken));
  assert.ok(!error.hint.includes(rotated.tokens.refreshToken));
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  // Restoring a complete recovery copy uses the normal locked persistence path.
  await store.mutateCompanies(async registry => Object.assign(registry, JSON.parse(await fs.readFile(file, 'utf8'))));
  assert.deepEqual(await store.load(), rotated);
  await fs.unlink(file);
  assert.deepEqual(await fs.readdir(store.directory), ['StsCli.json']);
});
for (const failure of ['writeFile', 'sync']) test(`failed ${failure} cleans incomplete replacement without suggesting recovery`, async t => {
  const store = await storeFor(t);
  const old = { auth: { orgName: 'synthetic', clientId: clientIdFor('synthetic') } };
  await store.save(old);
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const write = handle.writeFile.bind(handle);
    t.mock.method(handle, failure, async data => {
      if (failure === 'writeFile') await write(data.slice(0, 10));
      throw new Error(`synthetic ${failure} failure`);
    });
    return handle;
  });
  syncBuiltinESMExports();
  let error;
  try { await store.save({ ...old, tokens: { refreshToken: 'synthetic' } }); }
  catch (e) { error = e; }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(error?.exitCode, 12);
  assert.match(error.hint, /No complete replacement/);
  assert.deepEqual(await store.load(), old);
  assert.deepEqual(await fs.readdir(store.directory), ['StsCli.json']);
});
