// Media downloads: a book or audiobook wanted for a plugin library, found and
// fetched by the same download sources that serve comics and FILED by the
// plugin that owns the library type (registerMediaHandler).
//
//   queueMediaDownload({ db, type, libraryId, title, author, year, ref })
//     → asks each enabled source that serves `type` (sourcesForType) for the
//       book; a deferred source (usenet, torrent) hands the release to its
//       client and records a kind='media' grab the download monitor finishes;
//       an immediate site source downloads in the background and files
//       straight away.
//   fileMedia(db, { type, libraryId, path, hint, source, ref, title })
//     → hands a completed download to the type's handler and tells every
//       onMediaDownload listener how it went. Used here and by the monitor.
//
// The asker (e.g. the requests plugin) passes a `ref` it can recognise; the
// grab carries it, and so does every event, so a request can show "downloading
// from usenet" and be marked fulfilled when the file lands.
import fs from 'node:fs/promises';
import path from 'node:path';
import config from './config.js';
import { recordGrab, activeMediaGrabs, grabPayload } from './db.js';
import { safeName } from './downloader.js';
import { walkFiles } from './sources/usenet.js';
import { mediaHandlerFor, registeredMediaListeners, loadPlugins } from './plugins.js';
import { sourcesForType } from './sources/index.js';
import { logInfo, logWarn } from './logstore.js';

const TYPES = ['ebook', 'audiobook'];

// What is in flight right now, for the queue page: an immediate download's
// search/fetch/filing phases live here (keyed by a running number); a
// deferred grab is on its client and in the grabs table, so the queue reads
// those from the database and the download monitor's progress.
let nextLiveId = 1;
const live = new Map(); // id → { id, type, title, author, source, phase, page, pages, unit, bps, detail, release, startedAt, ref }
function track(entry) { const id = nextLiveId++; live.set(id, { id, startedAt: Date.now(), ...entry }); return id; }
function update(id, patch) { const e = live.get(id); if (e) Object.assign(e, patch); }
function untrack(id) { live.delete(id); }

/** Every media download in flight: { id, grabId?, type, title, author, source,
 *  release, ref, live: { phase, page, pages, unit, bps, detail, progress,
 *  seeders } }. `db` adds the deferred grabs; `progress` is the download
 *  monitor's per-grab state for them. */
export function activeMedia(db, progress = {}) {
  const out = [...live.values()].map((e) => ({
    id: `m${e.id}`, grabId: null, type: e.type, title: e.title, author: e.author || null, source: e.source || null, release: e.release || null, ref: e.ref || null,
    live: { phase: e.phase, page: e.page ?? null, pages: e.pages ?? null, unit: e.unit || null, bps: e.bps ?? null, detail: e.detail || null, source: e.source || null },
  }));
  if (db) {
    for (const g of activeMediaGrabs(db)) {
      const p = grabPayload(g);
      const pr = progress?.[g.id] || null;
      out.push({
        id: `g${g.id}`, grabId: g.id, type: p.type || null, title: p.title || p.hint?.title || g.title, author: p.hint?.author || null, source: g.source, release: g.title, ref: g.ref || null,
        live: pr ? { phase: pr.state === 'downloading' ? 'downloading' : 'grabbed', progress: pr.progress ?? null, seeders: pr.seeders ?? null, source: g.source }
          : { phase: 'grabbed', source: g.source },
      });
    }
  }
  return out;
}

/** Tell the listeners (best-effort; a listener that throws is logged, not fatal). */
export function emitMedia(event) {
  for (const fn of registeredMediaListeners()) {
    try { const r = fn(event); if (r?.catch) r.catch((e) => console.warn('media listener failed:', e?.message || e)); }
    catch (e) { console.warn('media listener failed:', e?.message || e); }
  }
}

/** The ctx a source's find() receives for a book: the comic fields it reads
 *  (seriesTitle, seriesNames, issue, series.type) plus the `book` block. */
export function bookContext(db, { type, title, author = null, year = null, isbn = null }) {
  const names = [...new Set([title, author ? `${author} ${title}` : null].filter(Boolean))];
  return {
    db, config,
    issue: { id: 0, issue_number: '', title },
    series: { type, title },
    seriesTitle: title, seriesNames: names, seriesYear: year || null, cv: null,
    book: { type, title, author, year, isbn: isbn || null },
  };
}

