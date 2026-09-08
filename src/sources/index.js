import { pluginApi, registeredSources } from '../plugins.js';
import { usenet } from './usenet.js';
import { torrent } from './torrent.js';

// Built-in sources register through the SAME api external plugins use, so there
// is a single code path for both. External plugins (e.g. a private catalog
// source) add themselves via loadPlugins() (src/plugins.js).
pluginApi.registerSource(usenet);
pluginApi.registerSource(torrent);

// Live view of every registered source (built-in + any loaded plugin).
export const allSources = registeredSources();

// Enabled sources, ordered by the configured priority (`sourcePriority`, a
// comma-separated id list). Sources not named in the priority list sort last but
// still run (in registration order). The queue tries each in turn and takes the
// first that can serve an issue.
export function orderedSources(config) {
  const pri = String(config?.sourcePriority || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const rank = (id) => { const i = pri.indexOf(id); return i === -1 ? 999 : i; };
  return registeredSources()
    .filter((s) => { try { return s.isEnabled(config); } catch { return false; } })
    .sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * Can this source serve that library type? A source declares the types it
 * covers (a comics site does not carry audiobooks; a manga site does not carry
 * western comics); one that declares nothing serves everything, which is what
 * the indexer-backed built-ins do. An unknown type is not filtered — better a
 * pointless search than a silently skipped one.
 */
export function sourceservesType(source, type) {
  const t = String(type || '').toLowerCase();
  if (!t || !Array.isArray(source?.types) || !source.types.length) return true;
  return source.types.includes(t);
}

/** The enabled sources, in priority order, that can serve this library type. */
export function sourcesForType(config, type) {
  return orderedSources(config).filter((s) => sourceservesType(s, type));
}

export { usenet, torrent };
