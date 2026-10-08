import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { companyKey, validateCompanies, tokenSummary, DAY, HOUR } from '../dist/state.js';
import { refreshCompanies } from '../dist/companies.js';
import { AuthClient } from '../dist/auth.js';
import { setup, form } from './response-helpers.mjs';
import { clientIdFor } from './fixtures.mjs';
const command = ['tender','list','--location','synthetic','--rvc','1'];
function profile(code, url, overrides = {}) {
  return { auth: { orgName: code, clientId: clientIdFor(code), authUrl: url, stsUrl: url, username: code + '_USER' },
    tokens: { accessToken: code + '-access', refreshToken: code + '-refresh', codeVerifier: 'a'.repeat(43), obtainedAt: new Date(Date.now() - 2 * DAY).toISOString(), expiresIn: 10 * DAY / 1000 },
    refreshAfter: new Date(Date.now() - HOUR).toISOString(), ...overrides };
}
async function save(s, profiles, selected = 0) {
  const keys = profiles.map(p => companyKey(p.auth));
  await s.store.saveCompanies({ schemaVersion: 2, activeCompany: selected === null ? null : keys[selected], companies: Object.fromEntries(profiles.map((p, i) => [keys[i], p])) });
  return keys;
}
function renewal(res, name, expires = 864000) { res.end(JSON.stringify({ access_token: name + '-new-access', refresh_token: name + '-new-refresh', expires_in: expires })); }

test('keys use derived company code and lowercase hostname only; invalid registries fail closed', () => {
  const auth = { clientId: clientIdFor('AUS'), authUrl: 'https://IDM.EXAMPLE.invalid:9443/custom/path' };
  assert.equal(companyKey(auth), 'AUS@idm.example.invalid');
  assert.equal(companyKey({ ...auth, authUrl: 'http://idm.example.invalid/other' }), companyKey(auth));
  for (const value of [
    { schemaVersion: 9, companies: {}, activeCompany: null },
    { schemaVersion: 2, companies: {}, activeCompany: 'missing' },
    { schemaVersion: 2, companies: { wrong: { auth } }, activeCompany: null },
    { schemaVersion: 2, companies: { [companyKey(auth)]: { auth, refreshAfter: 'not-a-date' } }, activeCompany: null },
  ]) assert.throws(() => validateCompanies(value));
  const now = Date.now();
  assert.equal(tokenSummary({ obtainedAt: new Date(now - 999).toISOString(), expiresIn: 1 }, now).expired, false);
  assert.equal(tokenSummary({ obtainedAt: new Date(now - 1000).toISOString(), expiresIn: 1 }, now).expired, true);
});

test('legacy configuration migrates without losing tokens; persistence occurs on mutation', async t => {
  const s = await setup(t); const legacy = profile('AUS', s.url); delete legacy.refreshAfter;
  await fs.writeFile(s.store.file, JSON.stringify(legacy));
  const before = await fs.readFile(s.store.file, 'utf8');
  const loaded = await s.store.loadCompanies(), key = companyKey(legacy.auth);
  assert.equal(loaded.activeCompany, key); assert.deepEqual(loaded.companies[key].tokens, legacy.tokens);
  assert.equal(loaded.companies[key].refreshAfter, new Date(Date.parse(legacy.tokens.obtainedAt) + DAY).toISOString());
  assert.equal(await fs.readFile(s.store.file, 'utf8'), before);
  assert.equal((await s.run(['company','select',key])).code, 0);
  const saved = JSON.parse(await fs.readFile(s.store.file, 'utf8'));
  assert.equal(saved.schemaVersion, 2); assert.equal(saved.auth, undefined); assert.deepEqual(saved.companies[key].tokens, legacy.tokens);
  assert.equal(s.calls.length, 0);
});

