// The single API key from settings. Legacy settings held a multi-line key
// list; the first entry wins so old settings.json files keep working.
export function cvKey(text) {
  return String(text || '').split(/[\n,]+/).map((k) => k.trim()).find(Boolean) || '';
}

// ComicVine-compatible REST client. By default it talks to the hosted
// BackIssue metadata service (cached ComicVine data + Metron enrichment +
// panel metadata), authenticating with a per-install key it provisions for
// itself on first use — zero setup. Users who prefer ComicVine directly set
// metadataSource='comicvine' with their own API key; cvBaseUrl points at a
// self-hosted metadata service instead of the default hosted one.
const BASE = 'https://comicvine.gamespot.com/api';
const HOSTED_BASE = 'https://data.backissue.app/api';
const UA = 'comic-metadata-client/1.0';
const VOLUME_PREFIX = '4050';
const ISSUE_PREFIX = '4000';
const ARC_PREFIX = '4045';
const POLITE_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shape a raw CV volume (from search or detail) into our stored form.
export function normVolume(v) {
  if (!v) return null;
  return {
    id: v.id,
    name: v.name ?? null,
    publisher: v.publisher?.name ?? null,
    start_year: v.start_year ?? null,
    count_of_issues: v.count_of_issues ?? null,
    deck: v.deck ?? null,
    description: v.description ?? null,
    image_url: v.image?.medium_url ?? v.image?.small_url ?? v.image?.original_url ?? null,
    site_detail_url: v.site_detail_url ?? null,
    aliases: v.aliases ?? null, // ComicVine's alternative names, newline-separated
    // Enrichment (CloneVine's enrich=metron), passed through only when the
    // endpoint attached it. Object = Metron data; null = checked, not on
    // Metron; key absent = enrichment not requested/not supported.
    ...(v?.metron !== undefined ? { metron: v.metron } : {}),
  };
}

// Rate-limit failure. Callers check `.rateLimited` to halt a batch instead of
// hammering on.
function rateLimitError(message) { const e = new Error(message); e.rateLimited = true; return e; }

// Provision (once) and cache the per-install metadata-service key. Persisted
// through saveSettings so it survives restarts; in-flight promise dedupes
// concurrent first calls. Dynamic import avoids a config↔settings cycle.
let instanceKeyPromise = null;
async function ensureInstanceKey(config, base, doFetch) {
  if (config.metadataInstanceKey) return config.metadataInstanceKey;
  return (instanceKeyPromise ??= (async () => {
    const origin = base.replace(/\/api$/, '');
    const resp = await doFetch(`${origin}/api/register`, { method: 'POST', headers: { 'User-Agent': UA } });
    if (!resp.ok) {
      instanceKeyPromise = null; // allow retry on the next call
      throw new Error(`metadata service registration failed (HTTP ${resp.status})`);
    }
    const key = (await resp.json())?.key;
    if (!key) {
      instanceKeyPromise = null;
      throw new Error('metadata service registration returned no key');
    }
    config.metadataInstanceKey = key;
    try {
      const { saveSettings } = await import('./settings.js');
      saveSettings({ metadataInstanceKey: key });
    } catch { /* tests / stripped installs: key still lives in config for this run */ }
    return key;
  })());
}