// The file's own kind, from its bytes, for a download that arrives as a
// buffer: an EPUB is a zip whose first entry is the literal mimetype.
export function sniffMediaExt(buf, url = '') {
  if (buf && buf.length >= 4) {
    const head = buf.subarray(0, 64).toString('latin1');
    if (head.startsWith('PK') && buf.subarray(0, 512).toString('latin1').includes('application/epub+zip')) return '.epub';
    if (head.startsWith('%PDF')) return '.pdf';
    if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
      const brand = buf.subarray(8, 12).toString('latin1');
      return /M4B/i.test(brand) ? '.m4b' : '.m4a';
    }
    if (head.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return '.mp3';
  }
  const ext = path.extname(String(url || '').split(/[?#]/)[0]).toLowerCase();
  return ext || '';
}

/** The files in a completed download the handler can file: a single file
 *  as itself, a folder walked for the handler's extensions (largest first). */
export async function mediaFilesIn(root, exts) {
  let st = await fs.stat(root).catch(() => null);
  if (!st) {
    // The client reported a name we can't see (non-ASCII mangled across a
    // mount). The entry is still there under its real name, so take the one
    // sibling whose name folds to the same ASCII — never the whole parent,
    // which holds every other download in the category.
    const fold = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '');
    // "Blüdwire" reported as "Bl?dwire" or "Bldwire": the ASCII letters agree
    // in order, with at most a few lost to the mangling.
    const subseq = (a, b) => { let i = 0; for (const ch of b) if (ch === a[i]) i++; return i === a.length; };
    const twin = (a, b) => a === b || (Math.abs(a.length - b.length) <= 3 && (a.length < b.length ? subseq(a, b) : subseq(b, a)));
    const want = fold(path.basename(root));
    const parent = path.dirname(root);
    const names = await fs.readdir(parent).catch(() => []);
    const twins = want ? names.filter((n) => twin(fold(n), want)) : [];
    if (twins.length !== 1) return [];
    root = path.join(parent, twins[0]);
    st = await fs.stat(root).catch(() => null);
    if (!st) return [];
  }
  const all = st.isFile() ? [root] : await walkFiles(root);
  const ok = all.filter((f) => exts.includes(path.extname(f).toLowerCase()));
  const sized = await Promise.all(ok.map(async (f) => ({ f, size: (await fs.stat(f).catch(() => null))?.size ?? 0 })));
  // Prefer the handler's own format order (its exts list is best-first), then size.
  sized.sort((a, b) => (exts.indexOf(path.extname(a.f).toLowerCase()) - exts.indexOf(path.extname(b.f).toLowerCase())) || (b.size - a.size));
  return sized.map((x) => x.f);
}

/** Hand a completed download to the type's handler and report the outcome to
 *  the listeners. Never throws: → { ok: true, issueId, seriesId } or
 *  { ok: false, error }. */
export async function fileMedia(db, { type, libraryId, path: root, hint = {}, source = null, ref = null, title = null }) {
  const handler = mediaHandlerFor(type);
  const base = { type, libraryId, ref, title: title || hint.title || null, source };
  try {
    if (!handler) throw new Error(`no plugin files ${type} downloads`);
    const files = await mediaFilesIn(root, handler.exts);
    if (!files.length) throw new Error(`nothing usable in the completed download (${handler.exts.join(', ')} wanted)`);
    const out = await handler.file({ path: root, files, libraryId, hint, source, db, log: (m) => logInfo(m, source || 'download') });
    if (!out?.issueId) throw new Error('the handler filed nothing');
    logInfo(`Filed ${type} "${base.title || files[0]}" from ${source || 'download'}`, source || 'download');
    emitMedia({ event: 'imported', ...base, issueId: out.issueId, seriesId: out.seriesId ?? null, path: out.path ?? null });
    return { ok: true, issueId: out.issueId, seriesId: out.seriesId ?? null };
  } catch (e) {
    const error = String(e?.message || e);
    logWarn(`Could not file ${type} "${base.title || root}": ${error}`, source || 'download');
    emitMedia({ event: 'failed', ...base, error });
    return { ok: false, error };
  }
}

// Where an immediate source's download is written before filing. The handler
// moves it into the library; a failure leaves it here for a look.
async function stash(fetched, { title, type }) {
  const dir = path.join(config.downloadsDir, '.media');
  await fs.mkdir(dir, { recursive: true });
  const ext = sniffMediaExt(fetched.buffer, fetched.url) || (type === 'audiobook' ? '.m4b' : '.epub');
  const file = path.join(dir, safeName(fetched.name || title || 'download') + ext);
  await fs.writeFile(file, fetched.buffer);
  return file;
}

/**
 * Ask the sources for a book and start the download. Returns
 *   { status: 'grabbed', source, release, grabId }      — a client has it
 *   { status: 'downloading', source, release }         — fetching now, files on its own
 *   { status: 'no-match', searched: [ids] }            — nobody had it
 *   { status: 'no-sources' }                           — nothing enabled serves this type
 * and throws when no plugin can file `type` at all.
 */
export async function queueMediaDownload({ db, type, libraryId, title, author = null, year = null, isbn = null, ref = null, onProgress = () => {} }) {
  type = String(type || '').toLowerCase();
  if (!TYPES.includes(type)) throw new Error(`unknown media type ${type}`);
  if (!db) throw new Error('downloadMedia needs a db');
  if (!title) throw new Error('downloadMedia needs a title');
  await loadPlugins();
  if (!mediaHandlerFor(type)) throw new Error(`no plugin files ${type} downloads`);
  const sources = sourcesForType(config, type);
  if (!sources.length) return { status: 'no-sources' };
  const ctx = bookContext(db, { type, title, author, year, isbn });
  const hint = { title, author, year, isbn: isbn || null };
  const label = `${type} "${title}"${author ? ` by ${author}` : ''}`;
  const liveId = track({ type, title, author, ref, phase: 'searching', source: null });
  let lastErr = null; // a source that broke, as opposed to one that had nothing
  try {
  for (const src of sources) {
    let candidate;
    onProgress({ event: 'searching', source: src.id });
    update(liveId, { phase: 'searching', source: src.id });
    logInfo(`Searching ${src.id} for ${label}`, src.id);
    try { candidate = await src.find(ctx); }
    catch (e) { lastErr = `${src.id}: ${e?.message || e}`; logWarn(`${src.id}: search for ${label} failed: ${e?.message || e}`, src.id); continue; }
    if (!candidate) { logInfo(`${src.id}: nothing matched ${label}`, src.id); continue; }
    const release = candidate.title || candidate.url || '';
    if (src.kind === 'deferred') {
      try {
        const g = await src.grab(candidate, ctx);
        const grabId = recordGrab(db, {
          issueId: 0, kind: 'media', source: src.id, client: g.client, downloadId: g.downloadId, category: g.category,
          title: g.title || release, releaseGuid: g.releaseGuid, ref, payload: { type, libraryId, hint, title },
        });
        logInfo(`Grabbed ${label} from ${src.id}: ${g.title || release}`, src.id);
        untrack(liveId); // the grabs table carries it from here
        return { status: 'grabbed', source: src.id, release: g.title || release, grabId };
      } catch (e) { lastErr = `${src.id}: ${e?.message || e}`; logWarn(`${src.id}: could not grab ${label}: ${e?.message || e}`, src.id); continue; }
    }
    // Immediate: download and file in the background; the outcome reaches the
    // asker through the listeners like a deferred grab's would. A file the
    // source itself rejects on inspection (a translation labelled as the
    // wanted language, say) is not the end: the next-best candidate is asked
    // for, a few times over.
    update(liveId, { phase: 'connecting', release, page: 0, pages: 0, unit: null, bps: null, detail: null });
    logInfo(`${src.id}: downloading ${release} for ${label}`, src.id);
    (async () => {
      let file;
      let pick = candidate;
      const exclude = new Set();
      try {
        for (let attempt = 1; ; attempt++) {
          try {
            const fetched = await src.fetch(pick, ctx, (p) => update(liveId, {
              phase: p.phase === 'download' ? 'downloading' : (p.phase || 'connecting'),
              page: p.done ?? null, pages: p.total ?? null, unit: p.unit || (p.phase === 'download' ? 'bytes' : null), bps: p.bps ?? null, detail: p.detail || null,
            }));
            if (!fetched?.buffer) throw new Error(`${src.id} returned no file`);
            update(liveId, { phase: 'saving', bps: null });
            file = await stash(fetched, { title, type });
            break;
          } catch (e) {
            const why = String(e?.message || e);
            if (e?.rejected && attempt < 4) {
              exclude.add(pick.url || pick.title);
              logWarn(`${src.id}: ${why} — trying the next candidate for ${label}`, src.id);
              update(liveId, { phase: 'searching', page: null, pages: null, bps: null });
              let next = null;
              try { next = await src.find({ ...ctx, exclude }); } catch { /* nothing more */ }
              if (next && !exclude.has(next.url || next.title)) {
                pick = next;
                update(liveId, { phase: 'connecting', release: next.title || next.url || '' });
                logInfo(`${src.id}: downloading ${next.title || next.url || ''} for ${label} instead`, src.id);
                continue;
              }
            }
            logWarn(`${src.id}: download of ${label} failed: ${why}`, src.id);
            emitMedia({ event: 'failed', type, libraryId, ref, title, source: src.id, error: why });
            return;
          }
        }
        update(liveId, { phase: 'done', page: null, pages: null });
        await fileMedia(db, { type, libraryId, path: file, hint, source: src.id, ref, title });
      } finally { untrack(liveId); }
    })();
    return { status: 'downloading', source: src.id, release };
  }
  // Nothing matched. When a source broke along the way, say so rather than
  // "no source has it" — the book may well be there once the source works.
  if (lastErr) return { status: 'error', error: lastErr, searched: sources.map((s) => s.id) };
  logInfo(`No enabled source had ${label} (asked ${sources.map((s) => s.id).join(', ')})`, 'download');
  return { status: 'no-match', searched: sources.map((s) => s.id) };
  } finally { if (live.has(liveId) && live.get(liveId).phase === 'searching') untrack(liveId); }
}
