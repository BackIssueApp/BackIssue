// Notification rows arrive with an English title/body plus, for core events,
// the facts behind them (`params`). When the catalog knows the event type,
// the bell renders it in the reader's language from those facts; otherwise
// (plugin events, rows older than the params column) the stored text shows.
// Type → key: 'import.done' → notifications.importDone.
import { t, hasMessage } from './i18n.js';

const keyOf = (type) => 'notifications.' + String(type || '').replace(/[.\-_]+(\w)/g, (m, c) => c.toUpperCase());

// Which body variant fits the facts we have. Each entry lists variants from
// most specific to plainest; the first whose required params are present wins.
const VARIANTS = {
  releaseWeek: [['bodyNamedMore', ['named', 'more']], ['bodyNamed', ['named']], ['body', []]],
  pickArrived: [['bodyNamed', ['name']], ['body', []]],
  packDone: [['bodyFailed', ['failed']], ['body', []]],
  importDone: [['bodySource', ['source']], ['body', []]],
};
const present = (v) => v !== undefined && v !== null && v !== '' && v !== 0;

export function notificationText(n) {
  const base = keyOf(n?.type);
  const params = n?.params && typeof n.params === 'object' ? n.params : null;
  const title = hasMessage(base + '.title') ? t(base + '.title', params || undefined) : n?.title;
  let body = n?.body;
  if (params) {
    const short = base.slice('notifications.'.length);
    const variants = VARIANTS[short] || [['body', []]];
    for (const [variant, needs] of variants) {
      if (needs.every((k) => present(params[k])) && hasMessage(base + '.' + variant)) { body = t(base + '.' + variant, params); break; }
    }
  }
  return { title: title ?? '', body: body ?? '' };
}
