// Release attestation: a small signed statement baked into official images at
// build time ("this is BackIssue <version>, built from <commit> on <date>").
// The metadata service reads it when an instance registers (and on every
// call after) to decide the instance's tier. Builds from source carry no
// signature — they still work, on the limited tier — and nothing here ever
// involves the user.
//
// Keys: the CI master secret never leaves CI and the service. Each release
// signs with a key DERIVED from the master and the version, so one release's
// key unlocks only that release and any version can be revoked on its own.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ATTEST_HEADER = 'X-BackIssue-Attest';

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');
const message = (a) => `${a.version}|${a.commit}|${a.built_at}|${a.channel}`;

/** Per-release signing key: HMAC(master, "release:<version>"). */
export function releaseKey(master, version) {
  return crypto.createHmac('sha256', String(master)).update(`release:${version}`).digest();
}

/** Sign { version, commit, built_at, channel } with the master secret. */
export function signAttestation(master, { version, commit = '', built_at = new Date().toISOString(), channel = 'release' }) {
  if (!master) throw new Error('attestation: master key required');
  if (!version) throw new Error('attestation: version required');
  const a = { v: 1, version: String(version), commit: String(commit || ''), built_at: String(built_at), channel: String(channel || 'release') };
  a.sig = crypto.createHmac('sha256', releaseKey(master, a.version)).update(message(a)).digest('hex');
  return a;
}

/** Verify an attestation object. Returns { ok, reason? }. */
export function verifyAttestation(master, a, { maxAgeDays = 180, revoked = [], now = Date.now() } = {}) {
  if (!master) return { ok: false, reason: 'no master key' };
  if (!a || typeof a !== 'object' || a.v !== 1) return { ok: false, reason: 'malformed' };
  for (const k of ['version', 'commit', 'built_at', 'channel', 'sig']) if (typeof a[k] !== 'string') return { ok: false, reason: `missing ${k}` };
  if (!/^\d+\.\d+\.\d+(?:[-.][\w.]+)?$/.test(a.version)) return { ok: false, reason: 'bad version' };
  const expected = crypto.createHmac('sha256', releaseKey(master, a.version)).update(message(a)).digest('hex');
  const got = a.sig.toLowerCase();
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(expected, 'utf8'))) return { ok: false, reason: 'bad signature' };
  if (revoked.includes(a.version)) return { ok: false, reason: 'revoked' };
  const built = Date.parse(a.built_at);
  if (!Number.isFinite(built)) return { ok: false, reason: 'bad date' };
  if (built > now + 24 * 3600 * 1000) return { ok: false, reason: 'future date' };
  if (maxAgeDays > 0 && now - built > maxAgeDays * 86400 * 1000) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/** The header value: base64url of the attestation JSON. */
export const encodeAttestation = (a) => b64url(JSON.stringify(a));
export function decodeAttestation(value) {
  try { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); } catch { return null; }
}

// The image's own attestation, read once. Absent (a source checkout or a
// local build) → null, and no header is sent.
let loaded;
export function loadAttestation() {
  if (loaded !== undefined) return loaded;
  loaded = null;
  const file = process.env.BACKISSUE_BUILD_FILE || path.join(repoRoot, 'build.json');
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (a && a.v === 1 && typeof a.sig === 'string' && a.sig) loaded = a;
  } catch { /* none */ }
  return loaded;
}
/** Tests swap the cached attestation. */
export function _setAttestation(a) { loaded = a === undefined ? undefined : a; }

/** Headers to add to metadata-service requests (empty when unattested). */
export function attestHeaders() {
  const a = loadAttestation();
  return a ? { [ATTEST_HEADER]: encodeAttestation(a) } : {};
}
