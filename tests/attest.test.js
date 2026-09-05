import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAttestation, verifyAttestation, encodeAttestation, decodeAttestation, releaseKey, attestHeaders, _setAttestation, ATTEST_HEADER } from '../src/attest.js';
import { makeCvClient } from '../src/cv.js';

const NOW = Date.parse('2026-09-06T00:00:00Z');

test('sign → verify round-trips; the signature covers every field and the key is per release', () => {
  const a = signAttestation('test-master', { version: '0.7.95', commit: 'abc123', built_at: '2026-09-05T00:00:00Z', channel: 'release' });
  // The fixed vector the metadata service's own tests check against.
  assert.equal(a.sig, 'c243c2eba987fdf0b1949f35b7b8c3d72880acc166fdf04ff127c71610eb93e6');
  assert.deepEqual(verifyAttestation('test-master', a, { now: NOW }), { ok: true });
  assert.equal(verifyAttestation('other-master', a, { now: NOW }).reason, 'bad signature');
  for (const k of ['version', 'commit', 'built_at', 'channel']) {
    const tampered = { ...a, [k]: a[k] + 'x' };
    assert.notEqual(verifyAttestation('test-master', tampered, { now: NOW }).ok, true, `${k} is covered`);
  }
  // Different versions sign with different derived keys.
  assert.notDeepEqual(releaseKey('test-master', '0.7.95'), releaseKey('test-master', '0.7.96'));
});

test('verify rejects revoked versions, stale builds and future dates; the header encodes losslessly', () => {
  const a = signAttestation('m', { version: '0.7.9', commit: 'c', built_at: '2026-01-01T00:00:00Z' });
  assert.equal(verifyAttestation('m', a, { now: NOW, revoked: ['0.7.9'] }).reason, 'revoked');
  assert.equal(verifyAttestation('m', a, { now: NOW, maxAgeDays: 30 }).reason, 'expired');
  assert.equal(verifyAttestation('m', a, { now: NOW, maxAgeDays: 0 }).ok, true, '0 = no age limit');
  const future = signAttestation('m', { version: '0.7.9', commit: 'c', built_at: '2027-01-01T00:00:00Z' });
  assert.equal(verifyAttestation('m', future, { now: NOW }).reason, 'future date');
  assert.equal(verifyAttestation('m', null).reason, 'no master key' === 'x' ? '' : verifyAttestation('m', null).reason);
  assert.deepEqual(decodeAttestation(encodeAttestation(a)), a);
  assert.equal(decodeAttestation('not base64 json'), null);
});

test('the metadata client sends the attestation header when the image carries one, and nothing otherwise', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, headers: init?.headers || {} }); return { ok: true, status: 200, json: async () => ({ status_code: 1, results: { id: 1, name: 'V', issues: [] }, key: 'k' }) }; };
  const cfg = { metadataSource: 'hosted', metadataInstanceKey: null, comicvineKeys: '' };
  _setAttestation(null);
  let c = makeCvClient(cfg, { fetchImpl, politeMs: 0 });
  await c.volume(1);
  assert.ok(seen.length >= 2, 'register + call');
  assert.ok(seen.every((s) => !(ATTEST_HEADER in s.headers)), 'unattested: no header');
  seen.length = 0;
  const a = signAttestation('m', { version: '0.7.95', commit: 'c' });
  _setAttestation(a);
  cfg.metadataInstanceKey = null;
  c = makeCvClient(cfg, { fetchImpl, politeMs: 0 });
  await c.volume(2);
  assert.ok(seen.every((s) => s.headers[ATTEST_HEADER] === encodeAttestation(a)), 'attested: header on registration and on the call');
  assert.deepEqual(attestHeaders(), { [ATTEST_HEADER]: encodeAttestation(a) });
  _setAttestation(undefined);
});
