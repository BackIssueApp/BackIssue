// Resolve the indexers a source should search: the manually-entered list plus
// anything registered indexer providers supply (e.g. a Prowlarr plugin). Kept
// generic — core knows nothing about any specific provider.
import { parseIndexers } from './newznab.js';
import { registeredIndexerProviders } from './plugins.js';

// Sync: is any provider currently supplying indexers? Used by a source's
// isEnabled (so "no manual indexers" doesn't disable it when a provider has
// them) and by the settings UI to mark the manual list as managed.
export function indexersManaged(config) {
  return registeredIndexerProviders().some((p) => {
    try { return !!p.isActive?.(config); } catch { return false; }
  });
}

// The indexer descriptors ({ name, url, apiKey }) to search for a protocol
// ('newznab' = usenet, 'torznab' = torrent): the manual list merged with each
// active provider's. If any active provider is exclusive, the manual list is
// dropped (the provider owns the indexers).
export async function resolveIndexers(config, protocol) {
  const manual = parseIndexers(protocol === 'torznab' ? config.torznabIndexers : config.newznabIndexers);
  const providers = registeredIndexerProviders();
  if (!providers.length) return manual;
  const extra = [];
  let exclusive = false;
  for (const p of providers) {
    try {
      if (p.isActive && !p.isActive(config)) continue;
      const r = await p.indexers(config, protocol);
      if (Array.isArray(r?.indexers)) extra.push(...r.indexers);
      if (r?.exclusive) exclusive = true;
    } catch (e) {
      console.warn(`indexer provider ${p.id} failed —`, e?.message || e);
    }
  }
  return exclusive ? extra : [...manual, ...extra];
}
