// CBL reading lists (ComicRack's list format, also read by Kavita/Komga):
//
//   <ReadingList><Name>…</Name><Books>
//     <Book Series="Civil War" Number="1" Volume="2006" Year="2006">
//       <Database Name="cv" Series="18023" Issue="105525"/>
//     </Book>…
//
// The community-maintained DieselTech/CBL-ReadingLists repo (1,700+ lists:
// events, character runs, whole alternate universes) ships every book with a
// ComicVine issue id in that <Database> element, so import is id-first: the
// ids are trusted as-is and only a book WITHOUT one falls back to matching by
// series name + volume start year + issue number. Order is the list's own —
// a reading order is the whole point, so it's never re-sorted by date.
import { load } from 'cheerio';

const REPO = 'DieselTech/CBL-ReadingLists';
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;
const CATALOG_TTL_MS = 6 * 3600 * 1000;

/** Parse a .cbl document. Returns { name, books } or throws on non-CBL input.
 *  A book: { series, number, volume, year, cvSeries, cvIssue } (ids as numbers
 *  or null). Attribute order and self-closing forms vary between generators. */
export function parseCbl(xml) {
  const $ = load(String(xml || ''), { xmlMode: true });
  const root = $('ReadingList').first();
  if (!root.length) throw new Error('not a CBL reading list (no <ReadingList> element)');
  const name = root.children('Name').first().text().trim() || null;
  const num = (v) => { const n = Number(String(v ?? '').trim()); return Number.isFinite(n) && n > 0 ? n : null; };
  const books = [];
  root.find('Books > Book').each((_, el) => {
    const b = $(el);
    // Several generators write the CV link; only Name="cv" (any case) counts.
    const cv = b.children('Database').filter((__, d) => /^cv$/i.test(String($(d).attr('Name') || ''))).first();
    books.push({
      series: String(b.attr('Series') || '').trim() || null,
      number: String(b.attr('Number') || '').trim() || null,
      volume: String(b.attr('Volume') || '').trim() || null,   // start year, usually
      year: String(b.attr('Year') || '').trim() || null,
      cvSeries: cv.length ? num(cv.attr('Series')) : null,
      cvIssue: cv.length ? num(cv.attr('Issue')) : null,
    });
  });
  return { name, books };
}

const MAX_BOOKS = 3000;          // "Master Reading Order" lists run to thousands; keep one request bounded
const MAX_FALLBACK_VOLUMES = 40; // name-matching is 1–2 calls per volume; the repo's lists rarely need it

/** Turn parsed books into CV issue objects (the shape importArcAsList /
 *  importCblAsList consume), in file order. Books whose id is unknown to CV
 *  (or absent) are matched by name; whatever still fails is reported in
 *  `unmatched` (each with a short `reason`) rather than silently dropped. */
