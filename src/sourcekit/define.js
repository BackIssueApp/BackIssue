// defineSource(def) — a download source from a short site description.
//
// A site plugin used to be several hundred lines: an HTTP layer, Cloudflare
// handling, release scoring, archive sniffing, page assembly, a settings card
// and a test button, with the actual site knowledge buried in the middle.
// Everything but the site knowledge is the same for every site, so it lives
// here. A definition supplies what only the site knows:
//
//   search(query, ctx, kit)    → [{ title, url, size?, year?, number?, series?, … }]
//   resolve(candidate, ctx, kit) → archive kind: { url, referer?, headers?, links? }
//                                  pages kind:   { pages: [url | { url, headers }], referer?, headers? }
//
// and optionally its own find/manualSearch/test/queries when the defaults
// (search each known series name, score with the shared release matcher,
// take the best) do not fit. The result is a normal `registerSource` object,
// plus `card` (the settings card the UI renders) and `settingsFields`.
import config from '../config.js';
import { load } from 'cheerio';
import { normalizeNumber } from '../matcher.js';
import { scoreRelease, normalizeSeries, suspiciouslySmall, autoTarget, manualTarget } from '../sources/usenet.js';
import { isCollectedSeries, collectedQueries } from '../editions.js';
import { logInfo, logWarn } from '../logstore.js';
import { fetchHtml, fetchJson, downloadToBuffer } from './http.js';
import { normalizeArchive } from './bytes.js';
import { fetchPages, pagesToArchive } from './pages.js';
import { buildSearch, buildResolve } from './declarative.js';
import { browserAvailable, browserHtml, browserImage } from './browser.js';

const DEFAULT_TYPES = ['comic', 'manga'];

/** The queries a site's full-text search wants for one series name: the bare
 *  number ("Poison Ivy 46" — sites never index the zero-padded token), the
 *  collected-edition forms for a trade/omnibus, and nothing at all for a
 *  numberless issue. */
export function siteQueries(name, ctx) {
  if (isCollectedSeries({ kind: ctx.cv?.metron_series_type, title: ctx.seriesTitle, names: ctx.seriesNames })) {
    return collectedQueries(name, ctx.issue, normalizeNumber);
  }
  const num = normalizeNumber(ctx.issue?.issue_number);
  return [[name, /^-?\d/.test(num) ? num : ''].filter(Boolean).join(' ').trim()];
}

/**
 * Score a search result against the wanted issue. A result that carries
 * `series` and `number` fields is compared on those (sites with structured
 * listings); otherwise its title is parsed as a release name by the shared
 * matcher. null = not this issue.
 */
export function scoreCandidate(c, target) {
  if (!c) return null;
  if (suspiciouslySmall(c.size)) return null;
  if (c.number != null && (c.series || c.title)) {
    const accepted = (target.names?.length ? target.names : [target.series]).map(normalizeSeries).filter(Boolean);
    if (!accepted.includes(normalizeSeries(c.series || c.title))) return null;
    const want = normalizeNumber(target.number);
    if (want !== '' && normalizeNumber(c.number) !== want) return null;
    let score = 100;
    const wantYear = String(target.year ?? '').match(/\d{4}/);
    if (wantYear && c.year) score += (String(c.year) === wantYear[0] ? 20 : -10);
    return score;
  }
  return scoreRelease(c.title, target);
}

export function pickBest(results, target) {
  const scored = results.map((r) => ({ r, score: scoreCandidate(r, target) })).filter((x) => x.score != null);
  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

function typeOk(def, ctx) {
  const t = String(ctx?.series?.type || '').toLowerCase();
  return !t || (def.types || DEFAULT_TYPES).includes(t);
}

const unique = (arr) => [...new Set(arr.filter(Boolean))];

// A volume carries every name it is known by, and for manga that can be forty
// aliases: one per language, script by script. Searching a site once per name
// is what makes a search take a minute — so SEARCHING is capped here while
// MATCHING still accepts the full list, and an alias hit is as good as ever.
const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\p{Zs}\p{M}]+$/u;

/**
 * The names worth searching a site under: the volume's own title first, then
 * distinct aliases, dropping ones written in a script the site does not index.
 * `max` caps the list (default 4). `script: 'any'` keeps every script — for a
 * site indexed in its own language.
 */
