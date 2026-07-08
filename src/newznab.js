// Multi-indexer Newznab search. Comics coverage varies wildly per indexer, so we
// query several (config: one `name | url | apikey` per line) and merge results.
// Indexer requests are NOT sent through the scraping proxy — indexers authenticate
// by API key and often rate-limit or ban on IP churn.

// Parse the settings textarea into indexer descriptors. Blank lines and lines
// starting with # are ignored. Fields are pipe-separated: name | url | apikey.
export function parseIndexers(str) {
  if (!str) return [];
  return String(str)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const [name, url, apiKey] = line.split('|').map((s) => (s || '').trim());
      return { name: name || url, url: (url || '').replace(/\/+$/, ''), apiKey: apiKey || '' };
    })
    .filter((i) => i.url);
}

// Newznab search endpoint. cat 7030 = Books/Comics on most indexers; pass cat=''
// to search uncategorised.
// Tolerate a URL saved with a trailing /api (some indexer UIs include it) so we
// don't build /api/api.
const apiRoot = (url) => String(url || '').replace(/\/+$/, '').replace(/\/api$/i, '');

export function buildSearchUrl(indexer, query, { cat = '7030', limit = 50 } = {}) {
  const p = new URLSearchParams({ t: 'search', q: query, o: 'json', apikey: indexer.apiKey, limit: String(limit) });
  if (cat) p.set('cat', cat);
  return `${apiRoot(indexer.url)}/api?${p.toString()}`;
}

// Newznab JSON is inconsistent across servers: `item` may be an object or an
// array; the NZB link lives on `link`, `enclosure.@attributes.url`, or
// `enclosure.url`; size on `size`, the enclosure length, or a newznab attr.
export function parseNewznabJson(json, indexerName) {
  const items = json?.channel?.item ?? json?.item ?? [];
  const list = Array.isArray(items) ? items : [items];
  const out = [];
  for (const it of list) {
    if (!it) continue;
    const enc = it.enclosure || {};
    const encAttr = enc['@attributes'] || enc.attributes || enc;
    const nzbUrl = it.link || encAttr.url || null;
    if (!nzbUrl) continue;
    let size = Number(it.size ?? encAttr.length ?? 0) || 0;
    if (!size && Array.isArray(it.attr)) {
      const s = it.attr.find((a) => (a['@attributes'] || a)?.name === 'size');
      if (s) size = Number((s['@attributes'] || s).value) || 0;
    }
    out.push({ title: it.title || '(untitled)', guid: (it.guid && (it.guid['#text'] || it.guid)) || nzbUrl, nzbUrl, size, indexer: indexerName });
  }
  return out;
}

// Probe an indexer with a small comics search: proves the URL is a Newznab API,
// the API key authenticates, and comics results come back. Returns
// { ok, message, results } — ok:false with a human message on any failure.
export async function testIndexer(indexer, { fetchImpl = fetch } = {}) {
  if (!indexer?.url) return { ok: false, message: 'A URL is required.' };
  const url = buildSearchUrl(indexer, 'batman', { cat: '7030', limit: 1 });
  let res;
  try { res = await fetchImpl(url, { headers: { 'User-Agent': 'comic-metadata-client/1.0' } }); }
  catch (e) { return { ok: false, message: `Connection failed: ${e.message}` }; }
  if (!res.ok) return { ok: false, message: `HTTP ${res.status} — check the URL.` };
  let json;
  try { json = await res.json(); }
  catch { return { ok: false, message: 'Response was not JSON — is this the Newznab API URL?' }; }
  const err = json?.error;
  if (err) {
    const d = err.description || err['@attributes']?.description || err.code || JSON.stringify(err);
    return { ok: false, message: `Indexer error: ${d}` };
  }
  const results = parseNewznabJson(json, indexer.name || 'test').length;
  return {
    ok: true,
    results,
    message: results > 0
      ? `Connected — API key valid, comics search returned results.`
      : `Connected — API key valid, but the test search found no comics.`,
  };
}

export async function searchIndexer(indexer, query, { fetchImpl = fetch, cat = '7030', limit = 50 } = {}) {
  const url = buildSearchUrl(indexer, query, { cat, limit });
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'comic-metadata-client/1.0' } });
  if (!res.ok) throw new Error(`${indexer.name}: HTTP ${res.status}`);
  const json = await res.json();
  return parseNewznabJson(json, indexer.name);
}

// Search every indexer; failures are logged and skipped so one dead indexer
// doesn't sink the whole search. Returns all results, largest first (a proxy for
// completeness/quality when we can't inspect contents).
export async function searchNewznab(indexers, query, { fetchImpl = fetch, cat = '7030', limit = 50 } = {}) {
  const settled = await Promise.allSettled(indexers.map((ix) => searchIndexer(ix, query, { fetchImpl, cat, limit })));
  const results = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') results.push(...r.value);
    else console.warn(`newznab: ${indexers[i]?.name} search failed —`, r.reason?.message || r.reason);
  });
  return results.sort((a, b) => b.size - a.size);
}
