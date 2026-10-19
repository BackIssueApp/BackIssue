// Metron (metron.cloud) as a metadata provider, queried directly with the
// user's own account. It speaks the same normalized volume/issue shapes as the
// ComicVine client, so the matcher, the tagger and the series page never know
// which provider answered.
//
// Identity: Metron's own ids are small integers that would collide with
// ComicVine's, and the catalog keys every series and issue on one integer id.
// Metron ids are therefore MINTED into a range no ComicVine id reaches
// (ComicVine's issue ids are in the low millions; this starts at a billion), so
// a Metron-sourced row can never be mistaken for a ComicVine one. The client
// unmints on the way out and mints on the way back in; nothing else sees a
// raw Metron id. Metron's own `cv_id` rides along in the enrichment sidecar.
//
// Pace: Metron allows a burst of about 20 requests a minute per account plus a
// daily budget, so calls are spaced out by default (politeMs) and a 429 is
// surfaced as .rateLimited, which halts a sweep instead of hammering on.

import { readFileSync } from 'node:fs';

export const MINTED_BASE = 1_000_000_000;
export const mintId = (n) => MINTED_BASE + Number(n);
export const unmintId = (id) => Number(id) - MINTED_BASE;
export const isMintedId = (id) => Number(id) >= MINTED_BASE;

const BASE = 'https://metron.cloud/api';
// Metron's client ecosystem identifies as "Tool/version (platform)" and its
// anti-bot layer answers a bare generic agent with a challenge page, so this
// names the product, the way every other Metron client does.
const UA = (() => {
  let version = '0.0.0';
  try { version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || version; } catch { /* keep the fallback */ }
  return `BackIssue/${version} (${process.platform})`;
})();
const POLITE_MS = 3000;
// A single request may not hang longer than this: a host that is blocking the
// server's address drops the connection silently, and the Settings test must
// come back with a reason rather than spin.
const TIMEOUT_MS = 15000;
const MAX_PAGES = 60; // issue_list pages per series: 28 rows each, so ~1,600 issues

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rateLimitError(message) { const e = new Error(message); e.rateLimited = true; return e; }

// Metron sends some lookups as an object ({ id, name }) and some as a bare
// string, depending on the endpoint; the name is what we store.
export function nameOf(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v || null;
  if (typeof v === 'object') return v.name ?? null;
  return null;
}
const names = (arr) => (Array.isArray(arr) ? arr.map(nameOf).filter(Boolean) : []);
// A named-thing list in ComicVine's credit shape ([{ id, name }]).
const named = (arr) => (Array.isArray(arr) && arr.length ? arr.map((x) => ({ id: x?.id ?? null, name: nameOf(x) })).filter((x) => x.name) : null);

// Series-list rows carry the display name only ("Batman (2016)"); split it.
export function splitListName(s) {
  const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(String(s || ''));
  return m ? { name: m[1], year: m[2] } : { name: String(s || ''), year: null };
}

/** A series-list row → a sparse normalized volume (no publisher or cover:
 *  the list does not carry them, and hydrating every candidate would cost a
 *  paced call each; volume() fills them in once one is picked). */
export function shapeSeriesRow(r) {
  if (!r?.id) return null;
  const { name, year } = splitListName(r.series);
  return {
    id: mintId(r.id),
    name: name || null,
    publisher: null,
    start_year: r.year_began != null ? String(r.year_began) : year,
    count_of_issues: r.issue_count ?? null,
    deck: null,
    description: null,
    image_url: null,
    site_detail_url: `https://metron.cloud/series/${r.id}/`,
    aliases: null,
  };
}

/** The enrichment sidecar for a series: the same keys the hosted service
 *  attaches as `metron`, so applyMetronEnrichment stores it unchanged. */