export function searchNames(ctx, { max = 4, script = 'latin' } = {}) {
  const raw = [ctx?.seriesTitle, ...(ctx?.seriesNames || [])].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const n of raw) {
    // Collapse names that differ only in punctuation or case ("One Piece",
    // "one-piece") — they return the same results and cost the same request.
    // The matcher's normaliser keeps only [a-z0-9], so a name in another
    // script normalises to nothing; those dedupe on their own text instead,
    // or every Japanese and Cyrillic alias would look like the same name.
    const key = normalizeSeries(n) || n.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  const kept = script === 'any' ? out : out.filter((n, i) => i === 0 || LATIN_ONLY.test(n));
  return kept.slice(0, Math.max(1, max));
}

/** The per-call helper handed to every definition hook. */
export function makeKit(def, ctx = {}, { session = {}, http = null } = {}) {
  const cfg = ctx?.config || config;
  const id = def.id;
  const siteUrl = String(cfg[`${id}Url`] || def.baseUrl || '').replace(/\/+$/, '');
  // One shared FlareSolverr (Settings → Downloading) serves every source; a
  // per-source key still wins if someone sets one by hand.
  const flareUrl = def.cloudflare ? String(cfg[`${id}FlaresolverrUrl`] || cfg.flaresolverrUrl || '') : '';
  const proxyUrl = def.proxy ? String(cfg[`${id}DownloadProxy`] || '') : '';
  const rateMs = def.rateMs ?? 1000;
  const settings = {};
  for (const key of Object.keys(def.settings || {})) settings[key] = cfg[key] ?? def.settings[key].default ?? null;
  const settingsHint = 'Settings → Downloading';
  // Transport, cheapest first. A site that needs a browser still asks for
  // `kit.http.html` — the definition never branches on which image it runs in.
  //   'required' — straight to the browser (the source is disabled without one).
  //   'fallback' — plain HTTP, then FlareSolverr; the browser only when the
  //                site challenges anyway and one happens to be installed.
  const needsBrowser = def.browser === 'required';
  const mayUseBrowser = needsBrowser || def.browser === 'fallback';
  const htmlViaBrowser = (url, opts = {}) => browserHtml(url, { referer: opts.referer || '', waitFor: opts.waitFor || def.waitFor || null, waitMs: opts.waitMs || 0 });
  const realHttp = {
    html: async (url, opts = {}) => {
      if (needsBrowser) return htmlViaBrowser(url, opts);
      try {
        return await fetchHtml(url, { flareUrl, session, rateMs, settingsHint, ...opts });
      } catch (e) {
        if (!(e?.challenged && mayUseBrowser && browserAvailable())) throw e;
        return htmlViaBrowser(url, opts); // last resort, and only if one is here
      }
    },
    json: (url, opts = {}) => fetchJson(url, { session, rateMs, ...opts }),
    download: (url, opts = {}) => downloadToBuffer(url, { session, rateMs, flareUrl, proxyUrl, ...opts }),
    image: (url, opts = {}) => browserImage(url, opts),
  };
  return {
    id, siteUrl, config: cfg, settings, session, flareUrl, proxyUrl, rateMs,
    http: http || realHttp,
    load,
    url: (p) => (/^https?:\/\//i.test(p) ? p : new URL(p, siteUrl + '/').href),
    log: { info: (m) => logInfo(m, id), warn: (m) => logWarn(m, id) },
    match: { scoreCandidate, pickBest, autoTarget, manualTarget, normalizeSeries, normalizeNumber, suspiciouslySmall, siteQueries },
    /** The names to SEARCH under (capped, see searchNames). Match against
     *  ctx.seriesNames — every alias — not against this shorter list. */
    searchNames: (c = ctx, opts = {}) => searchNames(c, { max: def.maxSearchNames ?? 4, script: def.searchScript || 'latin', ...opts }),
    /** The cached metadata row for a cvissue:<id> queue row, fetching its
     *  detail once (that is where a chapter's site link lives). */
    async issueDetail(issue = ctx.issue) {
      const cvIssueId = Number((/^cvissue:(\d+)$/.exec(String(issue?.url || '')) || [])[1]);
      if (!cvIssueId || !ctx.db) return null;
      const { ensureCvIssueDetail } = await import('../metatagger.js');
      const { makeCvClient } = await import('../cv.js');
      return ensureCvIssueDetail(ctx.db, makeCvClient(cfg), cvIssueId);
    },
  };
}

function fieldSpec(f) {
  const type = ['bool', 'int', 'string'].includes(f?.type) ? f.type : 'string';
  const spec = { type };
  if (type === 'string') spec.allowEmpty = f.allowEmpty !== false;
  if (type === 'int') { if (f.min != null) spec.min = f.min; if (f.max != null) spec.max = f.max; }
  return spec;
}

export function defineSource(rawDef) {
  if (!rawDef?.id || !/^[a-z][a-z0-9_]*$/i.test(rawDef.id)) throw new Error('defineSource: a source needs an id (letters, digits, underscore)');
  // A site described with selectors gets its search()/resolve() generated; a
  // function the definition supplies always wins over the selectors.
  const def = { ...rawDef };
  if (def.select?.row && typeof def.search !== 'function') def.search = buildSearch(def);
  if ((def.select?.link || def.select?.pages) && typeof def.resolve !== 'function') def.resolve = buildResolve(def);
  if (typeof def.search !== 'function' && typeof def.find !== 'function') {
    throw new Error(`defineSource(${def.id}): needs search(), find(), or a select.row selector`);
  }
  const id = def.id;
  const label = def.label || id;
  const kind = def.kind === 'pages' ? 'pages' : 'archive';
  const queriesFor = (name, ctx, kit) => (typeof def.queries === 'function' ? def.queries(name, ctx, kit) : siteQueries(name, ctx));

  // Search every query, dedupe by url (falling back to title), keep order.
  async function runSearch(queries, ctx, kit) {
    const seen = new Map();
    for (const q of queries) {
      let rows;
      try { rows = await def.search(q, ctx, kit); }
      catch (e) { throw new Error(`${label} search failed: ${e?.message || e}`); }
      for (const r of (rows || [])) {
        const key = r?.url || r?.title;
        if (r && key && !seen.has(key)) seen.set(key, r);
      }
    }
    return [...seen.values()];
  }

  async function defaultFind(ctx, kit) {
    // Match against every name the volume has; search under only a few.
    const target = autoTarget(ctx, unique(ctx.seriesNames?.length ? ctx.seriesNames : [ctx.seriesTitle]));
    const names = kit.searchNames(ctx);
    const queries = unique(names.flatMap((n) => queriesFor(n, ctx, kit)));
    let results = await runSearch(queries, ctx, kit);
    // Fallback: the bare names (some sites title an issue in a form the
    // number search misses); the strict scorer still filters.
    if (!results.length && names.some((n) => !queries.includes(n))) results = await runSearch(names, ctx, kit);
    return pickBest(results, target)?.r || null;
  }

  async function defaultManualSearch(ctx, kit) {
    const q = String(ctx.query || '').trim();
    const queries = q ? [q] : unique(kit.searchNames(ctx).flatMap((n) => queriesFor(n, ctx, kit)));
    const target = manualTarget(ctx);
    const results = await runSearch(queries, ctx, kit);
    return {
      searched: queries,
      results: results.map((r) => ({
        ...r, source: id, title: r.title, url: r.url, size: r.size || 0,
        meta: r.meta || label, score: scoreCandidate(r, target),
      })),
    };
  }

  const source = {
    id, label, kind: 'immediate',
    description: def.description || '',
    contentKind: kind,
    types: def.types || DEFAULT_TYPES,
    // A source that cannot work without a browser stays off on an image that
    // has none, rather than failing every download it is asked for.
    isEnabled: (cfg) => !!cfg?.[`${id}Enabled`] && (def.browser !== 'required' || browserAvailable()),
    browser: def.browser || null,

    async find(ctx) {
      if (!typeOk(def, ctx)) return null;
      const session = {};
      const kit = makeKit(def, ctx, { session });
      const found = typeof def.find === 'function' ? await def.find(ctx, kit) : await defaultFind(ctx, kit);
      if (!found) return null;
      return { ...found, source: id, _session: session };
    },

    async fetch(candidate, ctx, onProgress = () => {}) {
      const session = candidate?._session || {};
      const kit = makeKit(def, ctx, { session });
      const r = typeof def.resolve === 'function' ? await def.resolve(candidate, ctx, kit) : { url: candidate.url };
      if (!r) throw Object.assign(new Error(`${label}: nothing to download for ${candidate.title || candidate.url}`), { noRetry: true });
      const referer = r.referer ?? candidate.url ?? kit.siteUrl;
      if (kind === 'pages') {
        onProgress({ phase: 'connecting', detail: label });
        const pages = await fetchPages({
          pages: r.pages, referer, headers: r.headers, session, rateMs: def.pageRateMs ?? 0,
          concurrency: def.pageConcurrency || 3, label,
          onPage: ({ done, total }) => onProgress({ phase: 'download', done, total, detail: label }),
        });
        return pagesToArchive(pages, { title: ctx.issue?.title, publisher: ctx.publisher, seriesTitle: ctx.seriesTitle });
      }
      const links = (r.links?.length ? r.links : [r]).filter((l) => l?.url);
      if (!links.length) throw Object.assign(new Error(`${label}: no download link for ${candidate.title || candidate.url}`), { noRetry: true });
      let lastErr = null;
      for (const link of links) {
        const detail = link.label || label;
        try {
          onProgress({ phase: 'connecting', detail });
          const { buffer } = await kit.http.download(link.url, {
            referer: link.referer ?? referer, headers: { ...(r.headers || {}), ...(link.headers || {}) },
            onStage: (name) => onProgress({ phase: name === 'solving' ? 'solving' : 'connecting', detail }),
            onProgress: ({ done, total, bps }) => onProgress({ phase: 'download', unit: 'bytes', done, total, bps, detail }),
          });
          return await normalizeArchive(buffer, { label: detail, id, url: link.url });
        } catch (e) {
          lastErr = e;
          if (e?.status === 403) {
            // A host can explain its own refusal ("this is usually the free
            // transfer limit") — far more useful than a generic Cloudflare guess.
            const remedy = link.hint403 || (kit.flareUrl
              ? "the download host is blocking this IP — try a download proxy in this source's settings"
              : 'set the FlareSolverr URL in Settings → Downloading to get past it');
            lastErr = Object.assign(new Error(`${detail} refused the download (HTTP 403); ${remedy}`), { noRetry: true });
          }
        }
      }
      throw Object.assign(new Error(`${label} download failed: ${lastErr?.message || 'all links failed'}`), lastErr?.noRetry ? { noRetry: true } : {});
    },

    async manualSearch(ctx) {
      if (ctx.series && !typeOk(def, ctx)) return { results: [] };
      const kit = makeKit(def, ctx, { session: {} });
      const r = typeof def.manualSearch === 'function' ? await def.manualSearch(ctx, kit) : await defaultManualSearch(ctx, kit);
      return { ...r, results: (r?.results || []).map((x) => ({ ...x, source: id })) };
    },

    /** Connection test for the settings card → { ok, message }. `overrides`
     *  are the posted (unsaved) form values. */
    async test(overrides = {}) {
      const cfg = { ...config, ...overrides };
      const kit = makeKit(def, { config: cfg }, { session: {} });
      try {
        if (typeof def.test === 'function') return await def.test(kit);
        const rows = await def.search(def.testQuery || 'batman', { config: cfg, seriesNames: [], issue: {} }, kit);
        const n = (rows || []).length;
        return { ok: n > 0, message: n > 0 ? `Connected — ${n} result${n === 1 ? '' : 's'} for a test search.` : 'Reached the site but parsed no results (its markup may have changed).' };
      } catch (e) { return { ok: false, message: String(e?.message || e) }; }
    },

    // What the settings UI renders, and what settings validation accepts.
    card: {
      id, label,
      description: def.description || '',
      testable: typeof def.search === 'function' || typeof def.test === 'function',
      // What the UI tells the user about this source's needs.
      browser: def.browser || null,
      cloudflare: !!def.cloudflare,
      unavailable: def.browser === 'required' && !browserAvailable()
        ? 'This source needs the browser build of the app (the image tagged -browser). On this build it stays off.'
        : null,
      fields: [
        { key: `${id}Url`, type: 'string', label: 'Site URL', placeholder: def.baseUrl || '', note: def.urlNote || '' },

        ...(def.proxy ? [{ key: `${id}DownloadProxy`, type: 'string', label: 'Download proxy', placeholder: 'http://gluetun:8888', note: 'Optional HTTP proxy for the file download only, for hosts that block datacenter IPs.' }] : []),
        ...Object.entries(def.settings || {}).map(([key, f]) => ({ key, type: fieldSpec(f).type, label: f.label || key, placeholder: f.placeholder || '', note: f.note || '', default: f.default ?? null })),
      ],
    },
    settingsFields: {
      [`${id}Enabled`]: { type: 'bool' },
      [`${id}Url`]: { type: 'string', allowEmpty: true },
      // The shared setting is core's (Settings → Downloading); a per-source
      // override stays valid so an old value is never rejected on save.
      ...(def.cloudflare ? { [`${id}FlaresolverrUrl`]: { type: 'string', allowEmpty: true } } : {}),
      ...(def.proxy ? { [`${id}DownloadProxy`]: { type: 'string', allowEmpty: true } } : {}),
      ...Object.fromEntries(Object.entries(def.settings || {}).map(([key, f]) => [key, fieldSpec(f)])),
    },
    definition: def,
  };
  // A multi-issue pack: same shape as fetch(), and handed a kit like every
  // other hook so a definition never builds its own HTTP.
  if (typeof def.fetchPack === 'function') {
    source.fetchPack = (candidate, ctx, onProgress = () => {}) =>
      def.fetchPack(candidate, ctx, makeKit(def, ctx, { session: candidate?._session || {} }), onProgress);
  }
  return source;
}
