// Multi-indexer Torznab search — the torrent counterpart of newznab.js. Torznab is
// Newznab-compatible (Jackett/Prowlarr expose it), so indexer config is identical
// (name | url | apikey per line). Results carry a magnet or .torrent link plus
// seeders, which we surface for ranking.
import { load } from 'cheerio';
import { parseIndexers, buildSearchUrl } from './newznab.js';

export { parseIndexers };

// Torznab's canonical format is XML/RSS. Prowlarr always returns XML (it ignores
// o=json); Jackett can return either. Dispatch on the payload's first char.
export function parseTorznab(text, indexerName) {
  const t = String(text || '').trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return parseTorznabJson(JSON.parse(t), indexerName); } catch { return []; }
  }
  return parseTorznabXml(t, indexerName);
}

function parseTorznabXml(xml, indexerName) {
  const $ = load(xml, { xmlMode: true });
  const out = [];
  $('item').each((_, el) => {
    const item = $(el);
    const enc = item.find('enclosure').first();
    const encUrl = enc.attr('url') || null;
    const linkText = (item.find('link').first().text() || '').trim() || null;
    // torznab:attr elements carry seeders/magneturl/size etc. Match by tag name
    // ending in "attr" (namespace-selector matching in xml mode is unreliable).
    const attrs = {};
    item.children().each((__, a) => {
      const tag = a.tagName || a.name || '';
      if (/(^|:)attr$/i.test(tag)) {
        const name = $(a).attr('name');
        if (name) attrs[name.toLowerCase()] = $(a).attr('value');
      }
    });
    const magnet = attrs.magneturl
      || (encUrl && encUrl.startsWith('magnet:') ? encUrl : null)
      || (linkText && linkText.startsWith('magnet:') ? linkText : null)
      || null;
    const torrentUrl = (encUrl && !encUrl.startsWith('magnet:') ? encUrl : null) || (magnet ? null : linkText);
    const downloadUrl = magnet || torrentUrl;
    if (!downloadUrl) return;
    const size = Number((item.find('size').first().text() || '').trim() || attrs.size || enc.attr('length') || 0) || 0;
    const seeders = Number(attrs.seeders ?? -1);
    out.push({
      title: (item.find('title').first().text() || '(untitled)').trim(),
      guid: (item.find('guid').first().text() || '').trim() || downloadUrl,
      downloadUrl, magnet: !!magnet, seeders: Number.isFinite(seeders) ? seeders : -1,
      size, indexer: indexerName,
    });
  });
  return out;
}

// Collect a result's torznab:attr entries into a { name: value } map. JSON shape
// varies: `torznab:attr` or `attr`, an array or a single object, attributes under
// `@attributes` or inline.
function attrsOf(it) {
  const raw = it['torznab:attr'] ?? it.attr ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = {};
  for (const a of list) {
    const at = a?.['@attributes'] || a || {};
    if (at.name != null) out[String(at.name).toLowerCase()] = at.value;
  }
  return out;
}

export function parseTorznabJson(json, indexerName) {
  const items = json?.channel?.item ?? json?.item ?? [];
  const list = Array.isArray(items) ? items : [items];
  const out = [];
  for (const it of list) {
    if (!it) continue;
    const enc = it.enclosure || {};
    const encAttr = enc['@attributes'] || enc.attributes || enc;
    const attrs = attrsOf(it);
    const encUrl = encAttr.url || null;
    const link = (it.link && (it.link['#text'] || it.link)) || null;
    // A magnet can arrive as a torznab attr, the enclosure url, or the link.
    const magnet = attrs.magneturl
      || (typeof encUrl === 'string' && encUrl.startsWith('magnet:') ? encUrl : null)
      || (typeof link === 'string' && link.startsWith('magnet:') ? link : null)
      || null;
    // Otherwise a .torrent URL (enclosure preferred; link as fallback).
    const torrentUrl = (typeof encUrl === 'string' && !encUrl.startsWith('magnet:') ? encUrl : null) || (magnet ? null : link);
    const downloadUrl = magnet || torrentUrl;
    if (!downloadUrl) continue;
    let size = Number(it.size ?? attrs.size ?? encAttr.length ?? 0) || 0;
    const seeders = Number(attrs.seeders ?? -1);
    out.push({
      title: it.title || '(untitled)',
      guid: (it.guid && (it.guid['#text'] || it.guid)) || downloadUrl,
      downloadUrl, magnet: !!magnet, seeders: Number.isFinite(seeders) ? seeders : -1,
      size, indexer: indexerName,
    });
  }
  return out;
}

