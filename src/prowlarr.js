// Prowlarr integration. Prowlarr manages many indexers (usenet + torrent) and
// exposes each one as a Newznab/Torznab feed at {base}/{id}/api, authenticated
// with the Prowlarr API key. We fetch its indexer list and hand those feeds to
// the existing Usenet (Newznab) and Torrent (Torznab) sources — so searching,
// grabbing and importing all reuse the built-in paths. Prowlarr only FINDS
// releases; the actual download still goes through SABnzbd/NZBGet or qBittorrent.
//
// Which indexers get used is the user's choice: prowlarrExcludeIds is a CSV of
// Prowlarr indexer ids to skip (blank = use all). It's applied per call, so
// changing the selection takes effect without waiting out the cache.
const UA = 'comic-metadata-client/1.0';

// Sync check: is Prowlarr set up enough to try? (find()/isEnabled use this — no
// network.) The real indexer list is fetched lazily by prowlarrIndexers().
export function prowlarrConfigured(config) {
  return !!(config?.prowlarrEnabled && config?.prowlarrUrl && config?.prowlarrApiKey);
}

export function prowlarrBase(config) {
  return String(config?.prowlarrUrl || '').replace(/\/+$/, '');
}

function excludeSet(config) {
  return new Set(String(config?.prowlarrExcludeIds || '').split(',').map((s) => s.trim()).filter(Boolean));
}

// Cache the RAW indexer list briefly so a burst of per-issue searches doesn't hit
// Prowlarr on every call. Keyed by url+key so a settings change invalidates it.
// Exclusion filtering is applied AFTER the cache, so toggling indexers is instant.
let cache = { key: '', at: 0, list: null };
const TTL_MS = 5 * 60 * 1000;

async function fetchRawIndexers(config, fetchImpl) {
  const base = prowlarrBase(config);
  const key = `${base}|${config.prowlarrApiKey}`;
  if (cache.key === key && cache.list && Date.now() - cache.at < TTL_MS) return cache.list;
  let list;
  try {
    const res = await fetchImpl(`${base}/api/v1/indexer`, { headers: { 'X-Api-Key': config.prowlarrApiKey, 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    list = await res.json();
  } catch (e) {
    console.warn('prowlarr: indexer list failed —', e?.message || e);
    return cache.key === key && cache.list ? cache.list : []; // last good, else empty
  }
  const clean = (Array.isArray(list) ? list : []).filter((ix) => ix && ix.enable !== false);
  cache = { key, at: Date.now(), list: clean };
  return clean;
}

// The indexers to search, split into Newznab (usenet) and Torznab (torrent)
// descriptors in the { name, url, apiKey } shape parseIndexers yields — after
// dropping the user's excluded ids.
export async function prowlarrIndexers(config, { fetchImpl = fetch } = {}) {
  if (!prowlarrConfigured(config)) return { newznab: [], torznab: [] };
  const base = prowlarrBase(config);
  const excluded = excludeSet(config);
  const newznab = [], torznab = [];
  for (const ix of await fetchRawIndexers(config, fetchImpl)) {
    if (excluded.has(String(ix.id))) continue; // user deselected this indexer
    const desc = { name: `Prowlarr: ${ix.name || ix.id}`, url: `${base}/${ix.id}/api`, apiKey: config.prowlarrApiKey };
    if (ix.protocol === 'usenet') newznab.push(desc);
    else if (ix.protocol === 'torrent') torznab.push(desc);
  }
  return { newznab, torznab };
}

// The full enabled indexer list for the settings picker: { id, name, protocol }.
// Takes url/key directly (from the settings form, so it works before Save).
export async function prowlarrIndexerList(config, { fetchImpl = fetch } = {}) {
  if (!config?.prowlarrUrl) return [];
  const list = await fetchRawIndexers({ ...config, prowlarrApiKey: config.prowlarrApiKey || '' }, fetchImpl);
  return list.map((ix) => ({ id: ix.id, name: ix.name || String(ix.id), protocol: ix.protocol || 'unknown' }));
}

// Connection test for the settings Test button: confirms the URL/key and reports
// how many usenet/torrent indexers are enabled. { ok, message, usenet, torrent }.
export async function testProwlarr(config, { fetchImpl = fetch } = {}) {
  if (!config?.prowlarrUrl) return { ok: false, message: 'A Prowlarr URL is required.' };
  const base = prowlarrBase(config);
  let res;
  try { res = await fetchImpl(`${base}/api/v1/indexer`, { headers: { 'X-Api-Key': config.prowlarrApiKey || '', 'User-Agent': UA } }); }
  catch (e) { return { ok: false, message: `Connection failed: ${e.message}` }; }
  if (res.status === 401) return { ok: false, message: 'Unauthorized — check the API key.' };
  if (!res.ok) return { ok: false, message: `HTTP ${res.status} — check the URL.` };
  let list;
  try { list = await res.json(); }
  catch { return { ok: false, message: 'Response was not JSON — is this the Prowlarr base URL?' }; }
  if (!Array.isArray(list)) return { ok: false, message: 'Unexpected response — is this a Prowlarr server?' };
  const enabled = list.filter((i) => i && i.enable !== false);
  const usenet = enabled.filter((i) => i.protocol === 'usenet').length;
  const torrent = enabled.filter((i) => i.protocol === 'torrent').length;
  return {
    ok: true, usenet, torrent,
    message: enabled.length
      ? `Connected — ${enabled.length} indexer${enabled.length === 1 ? '' : 's'} (${usenet} usenet, ${torrent} torrent).`
      : 'Connected, but Prowlarr has no enabled indexers yet.',
  };
}
