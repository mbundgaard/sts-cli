import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { networkFailureHint } from '../dist/diagnostics.js';
import { baseRequest } from '../dist/requests.js';
import { execute } from '../dist/cli.js';

const state = { auth: { orgName: 'mock-org', stsUrl: 'https://pos.example', authUrl: 'https://idm.example' }, tokens: { accessToken: 'mock-access' } };
const certError = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
const makeRequest = (options = {}) => baseRequest(state, options, '/api/v1/checks');

test('certificate hint prioritizes repair and requires explicit endpoint confirmation', () => {
  const hint = networkFailureHint(certError, makeRequest());
  assert.match(hint, /fix the server certificate/);
  assert.match(hint, /--insecure/);
  assert.match(hint, /explicit confirmation for this endpoint/);
  assert.match(hint, /Never retry automatically/);
  assert.match(hint, /Bearer token/);
});
test('DNS, refusal, timeout and generic TLS errors do not suggest bypass', () => {
  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER']) {
    assert.equal(networkFailureHint({ code }, makeRequest()), undefined);
  }
  assert.equal(networkFailureHint(new Error('self-signed certificate'), makeRequest()), undefined);
});
test('protected Oracle/IDM hosts and already-insecure calls get no bypass suggestion', () => {
  for (const req of [makeRequest({ stsUrl: 'https://mte5-sts.oraclemicros.com' }), makeRequest({ stsUrl: 'https://idm.example:5443' }), makeRequest({ insecure: true })]) {
    const hint = networkFailureHint(certError, req);
    assert.match(hint, /certificate or trusted CA/);
    assert.doesNotMatch(hint, /--insecure/);
  }
});
test('certificate guidance does not replace uncertain-write warnings', () => {
  const req = { ...makeRequest(), method: 'POST' };
  assert.match(networkFailureHint(certError, req), /explicit confirmation/);
  assert.match(networkFailureHint(certError, req), /Do not blindly retry a write/);
  const timeoutHint = networkFailureHint({ code: 'ETIMEDOUT' }, req);
  assert.match(timeoutHint, /idempotency ID/);
  assert.doesNotMatch(timeoutHint, /--insecure/);
});
test('certificate failure stays exit 10, verified TLS stays on, and no retry is performed', async t => {
  let calls = 0;
  t.mock.method(https, 'request', (_url, options) => {
    calls++;
    assert.equal(options.rejectUnauthorized, true);
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => { req.emit('error', certError); req.emit('close'); });
    req.destroy = () => req;
    return req;
  });
  await assert.rejects(execute(makeRequest(), { quiet: true }), error => {
    assert.equal(error.exitCode, 10);
    assert.match(error.hint, /explicit confirmation/);
    return true;
  });
  assert.equal(calls, 1);
});
