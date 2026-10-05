import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { StateStore } from '../dist/state.js';
import { pkce } from '../dist/auth.js';
import { createHash } from 'node:crypto';

const launcher = path.resolve('bin/sts.js');
async function setup(t, handler) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sts-ts-test-'));
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const store = new StateStore(directory);
  await store.save({ auth: { orgName: 'test-org', authUrl: base, stsUrl: base, clientId: 'test-client==', username: 'test-user' },
    tokens: { accessToken: 'test-access', refreshToken: 'test-refresh', codeVerifier: 'test-verifier', obtainedAt: new Date().toISOString(), expiresIn: 3600 } });
  return { directory, store, base, run: (args, stdin = '') => run(directory, args, stdin) };
}
function run(directory, args, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, ...args], { env: { ...process.env, STS_HOME: directory, STS_PASSWORD: '' }, stdio: 'pipe' });
    const out = [], err = [];
    child.stdout.on('data', c => out.push(c)); child.stderr.on('data', c => err.push(c));
    child.on('error', reject); child.on('close', code => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
    child.stdin.end(stdin);
  });
}
for (const [status, body] of [[200, Buffer.from('{ "unknown" : [1,2], "number":9007199254740993 }\r\n')], [400, Buffer.from('<html>error</html>')], [401, Buffer.from('unauthorized')], [204, Buffer.alloc(0)], [200, Buffer.from([0,255,1,128,13,10])]]) {
  test(`raw response unchanged (status ${status}, ${body.length} bytes)`, async t => {
    const s = await setup(t, (req, res) => { assert.equal(req.headers.authorization, 'Bearer test-access'); assert.equal(req.headers.accept, 'application/json'); res.writeHead(status); res.end(body); });
    const result = await s.run(['tender','list','--location','test-loc','--rvc','1']);
    assert.deepEqual(result.stdout, body); assert.equal(result.code, status === 401 ? 9 : status >= 400 ? 11 : 0);
    assert.match(result.stderr, new RegExp(`HTTP ${status}`));
  });
}
test('gzip body is decoded without parsing or adding newline', async t => {
  const body = Buffer.from('{ "test":1}');
  const s = await setup(t, (_, res) => { res.writeHead(200, { 'Content-Encoding': 'gzip' }); res.end(gzipSync(body)); });
  assert.deepEqual((await s.run(['tender','list','--location','test-loc','--rvc','1'])).stdout, body);
});
test('redirect is returned and never followed', async t => {
  let calls = 0;
  const s = await setup(t, (_, res) => { calls++; res.writeHead(302, { Location: '/elsewhere' }); res.end('redirect'); });
  const result = await s.run(['location','get','--location','test-loc']);
  assert.equal(calls, 1); assert.equal(result.code, 11); assert.equal(result.stdout.toString(), 'redirect');
});
test('add round owns addressing, employee and idempotency but preserves arbitrary JSON', async t => {
  let received;
  const s = await setup(t, async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    received = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) };
    res.end('{ "okFromOracle":true }');
  });
  const body = { header: { checkRef: 'wrong', locRef: 'wrong', checkEmployeeRef: 99, guestCount: 2 },
    tenders: [{ tenderId: 123, total: 50 }], extensions: [{ custom: true }] };
  const result = await s.run(['check','add','test-ref','--loc','test-loc','--rvc','1','--employee','3','--order-type','5','--body','-', '--charged-tip','10','--idempotency-id','11111111-1111-1111-1111-111111111111'], JSON.stringify(body));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(received.url, '/api/v1/checks/test-ref/round');
  assert.equal(received.headers['simphony-features'], 'detect-duplicate-request');
  assert.equal(received.headers['simphony-locref'], 'test-loc');
  assert.equal(received.body.header.checkEmployeeRef, 3);
  assert.equal(received.body.header.checkRef, 'test-ref');
  assert.equal(received.body.header.guestCount, 2);
  assert.equal(received.body.header.idempotencyId, '1'.repeat(32));
  assert.equal(received.body.tenders[0].total, 50);
  assert.equal(received.body.tenders[0].chargedTipTotal, 10);
  assert.deepEqual(received.body.extensions, body.extensions);
});
test('dry-run constructs a request without tokens or network', async t => {
  let calls = 0;
  const s = await setup(t, (_, res) => { calls++; res.end(); });
  const state = await s.store.load(); delete state.tokens; await s.store.save(state);
  const result = await s.run(['check','new','--location','test-loc','--rvc','1','--employee','3','--order-type','1','--body','{"tenders":[{"tenderId":123,"total":0}]}','--dry-run']);
  assert.equal(result.code, 0, result.stderr); assert.equal(calls, 0);
  assert.equal(JSON.parse(result.stdout).data.headers.Authorization, undefined);
});
test('refresh persists rotation and never outputs tokens', async t => {
  const s = await setup(t, async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('client_id'), 'test-client==');
    assert.equal(form.get('code_verifier'), 'test-verifier');
    res.end(JSON.stringify({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 }));
  });
  const result = await s.run(['auth','refresh']);
  assert.equal(result.code, 0, result.stderr);
  const tokens = (await s.store.load()).tokens;
  assert.equal(tokens.refreshToken, 'rotated-refresh'); assert.equal(tokens.accessToken, 'rotated-access');
  assert.ok(!result.stdout.toString().includes('rotated-access'));
});
test('login uses cookies, PKCE and preserves padded client ID', async t => {
  let challenge;
  const s = await setup(t, async (req, res) => {
    const url = new URL(req.url, 'http://test');
    if (url.pathname.endsWith('/authorize')) {
      assert.equal(url.searchParams.get('client_id'), 'test-client==');
      challenge = url.searchParams.get('code_challenge');
      res.setHeader('Set-Cookie', 'session=test-session; Path=/'); res.end('login'); return;
    }
    const chunks = []; for await (const c of req) chunks.push(c);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    if (url.pathname.endsWith('/signin')) {
      assert.match(req.headers.cookie, /session=test-session/); assert.match(req.headers.cookie, /client_id=test-client%3D%3D/);
      assert.equal(form.get('password'), 'mock-password');
      res.end(JSON.stringify({ nextOp: 'redirect', redirectUrl: 'apiaccount://callback?code=mock-code' })); return;
    }
    assert.equal(form.get('code'), 'mock-code');
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), challenge);
    res.end(JSON.stringify({ access_token: 'login-access', refresh_token: 'login-refresh', expires_in: 3600 }));
  });
  const result = await s.run(['auth','login','--password','mock-password']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await s.store.load()).tokens.refreshToken, 'login-refresh');
});
test('state mutations are locked and failed actions leave state intact', async t => {
  const s = await setup(t, (_, res) => res.end());
  const before = await readFile(s.store.file);
  await assert.rejects(s.store.mutate(async () => { await s.store.mutate(async () => {}); }), /lock/i);
  assert.deepEqual(await readFile(s.store.file), before);
  await s.store.mutate(async state => { state.auth.username = 'changed'; });
  assert.equal((await s.store.load()).auth.username, 'changed');
  if (process.platform !== 'win32') assert.equal((await stat(s.store.file)).mode & 0o777, 0o600);
});
test('corrupt state is not silently discarded', async t => {
  const s = await setup(t, (_, res) => res.end()); await writeFile(s.store.file, '{broken');
  const result = await s.run(['auth','status']); assert.equal(result.code, 12); assert.equal(result.stdout.length, 0);
  assert.equal(await readFile(s.store.file, 'utf8'), '{broken');
});
test('restore legacy-shaped state, refuse overwrite and allow force', async t => {
  const s = await setup(t, (_, res) => res.end());
  const file = path.join(s.directory, 'legacy.json');
  await writeFile(file, '\uFEFF' + JSON.stringify({ auth: { clientId: 'restored==' }, tokens: { accessToken: 'saved' }, debugLog: false }));
  assert.equal((await s.run(['auth','restore','--file',file])).code, 12);
  assert.equal((await s.run(['auth','restore','--file',file,'--force'])).code, 0);
  assert.equal((await s.store.load()).auth.clientId, 'restored==');
});
test('validation and local errors produce no API stdout or network', async t => {
  let calls = 0;
  const s = await setup(t, (_, res) => { calls++; res.end(); });
  for (const args of [ ['tender','list','--rvc','1'], ['check','new','--location','test-loc','--rvc','1','--employee','3','--order-type','1','--body','[]'], ['tender','list','--location','test-loc','--rvc','NaN'], ['unknown-command'] ]) {
    const result = await s.run(args); assert.equal(result.code, 6); assert.equal(result.stdout.length, 0);
  }
  assert.equal(calls, 0);
});
test('HEAD reports connection header on stderr only', async t => {
  const s = await setup(t, (req, res) => { assert.equal(req.method, 'HEAD'); res.setHeader('Simphony-POS-Connected', 'true'); res.end(); });
  const result = await s.run(['connection','status','--location','test-loc','--rvc','1']);
  assert.equal(result.code, 0); assert.equal(result.stdout.length, 0); assert.match(result.stderr, /Simphony-POS-Connected: true/);
});
test('timeout never retries a write', async t => {
  let calls = 0;
  const s = await setup(t, () => { calls++; });
  const result = await s.run(['check','new','--location','test-loc','--rvc','1','--employee','3','--order-type','1','--body','{}','--timeout','1']);
  assert.equal(result.code, 10); assert.equal(calls, 1); assert.equal(result.stdout.length, 0); assert.match(result.stderr, /uncertain/);
});
test('refresh without a new refresh token retains the old token; rejection preserves state', async t => {
  let fail = false;
  const s = await setup(t, (_, res) => {
    if (fail) { res.writeHead(401); res.end('rejected'); }
    else res.end(JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 }));
  });
  assert.equal((await s.run(['auth','refresh'])).code, 0);
  assert.equal((await s.store.load()).tokens.refreshToken, 'test-refresh');
  const before = await readFile(s.store.file);
  fail = true;
  const result = await s.run(['auth','refresh']);
  assert.equal(result.code, 9); assert.equal(result.stdout.length, 0);
  assert.deepEqual(await readFile(s.store.file), before);
});
test('configuration changes clear tokens and the CLI version matches package metadata', async t => {
  const s = await setup(t, (_, res) => res.end());
  assert.equal((await s.run(['auth','config','--username','new-user'])).code, 0);
  assert.equal((await s.store.load()).tokens, undefined);
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const result = await s.run(['version']);
  assert.equal(JSON.parse(result.stdout).data.version, pkg.version);
  const help = await s.run([]); assert.equal(help.code, 0); assert.match(help.stdout.toString(), /Usage: sts/);
});
test('interrupted HTTP response does not print partial bytes', async t => {
  const s = await setup(t, (_, res) => {
    res.writeHead(200, { 'Content-Length': '1000' }); res.write('partial');
    setTimeout(() => res.destroy(), 10);
  });
  const result = await s.run(['location','get','--location','test-loc']);
  assert.equal(result.code, 10); assert.equal(result.stdout.length, 0);
});
test('PKCE verifier and SHA256 challenge', () => {
  const value = pkce(); assert.equal(value.verifier.length, 43);
  assert.equal(createHash('sha256').update(value.verifier).digest('base64url'), value.challenge);
});
