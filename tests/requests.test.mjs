import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpoints } from '../dist/endpoints.js';
import { buildRead, buildCheckRead, buildCheckWrite, validateStsUrl } from '../dist/requests.js';
import { examples } from '../dist/examples.js';
const state = { auth: { orgName: 'example-org', stsUrl: 'https://example.invalid' }, tokens: { accessToken: 'test-token' } };
const options = { location: 'example-loc', rvc: 1, employeeId: 5, employee: 3, orderType: 1 };
for (const endpoint of endpoints) {
  test(`registry addressing: ${endpoint.noun} ${endpoint.verb}`, () => {
    const req = buildRead(endpoint, state, options);
    const url = new URL(req.url);
    assert.equal(req.headers.Accept, 'application/json');
    assert.equal(req.headers.Authorization, 'Bearer test-token');
    if (endpoint.addressing === 'query') {
      assert.equal(url.searchParams.get('OrgShortName'), 'example-org');
      assert.equal(url.searchParams.get('LocRef'), 'example-loc');
      if (endpoint.rvc) assert.equal(url.searchParams.get('RvcRef'), '1');
      if (endpoint.employeeId) assert.equal(url.searchParams.get('EmployeeId'), '5');
    } else if (endpoint.addressing === 'header') {
      assert.equal(req.headers['Simphony-OrgShortName'], 'example-org');
      assert.equal(req.headers['Simphony-LocRef'], 'example-loc');
      assert.equal(req.headers['Simphony-RvcRef'], '1');
      assert.equal(decodeURIComponent(url.pathname), '/api/v2/menus/example-org:example-loc:1');
    } else if (endpoint.noun !== 'org' || endpoint.verb !== 'list') {
      assert.match(url.pathname, /example-org/);
    }
  });
}
test('per-call STS URL preserves explicit ports, IPv6 and base paths without saving', () => {
  const def = endpoints.find(e => e.noun === 'tender');
  const before = structuredClone(state);
  for (const base of ['https://pos.example:443', 'https://pos.example:5443', 'http://pos.example:80', 'https://[::1]:443/gateway', 'https://pos.example/gateway']) {
    const req = buildRead(def, state, { ...options, stsUrl: base });
    assert.ok(req.url.startsWith(base + '/api/v1/tenders/collection?'), req.url);
    assert.equal(req.target, 'override');
    assert.equal(req.insecure, false);
  }
  const saved = buildRead(def, state, options);
  assert.ok(saved.url.startsWith(state.auth.stsUrl));
  assert.equal(saved.target, 'saved');
  assert.equal(saved.insecure, false);
  assert.deepEqual(state, before);
});
test('insecure is explicit, per call, and works with a saved or overridden HTTPS STS URL', () => {
  const def = endpoints.find(e => e.noun === 'tender');
  assert.equal(buildRead(def, state, { ...options, stsUrl: 'https://pos.example:5443', insecure: true }).insecure, true);
  assert.equal(buildRead(def, state, { ...options, insecure: true }).insecure, true);
  assert.equal(buildRead(def, state, options).insecure, false);
  assert.throws(() => buildRead(def, state, { ...options, stsUrl: 'http://pos.example', insecure: true }), /HTTPS/);
});
test('insecure cannot disable verification for known Oracle cloud or the configured IDM', () => {
  const def = endpoints.find(e => e.noun === 'tender');
  const configured = { ...state, auth: { ...state.auth, authUrl: 'https://idm.example' } };
  for (const base of ['https://mte5-sts.oraclemicros.com', 'https://mte4-sts.oraclecloud.com', 'https://example.oracleindustry.com', 'https://example.oraclerestaurants.com', 'https://idm.example:5443', 'https://MTE5-STS.ORACLEMICROS.COM.']) {
    assert.throws(() => buildRead(def, configured, { ...options, stsUrl: base, insecure: true }), /Oracle cloud|IDM/);
    assert.equal(buildRead(def, configured, { ...options, stsUrl: base }).insecure, false);
  }
});
test('STS URL requires an absolute base URL without credentials, queries or fragments', () => {
  for (const invalid of ['', 'pos.example', 'pos.example:443', 'https:pos.example', 'ftp://pos.example', 'https://user:pass@pos.example', 'https://pos.example?x=1', 'https://pos.example#', ' https://pos.example']) {
    assert.throws(() => validateStsUrl(invalid), undefined, invalid);
  }
  assert.equal(validateStsUrl('https://pos.example').protocol, 'https:');
});
test('check filters encode free text; dates expand to midnight UTC', () => {
  const req = buildCheckRead('list', undefined, state, { ...options, includeClosed: true, checkNumber: '12, 34', table: 'A & B', sinceTime: '2026-01-01' });
  const query = new URL(req.url).searchParams;
  assert.equal(query.get('checkNumbers'), '12,34'); assert.equal(query.get('tableName'), 'A & B');
  assert.equal(query.get('sinceTime'), '2026-01-01T00:00:00Z'); assert.equal(query.get('includeClosed'), 'true');
});
test('invalid idempotency never silently changes to random; explicit opt-in only', () => {
  assert.throws(() => buildCheckWrite('new', undefined, state, { ...options, idempotencyId: 'bad' }, {}), /idempotency/);
  const req = buildCheckWrite('new', undefined, state, options, { header: { idempotencyId: 'body-id', checkRef: 'wrong' } });
  const body = JSON.parse(req.body);
  assert.match(body.header.idempotencyId, /^[a-f0-9]{32}$/);
  assert.equal(body.header.checkRef, undefined);
  assert.equal(req.headers['Simphony-Features'], undefined);
});
test('calculator preserves the requested structured body without inventing a tender', () => {
  const req = buildCheckWrite('calculate', undefined, state, options, examples.calculate);
  assert.equal(req.method, 'POST'); assert.equal(new URL(req.url).pathname, '/api/v1/checks/calculator');
  assert.equal(JSON.parse(req.body).tenders, undefined);
  assert.equal(examples.calculate.header, undefined);
});
test('delete creates no body and encodes reference as one path segment', () => {
  const req = buildCheckWrite('delete', 'some/ref', state, options);
  assert.equal(req.method, 'DELETE'); assert.equal(req.body, undefined);
  assert.equal(new URL(req.url).pathname, '/api/v1/checks/some%2Fref');
});
