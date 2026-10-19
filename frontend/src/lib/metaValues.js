// Enumerated metadata values (publication status, series type, age rating)
// arrive in English on the metadata record. Show them in the reader's
// language when the catalog knows the value (metaValues.<kind>.<slug>), and
// as given otherwise — a new value upstream still reads, just untranslated.
import { t, hasMessage } from './i18n.svelte.js';

// "Ongoing Series" → "ongoingSeries", "One-Shot" → "oneShot".
export const metaSlug = (v) => String(v ?? '').trim().toLowerCase()
  .replace(/[^a-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));

export function metaValue(kind, value) {
  if (value == null || value === '') return '';
  const key = `metaValues.${kind}.${metaSlug(value)}`;
  return hasMessage(key) ? t(key) : String(value);
}