test('list/select/delete are local and exact; deleting active never chooses another', async t => {
  const s = await setup(t);
  const first = profile('AUS', s.url), second = profile('AUS', s.url.replace('127.0.0.1', 'localhost'));
  const [a,b] = await save(s, [first, second]);
  const listing = await s.run(['company','list']);
  assert.equal(JSON.parse(listing.stdout).data.companies.length, 2);
  assert.doesNotMatch(listing.stdout, /AUS-access|AUS-refresh|codeVerifier/);
  assert.equal((await s.run(['company','select','AUS'])).code, 6);
  assert.equal((await s.store.loadCompanies()).activeCompany, a);
  assert.equal((await s.run(['company','select',b])).code, 0);
  assert.equal((await s.run(['company','delete',b])).code, 0);
  const saved = await s.store.loadCompanies(); assert.equal(saved.activeCompany, null); assert.ok(saved.companies[a]); assert.equal(saved.companies[b], undefined);
  assert.equal((await s.run(command)).code, 7); assert.equal(s.calls.length, 0);
  assert.equal((await s.run(['company','delete',a])).code, 0);
  assert.deepEqual((await s.store.loadCompanies()).companies, {});
});

test('config prepares login without changing saved profile, tokens or selection', async t => {
  const s = await setup(t); const a = profile('A', s.url); const [key] = await save(s, [a]);
  const r = await s.run(['auth','config','--client-id',clientIdFor('B'),'--username','B_USER']);
  assert.equal(r.code, 0, r.stderr);
  const registry = await s.store.loadCompanies();
  assert.deepEqual(registry.companies[key], a); assert.equal(registry.activeCompany, key);
  assert.equal(registry.pending.auth.orgName, 'B'); assert.equal(registry.pending.tokens, undefined);
  assert.equal(s.calls.length, 0);
});

test('duplicate company/environment/username login reports stored token without password or network', async t => {
  const s = await setup(t); const a = profile('A', s.url), b = profile('B', s.url);
  const [ka,kb] = await save(s, [a,b]);
  await s.store.mutateCompanies(async registry => { registry.pending = { auth: b.auth }; });
  const r = await s.run(['auth','login']); assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).data.alreadyStored, true);
  assert.equal(JSON.parse(r.stdout).data.company, kb);
  assert.equal((await s.store.loadCompanies()).activeCompany, ka); assert.equal(s.calls.length, 0);
  assert.doesNotMatch(r.stdout, /B-access|B-refresh/);
});

for (const failure of [false, true]) test(`new-company login ${failure ? 'failure preserves' : 'success selects and preserves'} other companies`, async t => {
  const s = await setup(t, async (req, res) => {
    if (failure) { res.writeHead(401); res.end('synthetic rejection'); return; }
    if (req.url.includes('/authorize?')) { res.end('{}'); return; }
    if (req.url.endsWith('/signin')) {
      const fields = await form(req); assert.equal(fields.get('username'), 'B_USER');
      res.end(JSON.stringify({ nextOp: 'redirect', redirectUrl: 'apiaccount://callback?code=synthetic-code' })); return;
    }
    renewal(res, 'B', '864000');
  });
  const a = profile('A', s.url); const [ka] = await save(s, [a]);
  const b = profile('B', s.url); const kb = companyKey(b.auth);
  await s.store.mutateCompanies(async registry => { registry.pending = { auth: b.auth }; });
  const before = Date.now(); const r = await s.run(['auth','login','--password','synthetic-password']); const after = Date.now();
  assert.equal(r.code, failure ? 9 : 0, r.stderr);
  const stored = await s.store.loadCompanies(); assert.deepEqual(stored.companies[ka], a);
  assert.equal(stored.activeCompany, failure ? ka : kb);
  if (failure) assert.equal(stored.companies[kb], undefined);
  else {
    assert.equal(stored.pending, undefined); assert.equal(stored.companies[kb].tokens.expiresIn, 864000);
    assert.ok(Date.parse(stored.companies[kb].refreshAfter) >= before + DAY && Date.parse(stored.companies[kb].refreshAfter) <= after + DAY);
  }
  assert.doesNotMatch(await fs.readFile(s.store.file, 'utf8'), /synthetic-password/);
});

