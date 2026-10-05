import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease } from '../scripts/release-check.mjs';

const pkg = { name: '@muneris/sts-cli', version: '1.2.3' };
const lock = { version: '1.2.3', packages: { '': { version: '1.2.3' } } };
test('release gate returns archive name for a matching stable tag', () => {
  assert.equal(validateRelease('v1.2.3', pkg, lock), 'muneris-sts-cli-1.2.3.tgz');
});
test('release gate rejects missing or mismatched tags', () => {
  for (const tag of [undefined, 'main', '1.2.3', 'v1.2.4']) assert.throws(() => validateRelease(tag, pkg, lock), /Release tag/);
});
test('release gate rejects inconsistent lockfile versions', () => {
  assert.throws(() => validateRelease('v1.2.3', pkg, { ...lock, version: '1.2.2' }), /versions must match/);
  assert.throws(() => validateRelease('v1.2.3', pkg, { ...lock, packages: {} }), /versions must match/);
});
test('release gate refuses unexpected packages and prerelease versions', () => {
  assert.throws(() => validateRelease('v1.2.3', { ...pkg, name: 'other' }, lock), /package name/);
  assert.throws(() => validateRelease('v1.2.3-beta.1', { ...pkg, version: '1.2.3-beta.1' }, lock), /stable SemVer/);
});
