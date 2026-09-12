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
import { recordGrab } from './db.js';
import { safeName } from './downloader.js';
import { walkFiles } from './sources/usenet.js';
import { mediaHandlerFor, registeredMediaListeners, loadPlugins } from './plugins.js';
import { sourcesForType } from './sources/index.js';
import { logInfo, logWarn } from './logstore.js';

const TYPES = ['ebook', 'audiobook'];

/** Tell the listeners (best-effort; a listener that throws is logged, not fatal). */
export function emitMedia(event) {
  for (const fn of registeredMediaListeners()) {
    try { const r = fn(event); if (r?.catch) r.catch((e) => console.warn('media listener failed:', e?.message || e)); }
    catch (e) { console.warn('media listener failed:', e?.message || e); }
  }
}

/** The ctx a source's find() receives for a book: the comic fields it reads
 *  (seriesTitle, seriesNames, issue, series.type) plus the `book` block. */
export function bookContext(db, { type, title, author = null, year = null }) {
  const names = [...new Set([title, author ? `${author} ${title}` : null].filter(Boolean))];
  return {
    db, config,
    issue: { id: 0, issue_number: '', title },
    series: { type, title },
    seriesTitle: title, seriesNames: names, seriesYear: year || null, cv: null,
    book: { type, title, author, year },
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
export async function queueMediaDownload({ db, type, libraryId, title, author = null, year = null, ref = null, onProgress = () => {} }) {
  type = String(type || '').toLowerCase();
  if (!TYPES.includes(type)) throw new Error(`unknown media type ${type}`);
  if (!db) throw new Error('downloadMedia needs a db');
  if (!title) throw new Error('downloadMedia needs a title');
  await loadPlugins();
  if (!mediaHandlerFor(type)) throw new Error(`no plugin files ${type} downloads`);
  const sources = sourcesForType(config, type);
  if (!sources.length) return { status: 'no-sources' };
  const ctx = bookContext(db, { type, title, author, year });
  const hint = { title, author, year };
  const label = `${type} "${title}"${author ? ` by ${author}` : ''}`;
  for (const src of sources) {
    let candidate;
    onProgress({ event: 'searching', source: src.id });
    try { candidate = await src.find(ctx); }
    catch (e) { logWarn(`${src.id}: search for ${label} failed: ${e?.message || e}`, src.id); continue; }
    if (!candidate) continue;
    const release = candidate.title || candidate.url || '';
    if (src.kind === 'deferred') {
      try {
        const g = await src.grab(candidate, ctx);
        const grabId = recordGrab(db, {
          issueId: 0, kind: 'media', source: src.id, client: g.client, downloadId: g.downloadId, category: g.category,
          title: g.title || release, releaseGuid: g.releaseGuid, ref, payload: { type, libraryId, hint, title },
        });
        logInfo(`Grabbed ${label} from ${src.id}: ${g.title || release}`, src.id);
        return { status: 'grabbed', source: src.id, release: g.title || release, grabId };
      } catch (e) { logWarn(`${src.id}: could not grab ${label}: ${e?.message || e}`, src.id); continue; }
    }
    // Immediate: download and file in the background; the outcome reaches the
    // asker through the listeners like a deferred grab's would.
    (async () => {
      let file;
      try {
        const fetched = await src.fetch(candidate, ctx, () => {});
        if (!fetched?.buffer) throw new Error(`${src.id} returned no file`);
        file = await stash(fetched, { title, type });
      } catch (e) {
        logWarn(`${src.id}: download of ${label} failed: ${e?.message || e}`, src.id);
        emitMedia({ event: 'failed', type, libraryId, ref, title, source: src.id, error: String(e?.message || e) });
        return;
      }
      await fileMedia(db, { type, libraryId, path: file, hint, source: src.id, ref, title });
    })();
    return { status: 'downloading', source: src.id, release };
  }
  return { status: 'no-match', searched: sources.map((s) => s.id) };
}