test('first successful login automatically selects its profile, including after all entries are deleted', async t => {
  const s = await setup(t, (req, res) => {
    req.resume();
    if (req.url.includes('/authorize?')) res.end('{}');
    else if (req.url.endsWith('/signin')) res.end(JSON.stringify({ nextOp: 'redirect', redirectUrl: 'apiaccount://callback?code=synthetic-code' }));
    else renewal(res, 'A');
  });
  const p = profile('A', s.url), key = companyKey(p.auth);
  await s.store.saveCompanies({ schemaVersion: 2, activeCompany: null, companies: {}, pending: { auth: p.auth } });
  assert.equal((await s.run(['auth','login','--password','synthetic'])).code, 0);
  assert.equal((await s.store.loadCompanies()).activeCompany, key);
  await s.run(['company','delete',key]);
  await s.run(['auth','config','--auth-url',s.url,'--sts-url',s.url,'--client-id',clientIdFor('A'),'--username','A_USER']);
  assert.equal((await s.run(['auth','login','--password','synthetic'])).code, 0);
  assert.equal((await s.store.loadCompanies()).activeCompany, key);
});

test('API preflight renews all due profiles, not just active; subsequent calls skip fresh schedules', async t => {
  const renewals = [];
  const s = await setup(t, async (req, res) => {
    if (req.url.endsWith('/token')) {
      assert.equal(req.headers.authorization, undefined);
      const fields = await form(req); const name = Buffer.from(fields.get('client_id'),'base64').toString().split('.')[0];
      assert.equal(fields.get('refresh_token'), name + '-refresh'); renewals.push(name); renewal(res, name);
    } else { assert.equal(req.headers.authorization, 'Bearer A-new-access'); res.end('EXACT\r\n'); }
  });
  const [a,b] = await save(s, [profile('A', s.url), profile('B', s.url)]);
  const before = Date.now(); const r = await s.run(command); const after = Date.now();
  assert.equal(r.code, 0, r.stderr); assert.equal(r.stdout, 'EXACT\r\n'); assert.deepEqual(renewals, ['A','B']);
  const stored = await s.store.loadCompanies(); assert.equal(stored.activeCompany, a);
  for (const key of [a,b]) assert.ok(Date.parse(stored.companies[key].refreshAfter) >= before + DAY && Date.parse(stored.companies[key].refreshAfter) <= after + DAY);
  assert.equal((await s.run(command)).code, 0); assert.equal(renewals.length, 2);
});

test('refresh failure retains valid tokens, backs off one hour, and does not block active API or other renewals', async t => {
  const renewals = [];
  const s = await setup(t, async (req, res) => {
    if (req.url.endsWith('/token')) {
      const fields = await form(req); const name = Buffer.from(fields.get('client_id'),'base64').toString().split('.')[0]; renewals.push(name);
      if (name === 'A') { res.writeHead(503); res.end('synthetic outage'); } else renewal(res, name);
    } else { assert.equal(req.headers.authorization, 'Bearer A-access'); res.end('OK'); }
  });
  const original = profile('A', s.url), [a,b] = await save(s, [original, profile('B', s.url)]);
  const before = Date.now(); const r = await s.run(command); const after = Date.now();
  assert.equal(r.code, 0); assert.equal(r.stdout, 'OK'); assert.match(r.stderr, /failed/);
  const stored = await s.store.loadCompanies(); assert.deepEqual(stored.companies[a].tokens, original.tokens);
  assert.ok(Date.parse(stored.companies[a].refreshAfter) >= before + HOUR && Date.parse(stored.companies[a].refreshAfter) <= after + HOUR);
  assert.equal(stored.companies[b].tokens.accessToken, 'B-new-access');
  assert.equal((await s.run(command)).code, 0); assert.deepEqual(renewals, ['A','B']);
});

