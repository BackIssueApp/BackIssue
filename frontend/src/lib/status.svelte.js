// The /api/status poll: header pills, queue button count, retry/clear-failed
// visibility, app version — and the trigger that live-updates issue badges
// while the queue runs.
import { apiGet } from './api.js';
import { subscribe } from './events.svelte.js';
import { BackIssue } from './plugins.svelte.js';
import { detail, loadCollection, reloadDetail, refreshIssueStatuses } from './store.svelte.js';

export const status = $state({ counts: {}, version: '', downloading: false, libraryTypes: [], libraries: [] });

let wasDownloading = false;
export async function pollStatus() {
  let s;
  try { s = await apiGet('/api/status'); } catch { return; }
  status.counts = s.counts || {};
  status.libraryTypes = s.libraryTypes || [];
  status.libraries = s.libraries || [];
  status.downloading = !!s.queue?.running;
  if (s.version) status.version = s.version;

  // Let plugins react to status (e.g. a catalog crawl progress bar).
  for (const cb of BackIssue._statusHooks) { try { cb(s); } catch { /* ignore */ } }

  // Live-update issue badges while downloading; when the queue finishes,
  // re-render so freshly indexed downloads show as owned (rail + detail).
  if (status.downloading && detail.series) refreshIssueStatuses();
  if (!status.downloading && wasDownloading) {
    loadCollection();
    reloadDetail();
  }
  wasDownloading = status.downloading;
}

export function startStatusPolling() {
  pollStatus();
  // SSE-driven: 'status' covers counts/state flips; 'queue' fires per progress
  // tick during downloads so issue badges track live. Falls back to a poll
  // while the stream is down.
  subscribe('status', pollStatus, 1800);
  subscribe('queue', () => { if (detail.series) refreshIssueStatuses(); });
}
