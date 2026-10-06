import { test } from 'node:test';
import assert from 'node:assert/strict';
import { organizationFromClientId } from '../dist/identity.js';
import { validateState } from '../dist/state.js';
import { clientIdFor } from './fixtures.mjs';

test('organization is decoded from the client ID without changing case, punctuation or padding', () => {
  for (const org of ['synthetic', 'Upper_CASE-Org', 'org.with.dots']) {
    const id = clientIdFor(org);
    assert.equal(organizationFromClientId(id), org);
    assert.equal(organizationFromClientId(id.replace(/=+$/, '')), org);
    const state = validateState({ auth: { clientId: id, orgName: 'ignored-override' }, tokens: { accessToken: 'synthetic-token' } });
    assert.equal(state.auth.orgName, org);
    assert.equal(state.auth.clientId, id);
    assert.equal(state.tokens.accessToken, 'synthetic-token');
  }
  assert.ok(clientIdFor('synthetic').endsWith('=='));
});
test('unknown or malformed client IDs are rejected without leaking their content', () => {
  const encode = text => Buffer.from(text).toString('base64');
  const id = clientIdFor('synthetic');
  for (const invalid of ['', 'test-client==', ' '+id, id+'\n', id+'=', 'Zg=', 'Zh==',
    encode('org'), encode('org.not-a-uuid'), encode('.11111111-1111-4111-8111-111111111111'),
    encode('bad org.11111111-1111-4111-8111-111111111111'),
    encode('org\n.11111111-1111-4111-8111-111111111111'), Buffer.from([0xff,0xfe]).toString('base64')]) {
    assert.throws(() => organizationFromClientId(invalid), error => error.exitCode === 6 && error.message.includes('Base64 encoding of <organization>.<UUID>'));
  }
});
test('stored organization alone cannot supply an override without a client ID', () => {
  assert.equal(validateState({ auth: { orgName: 'manual-org' } }).auth.orgName, undefined);
});
