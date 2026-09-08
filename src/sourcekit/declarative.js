// Sites described with selectors instead of code.
//
// Most download sites are a search page of result rows and a post page with a
// download link (or, for manga, a reader page of <img> tags). Writing that as
// JavaScript every time is the boilerplate this removes: a definition gives
// a search URL template and a handful of selectors, and search()/resolve()
// are generated. A site that needs real logic still writes the functions —
// the two can be mixed freely, since a function always wins over selectors.
//
// Selector syntax: `.css` takes the element's text; `.css@attr` takes an
// attribute (`@href` and `@src` are resolved against the page URL); a
// trailing `|<regex>` keeps the first capture group. Examples:
//   title: 'h2 a'                     → the link text
//   url:   'h2 a@href'                → absolute link target
//   size:  '.meta|([\\d.]+\\s*[KMG]B)'  → "38 MB" out of "Year: 2013 · 38 MB"

const SIZE_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

/** "38 MB" / "1.4GB" → bytes; 0 when there is no size in the text. */
export function parseSize(text) {
  const m = /([\d.]+)\s*(TB|GB|MB|KB|B)\b/i.exec(String(text || ''));
  if (!m) return 0;
  return Math.round(Number(m[1]) * (SIZE_UNITS[m[2].toLowerCase()] || 1));
}

/** The first 4-digit year in the text, or null. */
export function parseYear(text) {
  const m = /\b(19|20)\d{2}\b/.exec(String(text || ''));
  return m ? m[0] : null;
}

/** Read one selector spec against a cheerio root/element → string or null. */
export function pick($, el, spec, baseUrl = '') {
  if (!spec) return null;
  const [sel, rx] = String(spec).split('|', 2);
  const [css, attr] = sel.split('@', 2);
  const node = css.trim() ? (el ? $(el).find(css.trim()).first() : $(css.trim()).first()) : $(el);
  if (!node || !node.length) return null;
  let v = attr ? node.attr(attr.trim()) : node.text();
  v = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!v) return null;
  if (rx) {
    const m = new RegExp(rx).exec(v);
    v = m ? (m[1] ?? m[0]) : '';
    if (!v) return null;
  }
  if (attr && /^(href|src|data-src|data-original)$/i.test(attr.trim()) && baseUrl) {
    try { return new URL(v, baseUrl).href; } catch { return v; }
  }
  return v;
}

/** Every value for a repeated selector (page images, download mirrors). */
export function pickAll($, spec, baseUrl = '') {
  if (!spec) return [];
  const [sel, rx] = String(spec).split('|', 2);
  const [css, attr] = sel.split('@', 2);
  return $(css.trim()).map((_, el) => {
    let v = attr ? $(el).attr(attr.trim()) : $(el).text();
    v = String(v ?? '').trim();
    if (!v) return null;
    if (rx) { const m = new RegExp(rx).exec(v); v = m ? (m[1] ?? m[0]) : ''; if (!v) return null; }
    if (attr && baseUrl) { try { v = new URL(v, baseUrl).href; } catch { /* keep as-is */ } }
    return v;
  }).get().filter(Boolean);
}

/** Fill {query} / {page} in a URL template (query is percent-encoded). */
export function fillTemplate(tpl, { query = '', page = 1 } = {}) {
  return String(tpl)
    .replace(/\{query\}/g, encodeURIComponent(query))
    .replace(/\{query:raw\}/g, query)
    .replace(/\{page\}/g, String(page));
}

/** search() from `searchPath` + `select`. */
export function buildSearch(def) {
  const s = def.select || {};
  return async function search(query, ctx, kit) {
    const url = kit.url(fillTemplate(def.searchPath || '/?s={query}', { query }));
    const $ = kit.load(await kit.http.html(url));
    const rows = s.row ? $(s.row).get() : [];
    return rows.map((el) => {
      const title = pick($, el, s.title, url);
      const href = pick($, el, s.url, url);
      if (!title || !href) return null;
      const sizeText = pick($, el, s.size, url);
      return {
        title, url: href,
        size: s.size ? parseSize(sizeText) : 0,
        year: s.year ? parseYear(pick($, el, s.year, url)) : parseYear(title),
        number: s.number ? pick($, el, s.number, url) : undefined,
        series: s.series ? pick($, el, s.series, url) : undefined,
        cover: s.cover ? pick($, el, s.cover, url) : undefined,
      };
    }).filter(Boolean);
  };
}

/** resolve() from `select.link` (archive sites) or `select.pages` (readers). */
export function buildResolve(def) {
  const s = def.select || {};
  return async function resolve(candidate, ctx, kit) {
    const $ = kit.load(await kit.http.html(candidate.url));
    if (def.kind === 'pages') {
      const pages = pickAll($, s.pages, candidate.url);
      if (!pages.length) throw Object.assign(new Error(`no page images found on ${candidate.url}`), { noRetry: true });
      return { pages, referer: candidate.url };
    }
    const links = pickAll($, s.link, candidate.url).map((url) => ({ url }));
    if (!links.length) throw Object.assign(new Error(`no download link found on ${candidate.url}`), { noRetry: true });
    return { links, referer: candidate.url };
  };
}