test('expired tokens are cleared before refresh eligibility; active configuration/selection survive', async t => {
  const s = await setup(t); const expired = profile('A', s.url);
  expired.tokens.obtainedAt = new Date(Date.now() - 11 * DAY).toISOString(); expired.refreshAfter = new Date(Date.now() + DAY).toISOString();
  const [key] = await save(s, [expired]);
  const r = await s.run(command); assert.equal(r.code, 8, r.stderr); assert.equal(s.calls.length, 0);
  const saved = await s.store.loadCompanies(); assert.equal(saved.activeCompany, key); assert.deepEqual(saved.companies[key].auth, expired.auth);
  assert.equal(saved.companies[key].tokens, undefined); assert.equal(saved.companies[key].refreshAfter, undefined);
  assert.equal((await s.run(['auth','refresh'])).code, 8); assert.equal(s.calls.length, 0);
});

test('local commands, invalid requests and dry-run never trigger renewal or expiry cleanup', async t => {
  const s = await setup(t); await save(s, [profile('A', s.url)]);
  const before = await fs.readFile(s.store.file, 'utf8');
  for (const cmd of [['--help'], ['auth','status'], ['auth','show'], ['company','list'], ['company','status'], [...command,'--dry-run'], ['tender','list','--rvc','1']]) await s.run(cmd);
  assert.equal(s.calls.length, 0); assert.equal(await fs.readFile(s.store.file, 'utf8'), before);
});

test('explicit refresh runs all unexpired profiles even during backoff without changing active selection', async t => {
  const s = await setup(t, (req, res) => { req.resume(); renewal(res, 'manual'); });
  const [a] = await save(s, [profile('A', s.url, { refreshAfter: new Date(Date.now() + DAY).toISOString() }), profile('B', s.url, { refreshAfter: new Date(Date.now() + HOUR).toISOString() })]);
  const r = await s.run(['auth','refresh']); assert.equal(r.code, 0, r.stderr);
  assert.equal(s.calls.length, 2); assert.equal((await s.store.loadCompanies()).activeCompany, a);
  assert.ok(JSON.parse(r.stdout).data.companies.every(x => x.status === 'refreshed'));
});

