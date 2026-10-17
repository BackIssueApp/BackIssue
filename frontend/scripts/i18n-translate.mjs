#!/usr/bin/env node
// Drafts translations for every key English has and a language lacks, so a
// new string always ships with a usable first pass in every language. Human
// corrections are never touched: only MISSING keys are filled, and a key
// present in the target file (even if identical to English) is left alone.
//
//   ANTHROPIC_API_KEY=… node scripts/i18n-translate.mjs            # all languages
//   ANTHROPIC_API_KEY=… node scripts/i18n-translate.mjs fr de      # some
//   node scripts/i18n-translate.mjs --check                        # list gaps, no API
//
// Catalog layout: src/locales/<lang>/<namespace>.json. Messages are strings
// or plural objects ({ one, other, … }); placeholders like {name} and the
// inline tags <b> <i> <code> <br> must survive untouched, and the model is
// told so. Output is written with the same key order as English.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');
const MODEL = process.env.I18N_MODEL || 'claude-sonnet-5-5';
const NAMES = { fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese (European)', nl: 'Dutch', pl: 'Polish', sv: 'Swedish', da: 'Danish', nb: 'Norwegian Bokmål', fi: 'Finnish', cs: 'Czech', tr: 'Turkish', ja: 'Japanese', ko: 'Korean', 'zh-hans': 'Simplified Chinese', 'pt-br': 'Brazilian Portuguese' };
// Plural categories each language actually uses (CLDR cardinal); the model
// is asked for exactly these so a French file never carries a useless "few".
const PLURALS = { fr: ['one', 'other'], de: ['one', 'other'], es: ['one', 'other'], it: ['one', 'other'], pt: ['one', 'other'], nl: ['one', 'other'], pl: ['one', 'few', 'many', 'other'], cs: ['one', 'few', 'many', 'other'], ja: ['other'], ko: ['other'], 'zh-hans': ['other'] };

const args = process.argv.slice(2);
const check = args.includes('--check');
const wanted = args.filter((a) => !a.startsWith('--'));
const langs = wanted.length ? wanted : fs.readdirSync(ROOT).filter((d) => d !== 'en' && fs.statSync(path.join(ROOT, d)).isDirectory());

const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
const isPlural = (v) => v && typeof v === 'object' && ('one' in v || 'other' in v);
// Flatten nested namespaces to dotted keys; plural objects stay whole.
function flatten(node, p = '', out = {}) {
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' || isPlural(v)) out[p + k] = v;
    else if (v && typeof v === 'object') flatten(v, p + k + '.', out);
  }
  return out;
}
function unflatten(flat, order) {
  const out = {};
  for (const key of order) {
    if (!(key in flat)) continue;
    const parts = key.split('.');
    let node = out;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = flat[key];
  }
  return out;
}

async function translateBatch(lang, items) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const forms = PLURALS[lang] || ['one', 'other'];
  const system = `You translate user-interface strings for BackIssue, a self-hosted comic, ebook and audiobook library manager, from English into ${NAMES[lang] || lang}.
Rules:
- Keep every {placeholder} exactly as written (same name, same braces). Keep inline tags <b> <i> <em> <strong> <code> <br> and their content positions sensible. Keep leading/trailing punctuation and the ellipsis character.
- Use the informal/neutral register typical of modern software UI in the target language (French "vous", German "du" is NOT used: use the impersonal/infinitive style common in German UIs, Spanish "tú" neutral, Dutch "je").
- Keep "BackIssue" and product names (Discord, Telegram, Docker, Prowlarr, qBittorrent, SABnzbd, OPDS) untranslated. Never add the name of any metadata database.
- Comic vocabulary: "issue" = the single comic number (fr: numéro, de: Heft, es: número, it: albo/numero, pt: edição, nl: nummer); "series"/"volume" = the title run; "reading list" = curated list; "wanted" = issues still missing from the library; "library" = the user's collection.
- Plural objects: return an object with exactly these forms for this language: ${forms.join(', ')}. Each form must contain {count} if the English did.
- Match the length and tone; buttons stay short. Sentence case, as in English.
Respond with ONLY a JSON object mapping each input key to its translation (string, or plural object). No commentary.`;
  const body = {
    model: MODEL, max_tokens: 8000, system,
    messages: [{ role: 'user', content: JSON.stringify(items) }],
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const text = (data.content || []).map((c) => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in response');
  return JSON.parse(m[0]);
}

// A translation that lost a placeholder or a tag is worse than none: the
// English stays and the key is reported.
function sane(en, tr) {
  const check1 = (a, b) => {
    const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
    const tags = (s) => (String(s).match(/<\/?(b|i|em|strong|code|br)>/g) || []).length;
    return ph(a) === ph(b) && tags(a) === tags(b);
  };
  if (typeof en === 'string') return typeof tr === 'string' && tr.trim() && check1(en, tr);
  if (!tr || typeof tr !== 'object') return false;
  return Object.values(tr).every((v) => typeof v === 'string' && v.trim() && check1(en.other ?? en.one, v));
}

let totalGaps = 0;
for (const lang of langs) {
  const dir = path.join(ROOT, lang);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(path.join(ROOT, 'en')).filter((f) => f.endsWith('.json'))) {
    const en = flatten(readJson(path.join(ROOT, 'en', file)));
    const target = path.join(dir, file);
    const have = flatten(readJson(target));
    const order = Object.keys(en);
    const gaps = Object.fromEntries(order.filter((k) => !(k in have)).map((k) => [k, en[k]]));
    const n = Object.keys(gaps).length;
    totalGaps += n;
    if (!n) continue;
    if (check) { console.log(`${lang}/${file}: ${n} missing`); continue; }
    console.log(`${lang}/${file}: translating ${n}…`);
    const keys = Object.keys(gaps);
    const filled = { ...have };
    for (let i = 0; i < keys.length; i += 60) {
      const slice = Object.fromEntries(keys.slice(i, i + 60).map((k) => [k, gaps[k]]));
      let out = {};
      try { out = await translateBatch(lang, slice); }
      catch (e) { console.error(`  batch failed: ${e.message}`); continue; }
      for (const k of Object.keys(slice)) {
        if (sane(slice[k], out[k])) filled[k] = out[k];
        else console.warn(`  kept English for ${k} (bad placeholder/tag or missing)`);
      }
    }
    // Drop keys English no longer has, keep English order.
    fs.writeFileSync(target, JSON.stringify(unflatten(filled, order), null, 2) + '\n');
  }
}
if (check) { console.log(totalGaps ? `${totalGaps} missing translation(s)` : 'complete'); process.exit(totalGaps ? 1 : 0); }
