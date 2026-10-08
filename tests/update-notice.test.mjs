import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { notifyForUpdates, checkForUpdates } from '../dist/updates.js';
import { main } from '../dist/cli.js';
import { setup, tokens } from './response-helpers.mjs';
async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sts-notice-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
const newer = { updateAvailable: true, latestVersion: '99.0.0' };
test('daily notice persists reservation, limits concurrent callers and emits only a version hint', async t => {
  const dir = await directory(t); const now = Date.now(); let checks = 0, output = '';
  const check = async () => { checks++; return newer; };
  const emit = text => { output += text; };
  await Promise.all(Array.from({ length: 8 }, () => notifyForUpdates(dir, '0.5.0', check, emit, now)));
  assert.equal(checks, 1); assert.match(output, /99.0.0.*installed 0.5.0/); assert.match(output, /sts version --check/);
  await notifyForUpdates(dir, '0.5.0', check, emit, now + 86400000 - 1); assert.equal(checks, 1);
  await notifyForUpdates(dir, '0.5.0', check, emit, now + 86400000); assert.equal(checks, 2);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'update-notice.json'), 'utf8')), { schemaVersion: 1, nextCheckAt: now + 2 * 86400000 });
});
test('unavailable checks remain silent and are not retried until the next day', async t => {
  const dir = await directory(t); let calls = 0;
  const fail = async () => { calls++; throw Error('offline'); };
  const emit = () => assert.fail('unexpected notice');
  const now = Date.now();
  await notifyForUpdates(dir, '0.5.0', fail, emit, now);
  await notifyForUpdates(dir, '0.5.0', fail, emit, now + 1);
  assert.equal(calls, 1);
});
test('current, ahead and unknown registry versions never produce a notice', async t => {
  for (const updateAvailable of [false, null]) {
    await notifyForUpdates(await directory(t), '0.5.0', async () => ({ updateAvailable }), () => assert.fail('unexpected notice'));
  }
});
test('corrupt cache, lock contention and filesystem failure skip optional networking without overwriting state', async t => {
  const dir = await directory(t), file = path.join(dir, 'update-notice.json');
  await writeFile(file, '{broken');
  await notifyForUpdates(dir, '0.5.0', () => assert.fail('unexpected network'));
  assert.equal(await readFile(file, 'utf8'), '{broken');
  await rm(file); await writeFile(file + '.lock', 'another process');
  await notifyForUpdates(dir, '0.5.0', () => assert.fail('unexpected network'));
  assert.equal(await readFile(file + '.lock', 'utf8'), 'another process');
  await notifyForUpdates(file + '.lock', '0.5.0', () => assert.fail('unexpected network'));
});
test('automatic registry lookup can use a one-second timeout without sending STS headers', async () => {
  await checkForUpdates('0.5.0', async req => {
    assert.equal(req.timeoutMs, 1000); assert.deepEqual(req.headers, { Accept: 'application/json' });
    assert.equal(req.body, undefined);
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ name: '@muneris/sts-cli', version: '99.0.0' })) };
  }, 1000);
});
test('CLI notifies only after successful non-quiet STS delivery; failures never alter the result', async t => {
  let httpStatus = 200;
  const s = await setup(t, (_, res) => { res.writeHead(httpStatus); res.end('EXACT\r\n'); });
  await s.store.mutate(async state => { state.tokens = tokens(); });
  let stdout = '', stderr = '', notices = 0, deliveredBeforeNotice = false;
  t.mock.method(process.stdout, 'write', (chunk, callback) => { stdout += chunk.toString(); if (typeof callback === 'function') callback(); return true; });
  t.mock.method(process.stderr, 'write', chunk => { stderr += chunk.toString(); return true; });
  const notify = async () => { notices++; deliveredBeforeNotice = stdout === 'EXACT\r\n'; throw Error('advisory failure'); };
  const run = async args => { stdout = ''; stderr = ''; return main(['node', 'sts', ...args], s.store, notify); };
  const args = ['tender', 'list', '--location', 'synthetic', '--rvc', '1'];
  assert.equal(await run(args), 0); assert.equal(stdout, 'EXACT\r\n'); assert.equal(notices, 1); assert.equal(deliveredBeforeNotice, true);
  assert.equal(await run([...args, '--quiet']), 0); assert.equal(notices, 1);
  httpStatus = 401; assert.equal(await run(args), 9); assert.equal(stdout, 'EXACT\r\n'); assert.equal(notices, 1);
  for (const local of [['--help'], ['version'], ['auth', 'status'], ['company', 'list'], [...args, '--dry-run']]) assert.equal(await run(local), 0);
  assert.equal(notices, 1); assert.doesNotMatch(stderr, /advisory failure/);
});
