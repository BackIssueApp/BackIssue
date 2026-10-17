// ---- Translations: the reactive side ----------------------------------------
// Every string a person reads in the UI comes from a catalog under
// src/locales/<lang>/<namespace>.json, looked up with t('namespace.key').
// English is the source of truth and ships in the main bundle; every other
// language is its own lazy chunk, loaded once when it is picked.
//
// The lookup engine lives in i18n.js (no Svelte/Vite dependency). This module
// loads the catalogs, picks the language, and makes t() reactive: templates
// and $derived blocks that call it re-run when the language changes. Plugin
// UIs render plain DOM, so switching the language in-app ends with a reload
// (see ProfilePage); the reactivity mostly serves sign-in without a reload.
import * as core from './i18n.js';

const enModules = import.meta.glob('../locales/en/*.json', { eager: true, import: 'default' });
// Lazy: one import per file; a language's files are loaded together on pick.
const otherModules = import.meta.glob(['../locales/*/*.json', '!../locales/en/*.json'], { import: 'default' });

const nsOf = (file) => file.split('/').pop().replace(/\.json$/, '');
const langOf = (file) => file.split('/').slice(-2, -1)[0];

function assemble(entries) {
  const out = {};
  for (const [file, messages] of entries) out[nsOf(file)] = messages;
  return out;
}
const enCatalog = assemble(Object.entries(enModules));

// Languages with a catalog on disk, English first, the rest alphabetically.
const found = new Set(Object.keys(otherModules).map(langOf));
export const LANGUAGES = [core.FALLBACK, ...[...found].sort()];

const STORAGE_KEY = 'lang';

// The reactive part is just the language and a version counter that t()
// reads; catalogs themselves are plain objects swapped wholesale.
const state = $state({ lang: core.FALLBACK, version: 0 });
core.configure({
  en: enCatalog,
  languages: LANGUAGES,
  isDev: !!import.meta.env?.DEV,
  notify: () => { state.lang = core.currentLang(); state.version++; },
});

export const i18n = { get lang() { return state.lang; } };
export const { FALLBACK, currentLang, matchLanguage, addMessages, _setCatalogForTests } = core;

export function t(key, params) { void state.version; return core.t(key, params); }
export function th(key, params) { void state.version; return core.th(key, params); }
export function hasMessage(key) { void state.version; return core.hasMessage(key); }
/** Server-sent text (labels, descriptions) shown in the reader's language when
 *  the catalog knows its English; see i18n.js serverText. */
export function st(ns, text) { void state.version; return core.serverText(ns, text); }

/** A role's display name: built-in roles from the catalog, custom roles as
 *  their admin named them (label, else the id). */
export function roleName(id, label) {
  void state.version;
  return core.hasMessage('roles.' + id) ? core.t('roles.' + id) : (label || id || '');
}

/** The language's own name for itself ("Deutsch"), for pickers. */
export function languageName(code) {
  try {
    const n = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    return n ? n.charAt(0).toLocaleUpperCase(code) + n.slice(1) : code;
  } catch { return code; }
}

/** Where the language comes from, in order: the signed-in user's saved
 *  preference (inlined by the server shell), this browser's last choice, the
 *  browser's languages, English. */
export function detectLanguage() {
  if (typeof window !== 'undefined') {
    const fromServer = core.matchLanguage(window.__BI_LANG__);
    if (fromServer) return fromServer;
    const stored = core.matchLanguage(storedLanguage());
    if (stored) return stored;
    const m = core.matchLanguage(navigator.languages || [navigator.language]);
    if (m) return m;
  }
  return core.FALLBACK;
}

async function loadCatalog(lang) {
  if (lang === core.FALLBACK) return enCatalog;
  const files = Object.keys(otherModules).filter((f) => langOf(f) === lang);
  const entries = await Promise.all(files.map(async (f) => [f, await otherModules[f]()]));
  return assemble(entries);
}

// Plugin catalogs: the shell inlines English plus the account's saved
// language (window.__BI_PLUGIN_MESSAGES__); any other language is fetched.
// Added after the language is active, since addMessages() keeps only English
// and the active language.
async function pullPluginMessages(lang) {
  if (typeof window === 'undefined') return;
  const inline = window.__BI_PLUGIN_MESSAGES__;
  if (inline && (lang === core.FALLBACK || inline[lang])) { core.addMessages(inline); return; }
  try {
    const r = await fetch('/api/i18n/plugins?lang=' + encodeURIComponent(lang));
    if (r.ok) core.addMessages(await r.json());
  } catch { /* offline, or the login page: plugins do not render there */ }
}

/** Load and activate a language. Unknown codes fall back to English. */
export async function setLanguage(code) {
  const lang = core.matchLanguage(code) || core.FALLBACK;
  core.activate(lang, await loadCatalog(lang));
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  await pullPluginMessages(lang);
  return lang;
}

/** This browser's remembered choice ('' when none). */
export function storedLanguage() {
  try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}

/** Remember this browser's choice (also used before sign-in and in open mode). */
export function rememberLanguage(code) {
  try {
    if (code) localStorage.setItem(STORAGE_KEY, code);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage blocked */ }
}

/** Called once before the app mounts, so the first paint is already in the
 *  right language (no English flash). */
export async function initI18n() {
  return setLanguage(detectLanguage());
}