export async function resolveBooks(client, books, { log = () => {} } = {}) {
  const list = books.slice(0, MAX_BOOKS);
  const byId = new Map();
  const ids = [...new Set(list.map((b) => b.cvIssue).filter(Boolean))];
  for (const i of await client.issuesByIds(ids)) byId.set(i.id, i);

  // Fallback: group the leftovers by (series, start year) so each volume is
  // looked up once, then find the issue by number inside it.
  const leftovers = list.filter((b) => !(b.cvIssue && byId.has(b.cvIssue)));
  const volumeCache = new Map(); // "name|year" → cv volume id | null
  let volumesLookedUp = 0;
  const unmatched = [];
  const miss = (b, reason) => unmatched.push({ ...b, reason });
  const resolvedFallback = new Map(); // book index → issue
  for (const b of leftovers) {
    const idx = list.indexOf(b);
    if (!b.series || !b.number) { miss(b, b.cvIssue ? 'id not on ComicVine' : 'no series or number'); continue; }
    const key = `${b.series.toLowerCase()}|${b.volume || ''}`;
    let vid = b.cvSeries || null;
    if (!vid && volumeCache.has(key)) vid = volumeCache.get(key);
    if (!vid && !volumeCache.has(key)) {
      if (volumesLookedUp >= MAX_FALLBACK_VOLUMES) { miss(b, 'lookup limit reached'); continue; }
      volumesLookedUp++;
      try {
        const hits = await client.search(b.series);
        const want = String(b.series).toLowerCase();
        const year = b.volume && /^\d{4}$/.test(b.volume) ? Number(b.volume) : null;
        const exact = hits.filter((h) => String(h.name || '').toLowerCase() === want);
        const pick = (year && exact.find((h) => Number(h.start_year) === year))
          || (year && hits.find((h) => Number(h.start_year) === year))
          || exact[0] || null;
        vid = pick?.id || null;
      } catch (e) { log(`CBL: volume lookup failed for "${b.series}": ${e.message}`); vid = null; }
      volumeCache.set(key, vid);
    }
    if (!vid) { miss(b, 'no volume match'); continue; }
    try {
      const issue = await client.findIssue(vid, b.number);
      if (issue) resolvedFallback.set(idx, issue); else miss(b, 'issue not in volume');
    } catch (e) { log(`CBL: issue lookup failed for "${b.series}" #${b.number}: ${e.message}`); miss(b, 'lookup failed'); }
  }

  const issues = [];
  list.forEach((b, idx) => {
    const i = (b.cvIssue && byId.get(b.cvIssue)) || resolvedFallback.get(idx);
    if (i) issues.push(i);
  });
  return { issues, unmatched, truncated: books.length > MAX_BOOKS ? books.length - MAX_BOOKS : 0 };
}

// ---- the community catalog (GitHub) ----

let catalog = { at: 0, files: null, promise: null };

const ghHeaders = () => {
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'BackIssue' };
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
};

/** Every .cbl path in the repo, cached for 6h (one tree call; unauthenticated
 *  GitHub allows 60/h, so this never comes close). */
export async function cblCatalog({ fetchImpl = fetch } = {}) {
  const fresh = catalog.files && Date.now() - catalog.at < CATALOG_TTL_MS;
  if (fresh) return catalog.files;
  if (catalog.promise) return catalog.promise;
  catalog.promise = (async () => {
    try {
      const r = await fetchImpl(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`, { headers: ghHeaders() });
      if (!r.ok) throw new Error(`GitHub returned HTTP ${r.status}`);
      const data = await r.json();
      const files = (data.tree || [])
        .filter((t) => t.type === 'blob' && /\.cbl$/i.test(t.path))
        .map((t) => t.path)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (!files.length) throw new Error('GitHub returned no lists');
      catalog = { at: Date.now(), files, promise: null };
      return files;
    } catch (e) {
      catalog.promise = null;
      if (catalog.files) return catalog.files; // stale beats nothing
      throw e;
    }
  })();
  return catalog.promise;
}

/** Fetch one list's XML by its repo path. The path must come from the
 *  catalog — never a caller-supplied URL — so this can't be pointed elsewhere. */
export async function fetchCatalogCbl(path, { fetchImpl = fetch } = {}) {
  const files = await cblCatalog({ fetchImpl });
  if (!files.includes(path)) throw new Error('that list is not in the catalog');
  const url = RAW + path.split('/').map(encodeURIComponent).join('/');
  const r = await fetchImpl(url, { headers: { 'user-agent': 'BackIssue' } });
  if (!r.ok) throw new Error(`couldn't fetch the list (HTTP ${r.status})`);
  return r.text();
}

/** "[Marvel] (2006-02) Civil War (Official).cbl" → "Civil War (Official)" — the
 *  repo prefixes publisher + date for sorting; the list's own <Name> repeats
 *  it, so the display name drops that noise. */
export function prettyCblName(nameOrPath) {
  const base = String(nameOrPath || '').split('/').pop().replace(/\.cbl$/i, '');
  return base.replace(/^\[[^\]]*\]\s*/, '').replace(/^\(\d{4}(?:-\d{2})?(?:-\d{2})?\)\s*/, '').trim() || base;
}
