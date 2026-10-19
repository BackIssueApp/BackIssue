// Every error message the server can show a person has an entry in the errors
// catalog, so it reaches them in their own language (serverText matches the
// English exactly, or up to a trailing "{detail}"). New messages fail this test
// until they're catalogued in all languages. Messages only a developer can
// trigger are listed below instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configure, activate, translateServerMessage } from '../frontend/src/lib/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = path.join(ROOT, 'frontend', 'src', 'locales');
const catalog = (lang) => JSON.parse(fs.readFileSync(path.join(LOCALES, lang, 'errors.json'), 'utf8'));

// Raised only by programming mistakes, plugin authors, or internals that never
// reach a response body (or carry nothing worth translating).
const DEVELOPER_ONLY = new Set([
  'missing', 'Error', 'HTTP {detail}', 'page {detail}', 'no fixture for {detail}',
  'attestation: master key required', 'attestation: version required', 'count worker gone', 'archive reader unavailable',
  'downloadMedia needs a db', 'downloadMedia needs a title',
  'registerSource: a source needs an id', 'registerLibraryType: a type needs an id',
  'defineSource: a source needs an id (letters, digits, underscore)', 'defineSource({detail}',
  'external identity requires provider and subject',
]);

function serverMessages() {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const out = new Map();
  for (const f of walk(path.join(ROOT, 'src'))) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const where = `${path.relative(ROOT, f)}:${i + 1}`;
      for (const m of line.matchAll(/(?:error:\s*|new Error\(|rateLimitError\()(['"`])((?:\\.|(?!\1).)*)\1/g)) {
        let msg = m[2];
        if (msg.includes('${')) msg = msg.slice(0, msg.indexOf('${')) + '{detail}';
        if (!msg || msg === '{detail}') continue;
        msg = msg.replace(/\\(['"`\\])/g, '$1');
        if (!out.has(msg)) out.set(msg, where);
      }
    });
  }
  return out;
}

test('every user-facing server error message is in the errors catalog', () => {
  const known = Object.values(catalog('en'));
  const covered = (msg) => {
    const probe = msg.endsWith('{detail}') ? msg.slice(0, -'{detail}'.length) : msg;
    return known.some((en) => en === msg || en === probe || (en.endsWith('{detail}') && probe.startsWith(en.slice(0, -'{detail}'.length))));
  };
  const missing = [...serverMessages()].filter(([msg]) => !DEVELOPER_ONLY.has(msg) && !covered(msg)).map(([msg, at]) => `${at}  ${msg}`);
  assert.deepEqual(missing, [], 'add these to frontend/src/locales/*/errors.json');
});

test('every language has every errors key, with {detail} kept where English has it', () => {
  const en = catalog('en');
  for (const lang of fs.readdirSync(LOCALES)) {
    const cat = catalog(lang);
    for (const [k, v] of Object.entries(en)) {
      assert.ok(typeof cat[k] === 'string' && cat[k], `${lang}: errors.${k} missing`);
      assert.equal(cat[k].includes('{detail}'), v.includes('{detail}'), `${lang}: errors.${k} {detail}`);
    }
  }
});

test('a server message with a detail reaches the reader translated', () => {
  configure({ en: { errors: catalog('en') }, languages: [] });
  activate('fr', { errors: catalog('fr') });
  assert.equal(translateServerMessage('folder not found: /comics/x'), 'dossier introuvable : /comics/x');
  assert.equal(translateServerMessage('cancelled by user'), 'annulé par l’utilisateur');
  assert.equal(translateServerMessage('something nobody catalogued'), 'something nobody catalogued');
});
