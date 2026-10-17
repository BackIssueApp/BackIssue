#!/usr/bin/env node
// Finds English left in the UI sources: text nodes and human-readable
// attributes in Svelte templates, and string literals handed to toasts,
// dialogs and label maps in scripts. The coverage test runs it over every
// file; run it by hand on the files you are converting:
//   node scripts/i18n-scan.mjs components/SettingsPage.svelte lib/store.svelte.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Text that is fine untranslated: the brand, symbols, units, codes.
const ALLOWED = new Set(['BACKISSUE', 'BackIssue', 'OK', 'API', 'ID', 'URL', 'QR', 'SSO', 'CBZ', 'CBR', 'PDF', 'EPUB', 'MB', 'GB', 'KB', 'px', 'vs', 'x', 'X']);
const isWords = (s) => {
  const txt = s.replace(/&[a-z#0-9]+;/gi, ' ').trim();
  if (!/[A-Za-z]{2,}/.test(txt)) return false;
  const tokens = txt.split(/[\s/|,.;:()!?'"“”‘’]+/).filter(Boolean);
  return tokens.some((w) => /[A-Za-z]{2,}/.test(w) && !ALLOWED.has(w));
};

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

export function scanFile(rel) {
  const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
  const hits = [];
  const add = (idx, text) => hits.push(`${rel}:${lineOf(src, idx)}: ${text.trim().slice(0, 70)}`);

  if (rel.endsWith('.svelte')) {
    // Template: blank out script/style/comments (keep offsets), drop expressions.
    const blank = (m) => m.replace(/[^\n]/g, ' ');
    let tpl = src.replace(/<script[\s\S]*?<\/script>/g, blank).replace(/<style[\s\S]*?<\/style>/g, blank).replace(/<!--[\s\S]*?-->/g, blank);
    // Replace expressions with spaces of equal length so indexes still map to lines.
    let depth = 0, buf = '';
    for (const ch of tpl) {
      if (ch === '{') { depth++; buf += ' '; continue; }
      if (ch === '}') { depth = Math.max(0, depth - 1); buf += ' '; continue; }
      buf += depth ? (ch === '\n' ? '\n' : ' ') : ch;
    }
    tpl = buf;
    // Text nodes.
    const textRe = />([^<]+)</g;
    let m;
    while ((m = textRe.exec(tpl))) if (isWords(m[1])) add(m.index + 1, m[1]);
    // Human-readable attributes.
    const attrRe = /\b(title|placeholder|aria-label|aria-description|alt|label|data-tip)\s*=\s*"([^"]*)"/g;
    while ((m = attrRe.exec(tpl))) if (isWords(m[2])) add(m.index, `${m[1]}="${m[2]}"`);
  }

  // Script (and plain .js): literals handed to toasts and dialogs, labels maps.
  const script = rel.endsWith('.svelte') ? (src.match(/<script[\s\S]*?<\/script>/g) || []).join('\n') : src;
  const base = rel.endsWith('.svelte') ? src.indexOf(script.split('\n')[0]) : 0;
  const callRe = /\b(notify|confirmDialog|inputDialog|choiceDialog|alertDialog)\(\s*(['"`])((?:(?!\2)[^\\]|\\.)*)\2/g;
  let m;
  while ((m = callRe.exec(script))) if (isWords(m[3])) add(base + m.index, `${m[1]}(${m[3]})`);
  const propRe = /\b(title|message|confirmLabel|cancelLabel|label|placeholder|hint|help|empty|description)\s*:\s*(['"`])((?:(?!\2)[^\\]|\\.)*)\2/g;
  while ((m = propRe.exec(script))) if (isWords(m[3]) && /\s|^[A-Z]/.test(m[3])) add(base + m.index, `${m[1]}: ${m[3]}`);
  return hits;
}

export function allFiles() {
  const out = ['App.svelte'];
  for (const f of fs.readdirSync(path.join(SRC, 'components'))) if (f.endsWith('.svelte')) out.push('components/' + f);
  for (const f of fs.readdirSync(path.join(SRC, 'lib'))) if (/\.(svelte\.)?js$/.test(f) && f !== 'icons.js') out.push('lib/' + f);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2).length ? process.argv.slice(2).map((f) => f.replace(/\\/g, '/').replace(/^src\//, '')) : allFiles();
  const hits = files.flatMap(scanFile);
  for (const h of hits) console.log(h);
  console.log(hits.length ? `${hits.length} hardcoded string(s)` : 'clean');
  process.exit(hits.length ? 1 : 0);
}