export function makeCvClient(config, { fetchImpl, key, politeMs } = {}) {
  // Direct-ComicVine mode is an explicit user preference AND needs a key;
  // otherwise the hosted metadata service (or a self-hosted cvBaseUrl) with a
  // self-provisioned instance key — no configuration required.
  const directCv = config?.metadataSource === 'comicvine' && !!(key || cvKey(config.comicvineKeys));
  const doFetch = fetchImpl || fetch;
  let base;
  let fixedKey = null;
  if (directCv) {
    base = BASE;
    fixedKey = key || cvKey(config.comicvineKeys);
  } else {
    base = String(config?.cvBaseUrl || '').replace(/\/+$/, '') || HOSTED_BASE;
    fixedKey = key || null; // tests may inject; otherwise provisioned lazily
  }
  const custom = base !== BASE;
  const pace = politeMs !== undefined ? politeMs : (custom ? 0 : POLITE_MS);

  // One HTTP call, with a couple of retries for transient failures. A rate
  // limit (HTTP 420/429/503 or status_code 107) is surfaced as .rateLimited.
  async function call(pathAndQuery, attempt = 0) {
    const apiKey = fixedKey || (await ensureInstanceKey(config, base, doFetch));
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const url = `${base}${pathAndQuery}${sep}api_key=${encodeURIComponent(apiKey)}&format=json`;
    let resp;
    try {
      resp = await doFetch(url, { headers: { 'User-Agent': UA } });
    } catch (e) {
      if (attempt < 3) { await sleep(500); return call(pathAndQuery, attempt + 1); }
      throw e;
    }
    if (resp.status === 420 || resp.status === 503 || resp.status === 429) {
      if (attempt < 2) { await sleep(1000); return call(pathAndQuery, attempt + 1); }
      throw rateLimitError(`ComicVine HTTP ${resp.status} (rate limited)`);
    }
    if (!resp.ok) throw new Error(`ComicVine HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.status_code === 107) throw rateLimitError('ComicVine rate limit exceeded (107)');
    if (data.status_code !== 1) throw new Error(`ComicVine error ${data.status_code}: ${data.error}`);
    return data;
  }

  // Search volumes (series). Returns normalized candidates. Pass
  // { withDescription: true } to include each volume's full description — the
  // requests plugin needs it to spot collected editions from the blurb, but it
  // bloats the payload (100 results), so it's opt-in.
  async function search(query, { withDescription = false, manga = false } = {}) {
    const mangaQ = manga ? '&manga=1&rating=' + encodeURIComponent(config.mangaRating || 'erotica') : '';
    const fields = 'id,name,publisher,start_year,count_of_issues,image,site_detail_url,deck'
      + (withDescription ? ',description' : '');
    // limit=100 (CV's max page): common names like "X-Men" have dozens of
    // volumes — at limit=20 the right one is often buried below the cutoff and
    // the matcher never even sees it.
    const data = await call(`/search/?resources=volume&limit=100&field_list=${fields}&query=${encodeURIComponent(query)}${mangaQ}`);
    await sleep(pace);
    return (data.results || []).map(normVolume);
  }

  // General list query against a CV list resource ('volumes' | 'issues' | …).
  // Thin, reusable wrapper over the key-rotating/proxied `call` so callers can do
  // filtered/sorted listing (discovery, backfills) without re-implementing auth.
  // opts: { filter, sort, fieldList, limit=100, offset=0 }. Returns
  // { results, total, offset, limit } (raw CV objects — the caller normalizes).
  async function list(resource, { filter, sort, fieldList, limit = 100, offset = 0 } = {}) {
    const q = new URLSearchParams();
    q.set('limit', String(Math.min(Math.max(1, limit), 100))); // CV caps a page at 100
    if (offset) q.set('offset', String(offset));
    if (filter) q.set('filter', filter);
    if (sort) q.set('sort', sort);
    if (fieldList) q.set('field_list', fieldList);
    // CV's filter/sort syntax uses ':' (field:value), '|' (range), and ',' (AND /
    // field lists) literally; URLSearchParams over-encodes them, which CV rejects —
    // put them back.
    const query = q.toString().replace(/%3A/gi, ':').replace(/%7C/gi, '|').replace(/%2C/gi, ',');
    const data = await call(`/${resource}/?${query}`);
    await sleep(pace);
    return { results: data.results || [], total: data.number_of_total_results || 0, offset: data.offset || 0, limit: data.limit || limit };
  }

  // Volume detail: metadata + the full issue stub list (id/number/name), one call.
  async function volume(id) {
    const fields = 'id,name,publisher,start_year,count_of_issues,description,image,issues,site_detail_url,aliases';
    // enrich=metron: CloneVine attaches a `metron` key (ratings, series
    // status, end year); the real ComicVine API ignores unknown params.
    const enrich = config.cvEnrich ? '&enrich=metron' : '';
    const data = await call(`/volume/${VOLUME_PREFIX}-${id}/?field_list=${fields}${enrich}`);
    await sleep(pace);
    const v = normVolume(data.results);
    v.issues = (data.results?.issues || []).map((i) => ({ id: i.id, number: i.issue_number ?? null, name: i.name ?? null }));
    return v;
  }

  // Issue detail — dates, summary, creator credits. Pulled lazily (one call per
  // issue, ever) for issues we own; feeds the metadata tagger.
  async function issue(id) {
    const enrich = config.cvEnrich ? '&enrich=metron' : '';
    const data = await call(`/issue/${ISSUE_PREFIX}-${id}/?field_list=id,name,issue_number,volume,cover_date,store_date,description,person_credits,character_credits,team_credits,location_credits,story_arc_credits,associated_images,site_detail_url,image${enrich}`);
    await sleep(pace);
    const r = data.results || {};
    return {
      id: r.id, number: r.issue_number ?? null, name: r.name ?? null,
      // The owning volume — lets an embedded issue id resolve to its series.
      volume: r.volume ? { id: r.volume.id, name: r.volume.name ?? null } : null,
      cover_date: r.cover_date ?? null, store_date: r.store_date ?? null,
      description: r.description ?? null,
      site_detail_url: r.site_detail_url ?? null,
      image_url: r.image?.medium_url || r.image?.small_url || r.image?.original_url || null,
      credits: (r.person_credits || []).map((p) => ({ name: p.name, role: p.role || '' })),
      character_credits: r.character_credits ?? null,
      team_credits: r.team_credits ?? null,
      location_credits: r.location_credits ?? null,
      story_arc_credits: r.story_arc_credits ?? null,
      associated_images: r.associated_images ?? null,
      // Enrichment key passed through only when the endpoint attached it
      // (object = Metron data, null = checked miss, absent = not requested).
      ...(r?.metron !== undefined ? { metron: r.metron } : {}),
    };
  }

  // Story arcs (reading-list import). Works against the official API and
  // CloneVine alike — CloneVine passes arc search/detail and id-batch issue
  // lookups through to CV with its own server-side keys.
  async function searchArcs(query) {
    const fields = 'id,name,deck,publisher,image,count_of_isssue_appearances'; // (sic — CV's own field name)
    // The list endpoint's name filter (substring match), NOT /search/ —
    // CV's search returns empty for story_arc resources.
    const page = await list('story_arcs', { filter: `name:${query}`, fieldList: fields, limit: 25 });
    return page.results.map((a) => ({
      id: a.id, name: a.name ?? null, deck: a.deck ?? null,
      publisher: a.publisher?.name ?? null,
      image_url: a.image?.small_url ?? a.image?.medium_url ?? null,
      issues: a.count_of_isssue_appearances ?? null,
    }));
  }

  // The arc's full issue list, hydrated (number, volume, cover date, art) via
  // the issues list endpoint — one call per 100 issues instead of one each.
  async function storyArcIssues(arcId) {
    const data = await call(`/story_arc/${ARC_PREFIX}-${arcId}/?field_list=id,name,issues,publisher`);
    await sleep(pace);
    const arc = { id: data.results?.id, name: data.results?.name ?? null };
    const stubIds = (data.results?.issues || []).map((i) => i.id).filter(Boolean);
    const issues = [];
    for (let at = 0; at < stubIds.length; at += 100) {
      const chunk = stubIds.slice(at, at + 100);
      const page = await list('issues', {
        filter: `id:${chunk.join('|')}`,
        fieldList: 'id,name,issue_number,cover_date,image,volume',
        limit: 100,
      });
      for (const r of page.results) {
        issues.push({
          id: r.id, name: r.name ?? null, issue_number: r.issue_number ?? null,
          cover_date: r.cover_date ?? null,
          image_url: r.image?.medium_url || r.image?.small_url || r.image?.original_url || null,
          volume: r.volume ? { id: r.volume.id, name: r.volume.name ?? null } : null,
        });
      }
    }
    return { arc, issues };
  }

  return { search, list, volume, issue, searchArcs, storyArcIssues };
}