export function seriesSidecar(d) {
  return {
    id: d.id,
    cv_id: d.cv_id ?? null,
    rating: null,
    series_type: nameOf(d.series_type),
    status: nameOf(d.status),
    year_end: d.year_end ?? null,
    imprint: nameOf(d.imprint),
    genres: names(d.genres),
    sort_name: d.sort_name ?? null,
    gcd_id: d.gcd_id ?? null,
    description: d.desc ?? null,
    issue_count: d.issue_count ?? null,
    publisher: d.publisher && typeof d.publisher === 'object' ? d.publisher : null,
    year_began: d.year_began ?? null,
    volume: d.volume ?? null,
    associated: Array.isArray(d.associated) && d.associated.length ? d.associated : null,
    resource_url: d.resource_url ?? null,
  };
}

/** Series detail (+ its issue stubs) → a normalized volume with `issues`. */
export function shapeSeries(d, stubs = []) {
  return {
    id: mintId(d.id),
    name: d.name ?? null,
    publisher: nameOf(d.publisher),
    start_year: d.year_began != null ? String(d.year_began) : null,
    count_of_issues: d.issue_count ?? stubs.length,
    deck: null,
    description: d.desc ?? null,
    // A Metron series has no cover of its own; the first issue's stands in.
    image_url: stubs.find((s) => s?.image)?.image ?? null,
    site_detail_url: d.resource_url ?? `https://metron.cloud/series/${d.id}/`,
    aliases: null,
    metron: seriesSidecar(d),
    issues: stubs.map((s) => ({ id: mintId(s.id), number: s.number ?? null, name: null })),
  };
}

/** The per-issue sidecar, same keys as the hosted service's `metron`. */
export function issueSidecar(d) {
  const arr = (k) => (Array.isArray(d[k]) && d[k].length ? d[k] : null);
  return {
    id: d.id,
    cv_id: d.cv_id ?? null,
    rating: nameOf(d.rating),
    price: d.price != null ? String(d.price) : null,
    isbn: d.isbn || null,
    upc: d.upc || null,
    sku: d.sku || null,
    foc_date: d.foc_date ?? null,
    // Metron's issue "name" IS the story-title list.
    story_titles: Array.isArray(d.name) ? d.name : null,
    reprints: arr('reprints'),
    variants: arr('variants'),
    cover_hash: d.cover_hash ?? null,
    characters: arr('characters'),
    teams: arr('teams'),
    arcs: arr('arcs'),
    universes: arr('universes'),
    credits: arr('credits'),
    description: d.desc ?? null,
    title: d.title || null,
    alt_number: d.alt_number || null,
    page_count: d.page ?? null,
    imprint: nameOf(d.imprint),
    publisher: d.publisher && typeof d.publisher === 'object' ? d.publisher : null,
    resource_url: d.resource_url || null,
    image: d.image || null,
    gcd_id: d.gcd_id ?? null,
    modified: d.modified || null,
  };
}

/** Issue detail → the normalized issue the catalog stores. */
export function shapeIssue(d) {
  const stories = Array.isArray(d.name) ? d.name.filter(Boolean) : [];
  return {
    id: mintId(d.id),
    number: d.number ?? null,
    name: d.title || (stories.length ? stories.join('; ') : null),
    volume: d.series?.id ? { id: mintId(d.series.id), name: d.series.name ?? null } : null,
    cover_date: d.cover_date ?? null,
    store_date: d.store_date ?? null,
    description: d.desc ?? null,
    site_detail_url: d.resource_url ?? `https://metron.cloud/issue/${d.id}/`,
    image_url: d.image || null,
    credits: (d.credits || []).map((c) => ({ name: c.creator, role: names(c.role).join(', ') })).filter((c) => c.name),
    character_credits: named(d.characters),
    team_credits: named(d.teams),
    location_credits: null,
    story_arc_credits: named(d.arcs),
    associated_images: Array.isArray(d.variants) && d.variants.length
      ? d.variants.map((v) => ({ original_url: v.image || null, caption: v.name || null })) : null,
    metron: issueSidecar(d),
  };
}

/** An issue-list row (a series or arc issue_list, or a filtered /issue/ list)
 *  → the row shape issuesByIds/findIssue return. */
