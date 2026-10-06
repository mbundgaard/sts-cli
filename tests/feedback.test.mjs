import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { FeedbackStore, feedbackUrl } from '../dist/feedback.js';
import { StateStore } from '../dist/state.js';

async function setup(t, handler = (_, res) => { res.writeHead(204); res.end(); }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sts-feedback-'));
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const file = path.join(directory, 'feedback', 'Feedback.json');
  const store = new FeedbackStore(directory, 'test-version', { STS_FEEDBACK_URL: url });
  const run = (args, env = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/sts.js', ...args], { env: { ...process.env, STS_HOME: directory, STS_FEEDBACK_URL: url, STS_PASSWORD: 'synthetic-password-never-send', ...env }, stdio: 'pipe', timeout: 10000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end();
  });
  return { directory, url, file, store, run, load: async () => JSON.parse(await fs.readFile(file, 'utf8')) };
}
const resultData = r => { assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout).data; };

test('feedback is opt-in, local status provides consent and bug-report guidance without state creation', async t => {
  let calls = 0;
  const s = await setup(t, (_, res) => { calls++; res.end(); });
  const status = resultData(await s.run(['feedback','status']));
  assert.equal(status.remindersEnabled, false); assert.equal(status.feedbackDue, false);
  assert.match(status.agentGuidance.join(' '), /likely CLI bug or recurring agent confusion/);
  assert.match(status.agentGuidance.join(' '), /get approval before sending/);
  assert.equal(calls, 0);
  await assert.rejects(fs.stat(s.file), { code: 'ENOENT' });
  resultData(await s.run(['feedback','submit','--rating','4','--dry-run']));
  await assert.rejects(fs.stat(s.file), { code: 'ENOENT' });
  assert.equal(calls, 0);
});
test('submission sends product metadata and UTF-8 only, never credentials or reminder data; duplicate protected', async t => {
  const requests = [];
  const s = await setup(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(204); res.end();
  });
  const auth = new StateStore(s.directory);
  await auth.save({ auth: { orgName: 'private-org', username: 'private-user' }, tokens: { accessToken: 'private-access', refreshToken: 'private-refresh' } });
  const original = await fs.readFile(auth.file, 'utf8');
  const args = ['feedback','submit','--message','Useful CLI: æøå 🙂','--rating','5','--category','general'];
  const first = await s.run(args); const data = resultData(first);
  assert.equal(data.submitted, true); assert.match(first.stderr, /Submitting/); assert.match(first.stderr, /Submitted successfully/);
  const req = requests[0]; const p = JSON.parse(req.body);
  assert.equal(req.method, 'POST'); assert.equal(req.url, '/');
  assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
  assert.equal(req.headers['simphony-orgshortname'], undefined);
  assert.match(req.headers['content-type'], /^application\/json; charset=utf-8$/);
  assert.deepEqual(Object.keys(p).sort(), ['schemaVersion','product','productVersion','category','message','rating','submittedAtUtc','submissionId'].sort());
  assert.equal(p.product, '@muneris/sts-cli'); assert.equal(p.schemaVersion, 1); assert.equal(p.rating, 5); assert.equal(p.message, 'Useful CLI: æøå 🙂');
  assert.ok(Number.isFinite(Date.parse(p.submittedAtUtc))); assert.equal(p.submissionId, data.submissionId);
  assert.doesNotMatch(req.body, /private-|synthetic-password|successfulRequests/);
  assert.equal(await fs.readFile(auth.file, 'utf8'), original);
  const duplicate = resultData(await s.run(args)); assert.equal(duplicate.alreadySubmitted, true); assert.equal(duplicate.submissionId, data.submissionId);
  resultData(await s.run(['feedback','retry', data.submissionId]));
  assert.equal(requests.length, 1);
  resultData(await s.run([...args, '--new'])); assert.equal(requests.length, 2);
  const show = resultData(await s.run(['feedback','show',data.submissionId])); assert.equal(show.payload.message, p.message);
  const discard = resultData(await s.run(['feedback','discard',data.submissionId])); assert.equal(discard.deletedFromService, false);
});
for (const status of [200, 400, 413, 503, 302]) test(`feedback HTTP ${status} is not success; retains content without retry or raw error echo`, async t => {
  let calls = 0;
  const s = await setup(t, (_, res) => { calls++; res.writeHead(status, { Location: '/elsewhere' }); res.end('unreviewed-server-response'); });
  const r = await s.run(['feedback','submit','--message','Approved report','--category','bug']);
  assert.equal(r.code, 11); assert.equal(r.stdout, ''); assert.match(r.stderr, new RegExp(`HTTP ${status}`));
  assert.doesNotMatch(r.stderr, /unreviewed-server-response/);
  const record = (await s.load()).submissions[0];
  assert.equal(record.status, 'failed'); assert.equal(record.lastHttpStatus, status); assert.equal(record.payload.message, 'Approved report');
  assert.ok(r.stderr.includes(record.payload.submissionId));
  const duplicate = await s.run(['feedback','submit','--message','Approved report','--category','bug']);
  assert.equal(duplicate.code, 12); assert.equal(calls, 1);
});
test('timeout preserves payload; explicit retry reuses bytes and original destination, never changes ID', async t => {
  const bodies = []; let respond = false;
  const s = await setup(t, async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    bodies.push(Buffer.concat(chunks).toString());
    if (respond) { res.writeHead(204); res.end(); }
  });
  const r = await s.run(['feedback','submit','--message','Keep this feedback','--timeout','1']);
  assert.equal(r.code, 10); assert.match(r.stderr, /delivery is uncertain/); assert.equal(bodies.length, 1);
  const record = (await s.load()).submissions[0];
  assert.equal(record.status, 'failed');
  respond = true;
  const retried = resultData(await s.run(['feedback','retry',record.payload.submissionId], { STS_FEEDBACK_URL: 'https://unused.example.invalid/' }));
  assert.equal(retried.submissionId, record.payload.submissionId); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.equal((await s.load()).submissions[0].attempts, 2);
});
test('concurrent submissions are locked and the second cannot POST', async t => {
  let release, arrived;
  const arrival = new Promise(resolve => { arrived = resolve; });
  const s = await setup(t, (_, res) => { release = () => { res.writeHead(204); res.end(); }; arrived(); });
  const first = s.run(['feedback','submit','--message','Same report']);
  await arrival;
  const second = await s.run(['feedback','submit','--message','Same report']);
  assert.equal(second.code, 12); assert.match(second.stderr, /busy or unavailable/);
  release(); resultData(await first);
  assert.equal((await s.load()).submissions.length, 1);
});
test('invalid input and both size ceilings reject locally without network', async t => {
  let calls = 0;
  const s = await setup(t, (_, res) => { calls++; res.end(); });
  for (const args of [[], ['--message',' '], ['--rating','0'], ['--rating','6'], ['--rating','1.5'], ['--message','x','--category','other'], ['--message','x','--timeout','0'], ['--message','x','--timeout','121']]) {
    const r = await s.run(['feedback','submit',...args]); assert.equal(r.code, 6, r.stderr);
  }
  await assert.rejects(s.store.submit({ message: 'x'.repeat(24000) }), { exitCode: 6 });
  await assert.rejects(s.store.submit({ message: '漢'.repeat(22000) }), { exitCode: 6 });
  assert.equal(calls, 0);
  await assert.rejects(fs.stat(s.file), { code: 'ENOENT' });
});
test('health uses /health without authentication, and does not imply working storage', async t => {
  const s = await setup(t, (req, res) => { assert.equal(req.url, '/health'); assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, undefined); res.end('{"status":"ok"}'); });
  const result = resultData(await s.run(['feedback','health'])); assert.equal(result.status, 'ok'); assert.equal(result.storageVerified, false);
});
test('base URL validation and precedence are explicit; no /api prefix is invented', async t => {
  const s = await setup(t);
  const noEnv = new FeedbackStore(s.directory, 'test', {});
  assert.equal((await noEnv.status()).baseUrl, 'https://feedback.muneris.cloud/');
  await noEnv.configure({ url: 'https://saved.example/base' });
  assert.equal((await noEnv.status()).baseUrl, 'https://saved.example/base/');
  assert.equal((await s.store.status()).baseUrl, s.url);
  const preview = await s.store.submit({ rating: 3, url: 'https://override.example/route', dryRun: true });
  assert.equal(preview.baseUrl, 'https://override.example/route/');
  for (const url of ['http://remote.example', 'https://user:pass@example.com', 'https://example.com?', 'https://example.com#', ' https://example.com']) assert.throws(() => feedbackUrl(url), { exitCode: 6 });
});
test('opt-in reminder thresholds, cooldown, snooze and disabling only affect local state', async t => {
  const s = await setup(t);
  const start = new Date('2026-01-01T12:00:00Z');
  const later = days => new Date(start.getTime() + days * 86400000);
  await s.store.configure({ reminders: 'on' }, start);
  for (let i = 0; i < 24; i++) assert.equal(await s.store.recordSuccess(false, start), false);
  assert.equal((await s.store.status(start)).feedbackDue, false);
  await s.store.recordSuccess(false, start);
  assert.equal((await s.store.status(start)).feedbackDue, true);
  assert.equal(await s.store.recordSuccess(true, start), true);
  assert.equal(await s.store.recordSuccess(true, start), false);
  assert.equal((await s.store.status(later(29))).feedbackDue, false);
  assert.equal((await s.store.status(later(30))).feedbackDue, true);
  await s.store.asked(60, later(30));
  assert.equal((await s.store.status(later(89))).feedbackDue, false);
  assert.equal((await s.store.status(later(90))).feedbackDue, true);
  await s.store.configure({ reminders: 'off' }, later(90));
  const before = await fs.readFile(s.file, 'utf8');
  assert.equal(await s.store.recordSuccess(true, later(100)), false);
  assert.equal((await s.store.status(later(100))).feedbackDue, false);
  assert.equal(await fs.readFile(s.file, 'utf8'), before);
  await s.store.configure({ reminders: 'on' }, later(40));
  assert.equal((await s.store.status(later(47))).feedbackDue, false); // Re-enable does not undo snooze.
  const fresh = await setup(t);
  await fresh.store.configure({ reminders: 'on' }, start);
  assert.equal((await fresh.store.status(later(6))).feedbackDue, false);
  assert.equal((await fresh.store.status(later(7))).feedbackDue, true);
});
test('CLI STS success counts locally without changing raw bytes or prompting in pipes; dry-run/errors do not count', async t => {
  const body = '{ "number":9007199254740993 }\r\n'; let status = 200;
  const s = await setup(t, (_, res) => { res.writeHead(status); res.end(body); });
  await new StateStore(s.directory).save({ auth: { orgName: 'synthetic', stsUrl: s.url }, tokens: { accessToken: 'synthetic-access' } });
  await s.store.configure({ reminders: 'on' }, new Date('2020-01-01T00:00:00Z'));
  const args = ['tender','list','--location','test-loc','--rvc','1'];
  const r = await s.run(args); assert.equal(r.code, 0); assert.equal(r.stdout, body); assert.doesNotMatch(r.stderr, /Would you like/);
  assert.equal((await s.store.status()).successfulRequests, 1);
  resultData(await s.run([...args,'--dry-run']));
  status = 400; assert.equal((await s.run(args)).code, 11);
  assert.equal((await s.store.status()).successfulRequests, 1);
  await fs.writeFile(s.file, '{broken');
  status = 200; const unaffected = await s.run(args);
  assert.equal(unaffected.code, 0); assert.equal(unaffected.stdout, body); assert.match(unaffected.stderr, /STS result unaffected/);
  assert.equal(await fs.readFile(s.file, 'utf8'), '{broken');
});
test('corrupt feedback state fails closed, never resets or posts', async t => {
  let calls = 0;
  const s = await setup(t, (_, res) => { calls++; res.end(); });
  await s.store.configure({ reminders: 'on' });
  await fs.writeFile(s.file, '{broken-private-text');
  const r = await s.run(['feedback','submit','--rating','5']); assert.equal(r.code, 12);
  assert.doesNotMatch(r.stderr, /broken-private-text/); assert.equal(calls, 0);
  assert.equal(await fs.readFile(s.file, 'utf8'), '{broken-private-text');
});
test('a successful POST followed by failed persistence retains a recovery copy and uncertain saved intent', async t => {
  let calls = 0;
  const s = await setup(t, (_, res) => {
    calls++;
    t.mock.method(fs, 'rename', async () => { throw new Error('synthetic rename failure'); }); syncBuiltinESMExports();
    res.writeHead(204); res.end();
  });
  try { await assert.rejects(s.store.submit({ message: 'Retain outcome', quiet: true }), { exitCode: 12 }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(calls, 1);
  const record = (await s.load()).submissions[0]; assert.equal(record.status, 'sending');
  const files = await fs.readdir(path.dirname(s.file)); const temp = files.find(x => x.endsWith('.tmp'));
  assert.ok(temp); assert.ok(!files.some(x => x.endsWith('.lock')));
  const recovered = JSON.parse(await fs.readFile(path.join(path.dirname(s.file), temp), 'utf8'));
  assert.equal(recovered.submissions[0].status, 'sent');
  await assert.rejects(s.store.submit({ message: 'Retain outcome', quiet: true }), { exitCode: 12 }); assert.equal(calls, 1);
});