test('rotation persistence failure stops before other refreshes/API and retains full registry recovery', async t => {
  const s = await setup(t, (req, res) => { req.resume(); renewal(res, 'rotated'); });
  const [a,b] = await save(s, [profile('A', s.url), profile('B', s.url)]);
  t.mock.method(fs, 'rename', async () => { throw Error('synthetic rename failure'); }); syncBuiltinESMExports();
  try { await assert.rejects(refreshCompanies(s.store, true, 30, true), error => error.exitCode === 12); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(s.calls.length, 1);
  const files = await fs.readdir(s.directory); const copy = files.find(x => x.endsWith('.tmp')); assert.ok(copy);
  const recovery = JSON.parse(await fs.readFile(path.join(s.directory, copy), 'utf8'));
  assert.equal(recovery.companies[a].tokens.refreshToken, 'rotated-new-refresh');
  assert.equal(recovery.companies[b].tokens.refreshToken, 'B-refresh'); assert.equal(recovery.activeCompany, a);
  assert.equal((await s.store.loadCompanies()).companies[a].tokens.refreshToken, 'A-refresh');
});

test('lock-time schedule recheck prevents a second automatic renewal', async t => {
  const s = await setup(t, (req, res) => { req.resume(); renewal(res, 'once'); });
  await save(s, [profile('A', s.url)]);
  const original = s.store.mutateCompanies.bind(s.store); let first = true;
  // Model another successful renewal between the initial scan and lock acquisition.
  s.store.mutateCompanies = async callback => {
    if (first) { first = false; await original(async registry => { registry.companies[registry.activeCompany].refreshAfter = new Date(Date.now() + DAY).toISOString(); }); }
    return original(callback);
  };
  const results = await refreshCompanies(s.store, true, 30, true);
  assert.equal(results[0].status, 'not-due'); assert.equal(s.calls.length, 0);
});

test('an API invocation pins company identity even if selection changes during preflight', async t => {
  const s = await setup(t, (req, res) => { assert.equal(req.headers.authorization, 'Bearer A-access'); res.end('PINNED'); });
  const [a,b] = await save(s, [profile('A', s.url, { refreshAfter: new Date(Date.now() + DAY).toISOString() }), profile('B', s.url, { refreshAfter: new Date(Date.now() + DAY).toISOString() })]);
  const script = `import {main} from './dist/cli.js'; import {StateStore} from './dist/state.js';
    class SwitchingStore extends StateStore { count=0; async loadCompanies() {
      if(++this.count===2) await new StateStore(this.directory).mutateCompanies(async registry=>{registry.activeCompany=${JSON.stringify(b)};});
      return super.loadCompanies();
    }}
    process.exitCode=await main(['node','sts',...${JSON.stringify(command)}],new SwitchingStore(${JSON.stringify(s.directory)}),async()=>{});`;
  const child = spawn(process.execPath, ['--input-type=module','-e',script]); let out='',err='';
  child.stdout.on('data', b => out+=b); child.stderr.on('data', b => err+=b);
  const [code] = await once(child,'close'); assert.equal(code,0,err); assert.equal(out,'PINNED');
  assert.equal((await s.store.loadCompanies()).activeCompany,b); assert.notEqual(a,b);
});

test('unknown expiry is retained but never guessed or refreshed', async t => {
  const s = await setup(t); const p = profile('A', s.url); delete p.tokens.expiresIn;
  const [key] = await save(s,[p]); const r=await s.run(['auth','refresh']);
  assert.equal(r.code,9); assert.equal(s.calls.length,0);
  assert.deepEqual((await s.store.loadCompanies()).companies[key].tokens,p.tokens);
});

test('OAuth lifetime numbers/strings are parsed; unusable metadata never loses rotated credentials', () => {
  const auth = new AuthClient(1000, true);
  for (const expiry of [3600, '3600', 0, '0', undefined, null, -1, 'not-a-number', 1.5, Number.MAX_SAFE_INTEGER]) {
    const tokens = auth.tokens({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: expiry })) }, 'verifier', 'old-refresh');
    assert.equal(tokens.refreshToken, 'new-refresh');
    assert.equal(tokens.expiresIn, [3600, '3600', 0, '0'].includes(expiry) ? Number(expiry) : undefined);
  }
});

test('corrupt timestamps/lifetimes fail closed instead of triggering expired-token deletion', () => {
  const p = profile('A', 'https://idm.example.invalid');
  for (const obtainedAt of ['123', '2026-02-31T00:00:00Z', '2026-01-01', '2026-01-01T24:00:00Z']) {
    assert.throws(() => validateCompanies({ schemaVersion: 2, activeCompany: null, companies: { [companyKey(p.auth)]: { ...p, tokens: { ...p.tokens, obtainedAt } } } }));
  }
  for (const expiresIn of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateCompanies({ schemaVersion: 2, activeCompany: null, companies: { [companyKey(p.auth)]: { ...p, tokens: { ...p.tokens, expiresIn } } } }));
  }
});

test('inactive expired tokens are removed even during cooldown without blocking the active API', async t => {
  const s = await setup(t, (_, res) => res.end('ACTIVE'));
  const a = profile('A', s.url, { refreshAfter: new Date(Date.now() + DAY).toISOString() });
  const b = profile('B', s.url, { refreshAfter: new Date(Date.now() + DAY).toISOString() });
  b.tokens.obtainedAt = new Date(Date.now() - 11 * DAY).toISOString();
  const [ka,kb] = await save(s,[a,b]);
  const r = await s.run(command); assert.equal(r.code,0); assert.equal(r.stdout,'ACTIVE'); assert.equal(s.calls.length,1);
  const registry = await s.store.loadCompanies(); assert.equal(registry.activeCompany,ka); assert.deepEqual(registry.companies[ka],a);
  assert.equal(registry.companies[kb].tokens,undefined); assert.deepEqual(registry.companies[kb].auth,b.auth);
});