export function shapeIssueRow(r) {
  return {
    id: mintId(r.id),
    name: r.title || null,
    issue_number: r.number ?? null,
    cover_date: r.cover_date ?? null,
    image_url: r.image || null,
    volume: r.series?.id ? { id: mintId(r.series.id), name: r.series.name ?? null } : null,
  };
}

/**
 * The Metron client. `config.metronUser` / `config.metronPass` (or explicit
 * username/password) authenticate every call with HTTP Basic auth. Methods
 * match the ComicVine client's: search, volume, issue, issuesByIds, findIssue,
 * searchArcs, storyArcIssues. There is no `list` (that is ComicVine's query
 * syntax, and callers already treat it as optional).
 */
export function makeMetronClient(config, { fetchImpl, username, password, politeMs, base, timeoutMs } = {}) {
  const user = String(username ?? config?.metronUser ?? '').trim();
  const pass = String(password ?? config?.metronPass ?? '');
  if (!user || !pass) throw new Error('The metadata service needs a username and password');
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const root = String(base || process.env.METRON_BASE_OVERRIDE || BASE).trim().replace(/\/+$/, '');
  const pace = politeMs !== undefined ? politeMs : POLITE_MS;
  const doFetch = fetchImpl || fetch;
  const timeout = timeoutMs !== undefined ? timeoutMs : TIMEOUT_MS;
  let nextAt = 0;

  // One paced HTTP call. null on 404 (the thing is not on Metron); .rateLimited
  // on a 429 that two waits did not clear. Error text never carries the
  // credentials, only the status.
  async function call(pathAndQuery, attempt = 0) {
    const wait = nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextAt = Date.now() + pace;
    let resp;
    try {
      resp = await doFetch(`${root}${pathAndQuery}`, { headers: { 'User-Agent': UA, Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      // One retry only: a host that is unreachable or blocking us does not
      // recover in half a second, and each attempt can take the full timeout.
      if (attempt < 1) { await sleep(500); return call(pathAndQuery, attempt + 1); }
      // Node's fetch says only "fetch failed"; the cause carries the real reason.
      const code = e?.cause?.code || e?.name;
      const why = code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'TimeoutError' || code === 'AbortError'
        ? 'timed out; the host may be blocking this server'
        : (e?.cause?.code || e?.cause?.message || e?.message || e);
      throw new Error(`Could not reach the metadata service (${why})`);
    }
    if (resp.status === 429 || resp.status === 503) {
      if (attempt < 2) {
        const after = Number(resp.headers?.get?.('retry-after')) || 0;
        await sleep(Math.min(Math.max(after * 1000, 2000), 30000));
        return call(pathAndQuery, attempt + 1);
      }
      throw rateLimitError(`Metadata service rate limit reached (HTTP ${resp.status})`);
    }
    if (resp.status === 401 || resp.status === 403) throw new Error('The metadata service rejected the username or password');
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`metadata service HTTP ${resp.status}`);
    // A 200 that is not JSON is the anti-bot challenge page or a block.
    const ct = String(resp.headers?.get?.('content-type') || '');
    if (ct && !/json/i.test(ct)) throw new Error(`The metadata service answered with a web page instead of data (HTTP ${resp.status})`);
    return resp.json();
  }

  // Every row of a paginated list (Django REST pages: results + next).
  async function pages(pathAndQuery, { max = MAX_PAGES } = {}) {
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const out = [];
    for (let page = 1; page <= max; page++) {
      const d = await call(`${pathAndQuery}${sep}page=${page}`);
      if (!d) break; // past the last page → 404
      out.push(...(d.results || []));
      if (!d.next) break;
    }
    return out;
  }

  // Volumes by name. One page of candidates, sparse (see shapeSeriesRow);
  // ComicVine's withDescription/manga options have no Metron equivalent.
  async function search(query) {
    const d = await call(`/series/?name=${encodeURIComponent(String(query || '').trim())}`);
    return (d?.results || []).map(shapeSeriesRow).filter(Boolean);
  }

  // A series or issue the library first cached under ComicVine keeps its
  // ComicVine id; Metron records that id on its own rows, so a ComicVine record
  // is resolved through the cv_id filter (one extra paced call) to the Metron
  // id. The caller says which catalog the record is from ({ catalog }); with
  // no hint, Metron's own minted block decides. null when Metron has no row.
  const fromMetron = (id, catalog) => (catalog ? catalog === 'metron' : isMintedId(id));
  async function metronSeriesId(id, catalog) {
    if (fromMetron(id, catalog)) return unmintId(id);
    if (!(Number(id) > 0)) return null;
    const d = await call(`/series/?cv_id=${Number(id)}`);
    const row = (d?.results || [])[0];
    return row?.id ? Number(row.id) : null;
  }
  async function metronIssueId(id, catalog) {
    if (fromMetron(id, catalog)) return unmintId(id);
    if (!(Number(id) > 0)) return null;
    const d = await call(`/issue/?cv_id=${Number(id)}`);
    const row = (d?.results || [])[0];
    return row?.id ? Number(row.id) : null;
  }

  // Volume detail + every issue stub (paged). The result keeps the id it was
  // asked for, so a ComicVine-keyed series stays on its key; the stubs carry
  // Metron's minted ids and the cache step reconciles them by number.
  async function volume(id, { catalog } = {}) {
    const mid = await metronSeriesId(id, catalog);
    if (!mid) throw new Error(fromMetron(id, catalog) ? 'The metadata service has no series with that id' : 'This series is not in that metadata source, so it cannot be refreshed from there');
    const d = await call(`/series/${mid}/`);
    if (!d) throw new Error('The metadata service has no series with that id');
    const stubs = await pages(`/series/${mid}/issue_list/`);
    return { ...shapeSeries(d, stubs), id: Number(id) };
  }

  async function issue(id, { catalog } = {}) {
    const mid = await metronIssueId(id, catalog);
    if (!mid) throw new Error(fromMetron(id, catalog) ? 'The metadata service has no issue with that id' : 'This issue is not in that metadata source');
    const d = await call(`/issue/${mid}/`);
    if (!d) throw new Error('The metadata service has no issue with that id');
    return { ...shapeIssue(d), id: Number(id) };
  }

  // No batch endpoint: one paced detail call each (two for a ComicVine id);
  // ids Metron does not know are simply absent (the ComicVine client's contract).
  async function issuesByIds(ids) {
    const out = [];
    for (const id of ids) {
      const mid = await metronIssueId(id);
      if (!mid) continue;
      const d = await call(`/issue/${mid}/`);
      if (d) out.push({ ...shapeIssueRow(d), id: Number(id) });
    }
    return out;
  }

  async function findIssue(volumeId, number, { catalog } = {}) {
    const mid = await metronSeriesId(volumeId, catalog);
    if (!mid) return null;
    const want = String(number ?? '').trim();
    const d = await call(`/issue/?series_id=${mid}&number=${encodeURIComponent(want)}`);
    const rows = d?.results || [];
    const r = rows.find((x) => String(x.number ?? '').trim().toLowerCase() === want.toLowerCase()) || rows[0];
    return r ? shapeIssueRow(r) : null;
  }

  async function searchArcs(query) {
    const d = await call(`/arc/?name=${encodeURIComponent(String(query || '').trim())}`);
    return (d?.results || []).map((a) => ({ id: mintId(a.id), name: a.name ?? null, deck: null, publisher: null, image_url: null, issues: null }));
  }

  async function storyArcIssues(arcId) {
    const mid = unmintId(arcId);
    const d = await call(`/arc/${mid}/`);
    const arc = { id: mintId(mid), name: d?.name ?? null };
    const rows = await pages(`/arc/${mid}/issue_list/`);
    return { arc, issues: rows.map(shapeIssueRow) };
  }

  // The Settings "Test" round trip: proves the credentials with a real search.
  async function test() {
    const d = await call('/series/?name=batman');
    const n = Number(d?.count ?? (d?.results || []).length) || 0;
    return { ok: true, message: `Signed in. A test search found ${n} series.` };
  }

  return { provider: 'metron', search, volume, issue, issuesByIds, findIssue, searchArcs, storyArcIssues, test };
}
