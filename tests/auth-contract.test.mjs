// Equivalent scenarios are kept locally in each CLI. No sibling imports or shared runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { AuthClient } from '../dist/auth.js';
import { StateStore, validateCompanies, validateState, companyKey, DAY } from '../dist/state.js';

const product = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).name.match(/\/(sts|bi|cc)-cli$/)[1];
const primary = product === 'sts' ? 'access_token' : 'id_token';
const savedPrimary = product === 'sts' ? 'accessToken' : 'idToken';
const alternate = product === 'sts' ? 'id_token' : 'access_token';
const clientId = Buffer.from('AuthContract.11111111-1111-4111-8111-111111111111').toString('base64');
const tokenBody = () => ({ [primary]: 'PRIMARY-CONTRACT-SECRET', [alternate]: 'UNUSED-CONTRACT-SECRET', refresh_token: 'REFRESH-CONTRACT-SECRET', expires_in: 86400 });
const oldTokens = () => ({ [savedPrimary]: 'OLD-PRIMARY-CONTRACT-SECRET', refreshToken: 'OLD-REFRESH-CONTRACT-SECRET', codeVerifier: 'a'.repeat(43), obtainedAt: new Date().toISOString(), expiresIn: 86400 });
const profile = auth => ({ ...(product !== 'sts' ? { schemaVersion: 1 } : {}), ...(product === 'cc' ? { product } : {}), auth });
const redirect = { nextOp: 'redirect', success: true, redirectUrl: 'apiaccount://callback?code=CODE-CONTRACT-SECRET' };
function json(res, body, status = 200) { res.writeHead(status, { Location: '/must-not-follow' }); res.end(JSON.stringify(body)); }
async function setup(t, respond) {
  const directory = await mkdtemp(join(tmpdir(), `${product}-auth-contract-`));
  const calls = [], errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const call = { method: req.method, url: new URL(req.url, 'http://localhost'), headers: req.headers, form: new URLSearchParams(Buffer.concat(chunks).toString()) };
      calls.push(call); await respond(call, res);
    } catch (error) { errors.push(error); res.statusCode = 500; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const auth = { authUrl: url, [product === 'sts' ? 'stsUrl' : 'apiUrl']: url, clientId, orgName: 'AuthContract', username: 'Contract_User' };
  const store = new StateStore(directory);
  const run = args => new Promise((resolve, reject) => {
    execFile(process.execPath, [fileURLToPath(new URL('./cli-runner.mjs', import.meta.url)), directory, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { reject(error); return; }
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
  return { auth, store, directory, calls, run, client: new AuthClient(2000, true) };
}
function privateFailure(error, code = 9) {
  assert.equal(error.exitCode, code);
  assert.doesNotMatch(error.message + (error.hint ?? ''), /CONTRACT-SECRET|untrusted\.invalid/);
  return true;
}

for (const status of [200, 302, 303]) for (const cookies of [true, false]) {
  test(`common auth: authorize ${status}, supplied cookies ${cookies}, PKCE and correct primary token`, async t => {
    let challenge;
    const s = await setup(t, (call, res) => {
      const stage = call.url.pathname.split('/').at(-1);
      if (stage === 'authorize') {
        assert.equal(call.method, 'GET'); assert.equal(call.url.searchParams.get('client_id'), clientId);
        challenge = call.url.searchParams.get('code_challenge');
        assert.equal(call.url.searchParams.get('code_challenge_method'), 'S256');
        res.writeHead(status, { Location: '/must-not-follow', 'Set-Cookie': cookies ? [`client_id=${clientId}; Path=/`, 'redirect_uri=apiaccount://callback; Path=/', 'session=COOKIE-CONTRACT-SECRET; Path=/'] : [] });
        res.end(); return;
      }
      assert.equal(call.method, 'POST');
      assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
      if (cookies) {
        assert.ok(call.headers.cookie.includes(`client_id=${clientId}`));
        assert.ok(call.headers.cookie.includes('redirect_uri=apiaccount://callback'));
      } else assert.equal(call.headers.cookie, undefined); // No synthesized OAuth cookies.
      if (stage === 'signin') {
        assert.equal(call.form.get('password'), 'PASSWORD-CONTRACT-SECRET');
        assert.equal(call.form.get('username'), 'Contract_User'); assert.equal(call.form.get('orgname'), 'AuthContract');
        json(res, redirect); return;
      }
      assert.equal(stage, 'token'); assert.equal(call.form.get('grant_type'), 'authorization_code');
      assert.equal(call.form.get('client_id'), clientId); assert.equal(call.form.get('redirect_uri'), 'apiaccount://callback');
      assert.equal(call.form.get('code'), 'CODE-CONTRACT-SECRET');
      assert.equal(createHash('sha256').update(call.form.get('code_verifier')).digest('base64url'), challenge);
      json(res, tokenBody());
    });
    const tokens = await s.client.login(s.auth, 'PASSWORD-CONTRACT-SECRET');
    assert.equal(tokens[savedPrimary], 'PRIMARY-CONTRACT-SECRET');
    assert.equal(tokens[product === 'sts' ? 'idToken' : 'accessToken'], undefined);
    assert.match(tokens.codeVerifier, /^[A-Za-z0-9_-]{43}$/); assert.equal(s.calls.length, 3);
  });
}
for (const value of [
  { ...redirect, success: false },
  { ...redirect, redirectUrl: 'https://untrusted.invalid/?code=CODE-CONTRACT-SECRET' },
  { ...redirect, redirectUrl: 'apiaccount://callback:123?code=CODE-CONTRACT-SECRET' },
  { ...redirect, redirectUrl: 'apiaccount://user:CONTRACT-SECRET@callback?code=code' },
  { ...redirect, redirectUrl: 'apiaccount://callback/other?code=CODE-CONTRACT-SECRET' },
  { ...redirect, redirectUrl: 'apiaccount://callback?code=CODE-CONTRACT-SECRET#fragment' },
  { ...redirect, redirectUrl: 'apiaccount://callback?code=CODE-CONTRACT-SECRET#' },
  { ...redirect, redirectUrl: 'apiaccount://callback?code=one&code=CODE-CONTRACT-SECRET' },
  { ...redirect, redirectUrl: 'apiaccount://callback?code=%20' },
  { ...redirect, redirectUrl: 'apiaccount://callback' },
]) test('common auth: invalid sign-in/callback stops before code exchange and withholds URL', async t => {
  const s = await setup(t, (call, res) => json(res, call.url.pathname.endsWith('/authorize') ? {} : value));
  await assert.rejects(s.client.login(s.auth, 'PASSWORD-CONTRACT-SECRET'), privateFailure);
  assert.equal(s.calls.length, 2);
});
for (const [stage, statuses, count] of [
  ['authorize', [301, 304, 307, 308, 401], 1], ['signin', [302, 303, 307, 401], 2],
  ['token', [302, 303, 307, 401], 3], ['refresh', [302, 303, 307, 401], 1],
]) for (const status of statuses) test(`common auth: ${stage} rejects HTTP ${status}, no retry or redirect`, async t => {
  const s = await setup(t, (call, res) => {
    const actual = call.url.pathname.split('/').at(-1);
    const body = { ...(actual === 'signin' ? redirect : tokenBody()), code: 'AUTHENTICATION_INVALID', message: 'BODY-CONTRACT-SECRET' };
    json(res, body, actual === (stage === 'refresh' ? 'token' : stage) ? status : 200);
  });
  const action = stage === 'refresh' ? s.client.refresh(s.auth, oldTokens()) : s.client.login(s.auth, 'PASSWORD-CONTRACT-SECRET');
  await assert.rejects(action, privateFailure); assert.equal(s.calls.length, count);
});
for (const body of [
  { [alternate]: 'UNUSED-CONTRACT-SECRET', refresh_token: 'REFRESH-CONTRACT-SECRET' },
  { [primary]: 'PRIMARY-CONTRACT-SECRET' },
  { ...tokenBody(), [primary]: ' ' }, { ...tokenBody(), [primary]: 'bad\nCONTRACT-SECRET' },
  { ...tokenBody(), refresh_token: ' ' }, { ...tokenBody(), refresh_token: 'bad\nCONTRACT-SECRET' },
]) test('common auth: login requires the product token and a usable refresh token', async t => {
  const s = await setup(t, (call, res) => json(res, call.url.pathname.endsWith('/signin') ? redirect : body));
  await assert.rejects(s.client.login(s.auth, 'PASSWORD-CONTRACT-SECRET'), privateFailure); assert.equal(s.calls.length, 3);
});
test('common auth: malformed JSON, cookie and network errors never expose underlying secrets', async t => {
  const s = await setup(t, (_, res) => res.end('MALFORMED-CONTRACT-SECRET'));
  await assert.rejects(s.client.refresh(s.auth, oldTokens()), privateFailure);
  s.client.cookies.getCookieString = async () => { throw new Error('COOKIE-CONTRACT-SECRET'); };
  await assert.rejects(s.client.refresh(s.auth, oldTokens()), privateFailure);
  const client = new AuthClient(2000, true);
  client.cookies.setCookie = async () => { throw new Error('COOKIE-CONTRACT-SECRET'); };
  const cookieServer = await setup(t, (_, res) => { res.setHeader('Set-Cookie', 'session=COOKIE-CONTRACT-SECRET'); json(res, tokenBody()); });
  await assert.rejects(client.refresh(cookieServer.auth, oldTokens()), privateFailure);
  t.mock.method(http, 'request', () => { throw new Error('NETWORK-CONTRACT-SECRET'); });
  await assert.rejects(new AuthClient(2000, true).refresh(s.auth, oldTokens()), error => privateFailure(error, 10));
});
test('common auth: unsafe IDM URLs are rejected before network dispatch, including refresh', async t => {
  const s = await setup(t, () => assert.fail('No network expected'));
  await s.store.save(profile(s.auth)); const before = await readFile(s.store.file);
  let dispatched = 0;
  for (const module of [http, https]) t.mock.method(module, 'request', () => { dispatched++; throw new Error('Unexpected network'); });
  for (const authUrl of ['http://idm.example.invalid', 'https://user:CONTRACT-SECRET@idm.example.invalid', 'https://idm.example.invalid?secret=value', 'https://idm.example.invalid#', 'file:///tmp/idm']) {
    const auth = { ...s.auth, authUrl };
    await assert.rejects(s.client.login(auth, 'PASSWORD-CONTRACT-SECRET'), error => privateFailure(error, 6));
    await assert.rejects(s.client.refresh(auth, oldTokens()), error => privateFailure(error, 6));
    assert.throws(() => validateState(profile(auth)));
    const configured = await s.run(['auth', 'config', '--auth-url', authUrl]);
    assert.equal(configured.code, 6); assert.doesNotMatch(configured.stdout + configured.stderr, /CONTRACT-SECRET/);
    assert.deepEqual(await readFile(s.store.file), before);
  }
  assert.equal(dispatched, 0);
});
for (const rotated of [true, false]) test(`common auth: refresh retains ${rotated ? 'rotated' : 'prior'} credentials despite unknown expiry`, async t => {
  const s = await setup(t, (call, res) => {
    assert.equal(call.form.get('grant_type'), 'refresh_token'); assert.equal(call.form.has('password'), false);
    const response = { ...tokenBody(), expires_in: 'unknown' }; if (!rotated) delete response.refresh_token;
    json(res, response);
  });
  await s.store.save({ ...profile(s.auth), tokens: oldTokens() });
  const before = Date.now(), result = await s.run(['auth', 'refresh', '--quiet']);
  assert.equal(result.code, 0, result.stderr); assert.equal(s.calls.length, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /CONTRACT-SECRET/);
  const saved = await s.store.load();
  assert.equal(saved.tokens[savedPrimary], 'PRIMARY-CONTRACT-SECRET'); assert.equal(saved.tokens.expiresIn, undefined);
  assert.equal(saved.tokens.refreshToken, rotated ? 'REFRESH-CONTRACT-SECRET' : 'OLD-REFRESH-CONTRACT-SECRET');
  const registry = await s.store.loadCompanies();
  assert.ok(Date.parse(registry.companies[registry.activeCompany].refreshAfter) >= before + DAY);
  assert.equal((await s.run(['auth', 'refresh', '--quiet'])).code, 9); assert.equal(s.calls.length, 1);
});
test('common auth: failed login preserves state bytes and diagnostics withhold returned secrets', async t => {
  const s = await setup(t, (call, res) => json(res, call.url.pathname.endsWith('/authorize') ? {} : { ...redirect, success: false, password: 'PASSWORD-CONTRACT-SECRET' }));
  await s.store.save(profile(s.auth)); const before = await readFile(s.store.file);
  const result = await s.run(['auth', 'login', '--password', 'PASSWORD-CONTRACT-SECRET']);
  assert.equal(result.code, 9); assert.doesNotMatch(result.stdout + result.stderr, /CONTRACT-SECRET/);
  assert.deepEqual(await readFile(s.store.file), before); assert.equal(s.calls.length, 2);
});
test('common auth: bounded fractional timeout, no retry; unsafe options fail locally', async t => {
  const s = await setup(t, () => {});
  await s.store.save({ ...profile(s.auth), tokens: oldTokens() });
  const result = await s.run(['auth', 'refresh', '--timeout', '0.1']);
  assert.equal(result.code, 10, result.stderr); assert.equal(s.calls.length, 1);
  for (const timeout of ['0', '-1', 'NaN', 'Infinity', '301']) {
    assert.equal((await s.run(['auth', 'refresh', '--timeout', timeout])).code, 6);
  }
  assert.equal((await s.run(['auth', 'login', '--insecure'])).code, 6); assert.equal(s.calls.length, 1);
});
test('common auth: status and duplicate login stay offline; near-expiry label is consistent', async t => {
  const s = await setup(t, () => assert.fail('Local commands must not authenticate'));
  await s.store.save({ ...profile(s.auth), tokens: { ...oldTokens(), expiresIn: 240 } });
  const status = await s.run(['auth', 'status']); assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.stdout).data.state, 'expiring-soon');
  const login = await s.run(['auth', 'login']); assert.equal(login.code, 0);
  assert.equal(JSON.parse(login.stdout).data.alreadyStored, true); assert.equal(s.calls.length, 0);
});
test('common auth: strict imports reject foreign products, unknown/password fields and invalid credentials', async t => {
  const s = await setup(t, () => assert.fail('Restore is local'));
  const valid = () => ({ ...profile(s.auth), tokens: oldTokens() });
  const registry = p => ({ schemaVersion: 2, product, activeCompany: companyKey(p.auth), companies: { [companyKey(p.auth)]: p } });
  await s.store.save(valid()); const before = await readFile(s.store.file);
  const invalid = [];
  for (const other of ['sts', 'bi', 'cc'].filter(name => name !== product)) invalid.push({ ...registry(valid()), product: other });
  for (const location of ['root', 'auth', 'tokens']) {
    const p = valid(); (location === 'root' ? p : p[location]).password = 'PASSWORD-CONTRACT-SECRET'; invalid.push(registry(p));
  }
  for (const change of [
    p => { p.tokens.codeVerifier = 'short'; }, p => { p.tokens.refreshToken = 'bad\nCONTRACT-SECRET'; },
    p => { p.tokens[savedPrimary] = ' '; }, p => { p.tokens.obtainedAt = '2026-02-30T00:00:00Z'; },
    p => { p.tokens.expiresIn = -1; }, p => { p.tokens[product === 'sts' ? 'idToken' : 'accessToken'] = 'FOREIGN-CONTRACT-SECRET'; },
  ]) { const p = valid(); change(p); invalid.push(registry(p)); }
  const pending = registry(valid()); pending.pending = { ...profile(s.auth), auth: { ...s.auth, password: 'PASSWORD-CONTRACT-SECRET' } }; invalid.push(pending);
  const file = join(s.directory, 'invalid-import.json');
  for (const value of invalid) {
    assert.throws(() => validateCompanies(structuredClone(value)));
    await writeFile(file, JSON.stringify(value));
    const result = await s.run(['auth', 'restore', '--file', file, '--force']);
    assert.equal(result.code, 12); assert.doesNotMatch(result.stdout + result.stderr, /CONTRACT-SECRET/);
    assert.deepEqual(await readFile(s.store.file), before);
  }
  assert.equal(s.calls.length, 0);
});