test('logout affects only active tokens; selecting a profile discards unrelated prepared login', async t => {
  const s=await setup(t); const a=profile('A',s.url),b=profile('B',s.url); const [ka,kb]=await save(s,[a,b]);
  await s.store.mutateCompanies(async registry=>{registry.pending={auth:b.auth};});
  assert.equal((await s.run(['auth','logout'])).code,0);
  let registry=await s.store.loadCompanies(); assert.equal(registry.activeCompany,ka); assert.equal(registry.companies[ka].tokens,undefined);
  assert.deepEqual(registry.companies[kb],b); assert.deepEqual(registry.pending.auth,b.auth);
  assert.equal((await s.run(['company','select',ka])).code,0); registry=await s.store.loadCompanies(); assert.equal(registry.pending,undefined);
  assert.equal(s.calls.length,0);
});

test('expired duplicate allows login; different username can replace the same company key only on success', async t => {
  const s=await setup(t,(req,res)=>{
    req.resume();
    if(req.url.includes('/authorize?')) res.end('{}');
    else if(req.url.endsWith('/signin')) res.end(JSON.stringify({nextOp:'redirect',redirectUrl:'apiaccount://callback?code=synthetic-code'}));
    else renewal(res,'replacement');
  });
  const a=profile('A',s.url); a.tokens.obtainedAt=new Date(Date.now()-11*DAY).toISOString(); const [key]=await save(s,[a]);
  let r=await s.run(['auth','login','--password','synthetic']); assert.equal(r.code,0,r.stderr); assert.equal(JSON.parse(r.stdout).data.alreadyStored,false);
  r=await s.run(['auth','login','--username','ANOTHER_USER','--password','synthetic']); assert.equal(r.code,0,r.stderr);
  const registry=await s.store.loadCompanies(); assert.deepEqual(Object.keys(registry.companies),[key]);
  assert.equal(registry.companies[key].auth.username,'ANOTHER_USER'); assert.equal(registry.activeCompany,key); assert.equal(s.calls.length,6);
});

test('failed same-key replacement preserves its original identity and tokens', async t => {
  const s=await setup(t,(_,res)=>{res.writeHead(401);res.end('rejected');});
  const a=profile('A',s.url); const [key]=await save(s,[a]);
  const r=await s.run(['auth','login','--username','ANOTHER_USER','--password','synthetic']); assert.equal(r.code,9);
  const registry=await s.store.loadCompanies(); assert.deepEqual(registry.companies[key],a); assert.equal(registry.activeCompany,key);
});

test('API rejection is passed through without a post-401 refresh or retry', async t => {
  const s=await setup(t,(_,res)=>{res.writeHead(401);res.end('ORIGINAL 401\r\n');});
  await save(s,[profile('A',s.url,{refreshAfter:new Date(Date.now()+DAY).toISOString()})]);
  const r=await s.run(command); assert.equal(r.code,9); assert.equal(r.stdout,'ORIGINAL 401\r\n'); assert.equal(s.calls.length,1);
});

test('schedule due boundary is inclusive; a failed renewal cannot retain tokens that expired during it', async t => {
  const s=await setup(t); const now=Date.now(); const p=profile('A',s.url,{refreshAfter:new Date(now).toISOString()});
  const [key]=await save(s,[p]);
  t.mock.method(Date,'now',()=>now);
  t.mock.method(AuthClient.prototype,'refresh',async()=>{
    t.mock.method(Date,'now',()=>Date.parse(p.tokens.obtainedAt)+p.tokens.expiresIn*1000);
    throw Error('synthetic outage at expiry');
  });
  const results=await refreshCompanies(s.store,true,30,true);
  assert.equal(results[0].status,'expired-cleared'); assert.equal((await s.store.loadCompanies()).companies[key].tokens,undefined);
});
