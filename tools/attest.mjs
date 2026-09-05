#!/usr/bin/env node
// Writes the image's release attestation (build.json) to stdout.
// Run by the Dockerfile with the CI signing secret mounted:
//   RUN --mount=type=secret,id=attest_key node tools/attest.mjs > build.json
// Without the secret (a source or local build) it prints {} — the app then
// sends no attestation and runs on the metadata service's limited tier.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signAttestation } from '../src/attest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretFile = process.argv[2] || '/run/secrets/attest_key';
let master = process.env.ATTEST_KEY || '';
if (!master) { try { master = fs.readFileSync(secretFile, 'utf8').trim(); } catch { /* absent */ } }
if (!master) { process.stdout.write('{}\n'); process.exit(0); }
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const a = signAttestation(master, {
  version,
  commit: (process.env.BUILD_SHA || '').slice(0, 40),
  built_at: new Date().toISOString(),
  channel: process.env.BUILD_CHANNEL || 'release',
});
process.stdout.write(JSON.stringify(a) + '\n');
