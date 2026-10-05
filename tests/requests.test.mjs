import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpoints } from '../dist/endpoints.js';
import { buildRead, buildCheckRead, buildCheckWrite, normalizeLocal } from '../dist/requests.js';
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
test('local TLS bypass is per request, not saved; explicit ports and IPv6 preserved', () => {
  assert.equal(normalizeLocal('127.0.0.1'), 'https://127.0.0.1:5443');
  assert.equal(normalizeLocal('[::1]'), 'https://[::1]:5443');
  assert.equal(normalizeLocal('https://example.invalid'), 'https://example.invalid');
  assert.equal(normalizeLocal('http://example.invalid:123'), 'http://example.invalid:123');
  const def = endpoints.find(e => e.noun === 'tender');
  assert.equal(buildRead(def, state, { ...options, localStsIp: '127.0.0.1' }).insecure, true);
  assert.equal(buildRead(def, state, options).insecure, false);
  assert.equal(state.auth.stsUrl, 'https://example.invalid');
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
