// ---- Translations: the catalog engine -------------------------------------
// Plain JavaScript with no Svelte or Vite dependency, so helpers (util.js) and
// the server-side test suite can import it directly. The reactive wrapper in
// i18n.svelte.js feeds it the catalogs and re-renders on change; components
// import from THAT module, never this one.
//
// Message format (kept deliberately small — no library):
//   "Saved {name}."                         → named params: t(k, { name })
//   { "one": "{count} file", "other": "{count} files" }
//                                           → plural forms picked by the
//                                             browser's CLDR rules on `count`
// A key missing in the active language falls back to English; a key missing
// in English too renders as the key itself (and warns in dev), so a gap is
// visible rather than blank.

export const FALLBACK = 'en';

let enCatalog = {};
let messages = enCatalog;
let lang = FALLBACK;
let languages = [FALLBACK];
let onChange = () => {};
let dev = false;

/** Wire up the catalogs (done once by i18n.svelte.js at import). */
export function configure({ en, languages: list, notify, isDev } = {}) {
  if (en) { enCatalog = en; if (messages === undefined || lang === FALLBACK) messages = en; }
  if (Array.isArray(list) && list.length) languages = list;
  if (typeof notify === 'function') onChange = notify;
  dev = !!isDev;
}

/** Make a loaded catalog the active one. */
export function activate(code, catalog) {
  lang = code;
  messages = catalog;
  onChange();
}

/** Non-reactive read of the active language code. */
export const currentLang = () => lang;
/** Codes with a catalog, English first. */
export const languageList = () => languages;

/** Match a BCP 47 tag (or list of them) to a catalog we have: exact, then base
 *  language ("pt-BR" → "pt"). Returns null when nothing matches. */
export function matchLanguage(tags) {
  for (const raw of Array.isArray(tags) ? tags : [tags]) {
    const tag = String(raw || '').toLowerCase();
    if (!tag) continue;
    if (languages.includes(tag)) return tag;
    const base = tag.split('-')[0];
    if (languages.includes(base)) return base;
  }
  return null;
}

// ---- lookup ----------------------------------------------------------------

function lookup(catalog, key) {
  let node = catalog;
  for (const part of String(key).split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

const warned = new Set();
function missing(key) {
  if (dev && !warned.has(key)) {
    warned.add(key);
    console.warn(`i18n: no message for "${key}"`);
  }
  return key;
}

const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
const isPlural = (m) => m && typeof m === 'object' && PLURAL_FORMS.some((f) => f in m);
const rulesCache = new Map();
function pluralRules(code) {
  if (!rulesCache.has(code)) {
    try { rulesCache.set(code, new Intl.PluralRules(code)); }
    catch { rulesCache.set(code, new Intl.PluralRules(FALLBACK)); }
  }
  return rulesCache.get(code);
}

function pickForm(forms, count, code) {
  if (count === undefined || count === null) return forms.other ?? forms.one ?? '';
  const n = Number(count);
  // An explicit zero form reads better than CLDR's "other" for empty states in
  // languages whose rules have no zero category.
  if (n === 0 && forms.zero !== undefined) return forms.zero;
  const cat = pluralRules(code).select(n);
  return forms[cat] ?? forms.other ?? forms.one ?? '';
}

function interpolate(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined || params[name] === null ? m : String(params[name])));
}

/** Translate a key. `params.count` selects a plural form; every param is
 *  available as {name} in the message. */
export function t(key, params) {
  let code = lang;
  let msg = lookup(messages, key);
  if (msg === undefined && messages !== enCatalog) { msg = lookup(enCatalog, key); code = FALLBACK; }
  if (msg === undefined) return missing(key);
  if (typeof msg === 'object' && msg !== null) {
    if (!isPlural(msg)) return missing(key); // a namespace, not a message
    msg = pickForm(msg, params?.count, code);
  }
  return interpolate(String(msg), params);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TOKEN = (name) => `\u0000${name}\u0000`;

/** Translate for innerHTML: the message is escaped, then a small inline subset
 *  (<b> <i> <em> <strong> <code> <br>) is let through; params are always
 *  escaped. Lets a sentence keep its emphasis without trusting the catalog. */
export function th(key, params) {
  const tokens = params ? Object.fromEntries(Object.keys(params).map((k) => [k, TOKEN(k)])) : undefined;
  let html = esc(t(key, tokens)).replace(/&lt;(\/?)(b|i|em|strong|code|br|kbd)&gt;/g, '<$1$2>');
  if (params) for (const [k, v] of Object.entries(params)) html = html.split(TOKEN(k)).join(esc(v ?? ''));
  return html;
}

/** True when a key exists in the active language or English. Lets a plugin
 *  pass either a key or a literal label and have core show the right thing. */
export function hasMessage(key) {
  const m = lookup(messages, key) ?? lookup(enCatalog, key);
  return m !== undefined && (typeof m !== 'object' || isPlural(m));
}

/** Add messages at runtime (plugins ship their own catalogs). `catalogs` is
 *  { lang: { namespace: { key: message } } }; existing keys are kept when a
 *  plugin tries to overwrite a core namespace. Returns true when anything
 *  was added. */
export function addMessages(catalogs) {
  let changed = false;
  for (const [code, byNs] of Object.entries(catalogs || {})) {
    const target = code === FALLBACK ? enCatalog : (code === lang ? messages : null);
    if (!target || !byNs || typeof byNs !== 'object') continue;
    for (const [ns, extra] of Object.entries(byNs)) {
      if (!extra || typeof extra !== 'object') continue;
      target[ns] = { ...extra, ...(target[ns] || {}) };
      changed = true;
    }
  }
  if (changed) onChange();
  return changed;
}

// ---- server messages -------------------------------------------------------
// The API answers with English text in { error }. Rather than teach every
// route a code, the client recognises the English of the messages listed in
// the errors namespace and shows the translation; anything unknown (plugin
// errors, upstream detail) passes through unchanged. A message ending in
// {detail} matches by prefix and carries the rest as the param.
let reverse = null, reverseFor = null;
function reverseMap() {
  const errors = enCatalog.errors || {};
  if (reverse && reverseFor === errors && reverse.size === Object.keys(errors).length) return reverse;
  reverse = new Map();
  reverseFor = errors;
  for (const [key, text] of Object.entries(errors)) if (typeof text === 'string') reverse.set(text, key);
  return reverse;
}
export function translateServerMessage(msg) {
  if (typeof msg !== 'string' || !msg) return msg;
  const map = reverseMap();
  const exact = map.get(msg);
  if (exact) return t('errors.' + exact);
  for (const [text, key] of map) {
    if (!text.endsWith('{detail}')) continue;
    const prefix = text.slice(0, -'{detail}'.length);
    if (msg.startsWith(prefix)) return t('errors.' + key, { detail: msg.slice(prefix.length) });
  }
  return msg;
}

/** Testing hook: swap the active catalog without touching any loader. */
export function _setCatalogForTests(code, catalog) {
  activate(code, catalog);
}
