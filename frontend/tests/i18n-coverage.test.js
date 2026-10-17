// Every sentence a person reads must come from the catalog. scripts/i18n-scan
// finds English left in templates, attributes and the usual string-bearing
// calls (toasts, dialogs); this fails on anything found in a file that has
// been converted. Files still waiting their turn are listed in PENDING; a
// file that turns up clean must be removed from it, so the list only ever
// shrinks.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scanFile, allFiles, SRC } from '../scripts/i18n-scan.mjs';

// Components not yet moved to the catalog. Remove a file here when it is done.
export const PENDING = new Set([]);

describe('UI text comes from the catalog', () => {
  const files = allFiles();
  test('converted files carry no hardcoded sentences', () => {
    const hits = files.filter((f) => !PENDING.has(f)).flatMap(scanFile);
    expect(hits, 'Move these strings into src/locales/en/*.json:\n' + hits.join('\n')).toEqual([]);
  });
  test('PENDING lists only files that still have work', () => {
    const clean = [...PENDING].filter((f) => files.includes(f) && scanFile(f).length === 0);
    expect(clean, 'Remove these from PENDING; they are already clean').toEqual([]);
    const gone = [...PENDING].filter((f) => !files.includes(f));
    expect(gone, 'Remove these from PENDING; the files no longer exist').toEqual([]);
  });
  test('every catalog file is valid JSON with string or plural-object values', () => {
    const dir = path.join(SRC, 'locales');
    for (const lang of fs.readdirSync(dir)) {
      for (const f of fs.readdirSync(path.join(dir, lang))) {
        const data = JSON.parse(fs.readFileSync(path.join(dir, lang, f), 'utf8'));
        const walk = (node, p) => {
          for (const [k, v] of Object.entries(node)) {
            if (typeof v === 'string') continue;
            if (v && typeof v === 'object') {
              if ('other' in v || 'one' in v) { for (const x of Object.values(v)) expect(typeof x, `${lang}/${f} ${p}${k}`).toBe('string'); }
              else walk(v, `${p}${k}.`);
              continue;
            }
            throw new Error(`${lang}/${f}: ${p}${k} is not a string`);
          }
        };
        walk(data, '');
      }
    }
  });
  test('every translation keeps the English placeholders and inline tags', () => {
    const dir = path.join(SRC, 'locales');
    const flat = (node, p = '', out = {}) => {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string' || (v && ('other' in v || 'one' in v))) out[p + k] = v;
        else flat(v, p + k + '.', out);
      }
      return out;
    };
    const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
    const tags = (s) => (String(s).match(/<\/?(b|i|em|strong|code|br|kbd)>/g) || []).length;
    const sample = (v) => (typeof v === 'string' ? v : (v.other ?? v.one));
    const bad = [];
    for (const lang of fs.readdirSync(dir)) {
      if (lang === 'en') continue;
      for (const f of fs.readdirSync(path.join(dir, lang))) {
        const en = flat(JSON.parse(fs.readFileSync(path.join(dir, 'en', f), 'utf8')));
        const tr = flat(JSON.parse(fs.readFileSync(path.join(dir, lang, f), 'utf8')));
        for (const [k, v] of Object.entries(tr)) {
          if (!(k in en)) continue;
          const e = sample(en[k]), t = sample(v);
          if (ph(e) !== ph(t) || tags(e) !== tags(t)) bad.push(`${lang}/${f} ${k}`);
          if (typeof v === 'object') for (const form of Object.values(v)) if (ph(form) !== ph(e)) bad.push(`${lang}/${f} ${k} (plural form)`);
        }
      }
    }
    expect(bad, 'These translations lost or changed a {placeholder} or an inline tag').toEqual([]);
  });
  test('every other language only has keys English has', () => {
    const dir = path.join(SRC, 'locales');
    const flat = (node, p = '', out = {}) => {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string' || (v && ('other' in v || 'one' in v))) out[p + k] = v;
        else flat(v, p + k + '.', out);
      }
      return out;
    };
    const enDir = path.join(dir, 'en');
    for (const lang of fs.readdirSync(dir)) {
      if (lang === 'en') continue;
      for (const f of fs.readdirSync(path.join(dir, lang))) {
        const enFile = path.join(enDir, f);
        expect(fs.existsSync(enFile), `${lang}/${f} has no English counterpart`).toBe(true);
        const enKeys = new Set(Object.keys(flat(JSON.parse(fs.readFileSync(enFile, 'utf8')))));
        const extra = Object.keys(flat(JSON.parse(fs.readFileSync(path.join(dir, lang, f), 'utf8')))).filter((k) => !enKeys.has(k));
        expect(extra, `${lang}/${f} has keys English lacks`).toEqual([]);
      }
    }
  });
});