// Torznab's t=search is identical to Newznab (cat 7030 = Books/Comics on both),
// so the URL builder is shared — buildSearchUrl, imported above. It tolerates a
// URL saved with a trailing /api (Prowlarr's "Copy Torznab Url" includes it).

async function searchOne(indexer, query, { fetchImpl = fetch, cat = '7030', limit = 50 } = {}) {
  const res = await fetchImpl(buildSearchUrl(indexer, query, { cat, limit }), { headers: { 'User-Agent': 'comic-metadata-client/1.0' } });
  if (!res.ok) throw new Error(`${indexer.name}: HTTP ${res.status}`);
  return parseTorznab(await res.text(), indexer.name);
}

// Search every indexer; one dead indexer doesn't sink the batch. Sorted by
// seeders (health) then size, both descending.
export async function searchTorznab(indexers, query, { fetchImpl = fetch, cat = '7030', limit = 50 } = {}) {
  const settled = await Promise.allSettled(indexers.map((ix) => searchOne(ix, query, { fetchImpl, cat, limit })));
  const results = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') results.push(...r.value);
    else console.warn(`torznab: ${indexers[i]?.name} search failed —`, r.reason?.message || r.reason);
  });
  return results.sort((a, b) => (b.seeders - a.seeders) || (b.size - a.size));
}

// Probe an indexer without saving it (the indexer modal's Test button). Tries the
// Comics category first for a clean signal, then falls back to an uncategorized
// search so it can tell "indexer has nothing" from "indexer doesn't tag comics"
// (the real search is uncategorized + title-matched anyway).
export async function testTorznabIndexer(indexer, { fetchImpl = fetch } = {}) {
  if (!indexer?.url) return { ok: false, message: 'A URL is required.' };
  const probe = async (cat) => {
    let res;
    try { res = await fetchImpl(buildSearchUrl(indexer, 'batman', { cat, limit: 5 }), { headers: { 'User-Agent': 'comic-metadata-client/1.0' } }); }
    catch (e) { return { err: `Connection failed: ${e.message}` }; }
    if (!res.ok) return { err: `HTTP ${res.status} — check the URL.` };
    const text = await res.text().catch(() => '');
    const em = /<error[^>]*\bdescription="([^"]*)"/i.exec(text) || /<error[^>]*\bcode="([^"]*)"/i.exec(text);
    if (em) return { err: `Indexer error: ${em[1]}` };
    if (!text.trim() || (!text.trimStart().startsWith('<') && !text.trimStart().startsWith('{'))) {
      return { err: 'Response was not a Torznab feed — check the URL.' };
    }
    return { count: parseTorznab(text, indexer.name || 'test').length };
  };
  const comics = await probe('7030');
  if (comics.err) return { ok: false, message: comics.err };
  if (comics.count > 0) return { ok: true, results: comics.count, message: 'Connected — API key valid, comics search returned results.' };
  const broad = await probe('');
  if (broad.err) return { ok: true, results: 0, message: 'Connected — API key valid (no results under the Comics category).' };
  if (broad.count > 0) return { ok: true, results: 0, message: 'Connected — API key valid, but this indexer returned nothing under the Comics category (7030). It may not tag comics — that’s fine, downloads are matched by title.' };
  return { ok: true, results: 0, message: 'Connected — API key valid, but the test search found nothing.' };
}
