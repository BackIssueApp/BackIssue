import path from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import config from './config.js';
import fsp from 'node:fs/promises';
import { claimNextQueued, setIssueStatus, getSeriesById, getCvSeries, listIssues, recordGrab, recordImport, seriesSearchNames } from './db.js';
import { detectEdition } from './editions.js';
import { fileStemFromPattern } from './naming.js';
import { resolveSeriesDir } from './paths.js';
import { indexDownloadedFile } from './library.js';
import { tagCbzBuffer, taggingEnabled, xmlForIssue } from './metatagger.js';
import { cbrBufferToCbz } from './archive.js';
import { makeCvClient } from './cv.js';
// NOTE: sources/index.js is imported lazily inside runQueue to avoid a module
// cycle (a source that builds files imports from here).

export { detectEdition }; // re-exported for existing importers

// The trailing numeric id of a source URL (used to disambiguate a duplicate
// filename). Returns the id string, or null for URLs without one (e.g. cvissue:).
export function trailingIdFromUrl(url) {
  const m = String(url).match(/\/(\d+)(?:[#?].*)?$/);
  return m ? m[1] : null;
}

export function safeName(s) {
  return String(s).replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const MONTHS =['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const pad3 = (n) => { const s = String(n ?? ''); return /^\d+$/.test(s) ? s.padStart(3, '0') : safeName(s); };

// Filename library managers (Komga/Kavita/Mylar) parse cleanly: "Series VYYYY #NNN (Month
// YYYY)" — series without an inline year, V<volume year>, '#' + zero-padded
// number, optional cover date. Special editions become "Series VYYYY <Type> #NNN"
// (e.g. "… Annual #001", "… TPB #002") so they don't collide with the issue of
// the same number. `issueTitle` (the source chapter title) drives edition detection.
export function comicFileName(seriesTitle, number, issueDate, issueTitle, year) {
  const volYear = year || yearFromTitle(seriesTitle);
  const cleanSeries = safeName(String(seriesTitle).replace(/\([^)]*\)\s*$/, '').trim());
  const ed = issueTitle ? detectEdition(issueTitle) : null;
  let core;
  if (ed) core = ed.num != null ? `${ed.type} #${pad3(ed.num)}` : ed.type;
  else core = `#${pad3(number)}`;
  let name = `${cleanSeries}${volYear ? ` V${volYear}` : ''} ${core}`.replace(/\s+/g, ' ').trim();
  const d = issueDate && String(issueDate).match(/^(\d{4})-(\d{2})/);
  if (d) name += ` (${MONTHS[Number(d[2]) - 1]} ${d[1]})`;
  return name;
}

export function targetPath(seriesTitle, issue, format = 'cbz', year, baseDir) {
  const folder = safeName(seriesTitle);
  const ext = format === 'pdf' ? 'pdf' : 'cbz';
  const hasNum = issue.issue_number != null && /[\d½¼¾⅓⅔⅛]/.test(String(issue.issue_number));
  const ed = detectEdition(issue.title);
  const stem = (hasNum || ed)
    ? fileStemFromPattern({ title: seriesTitle, publisher: issue.publisher || '', year }, issue, config.filePattern)
    : `${folder} - ${safeName(issue.title)}`;
  // Save into the comic's own folder when we have one; else legacy downloads/<Series>.
  const dir = baseDir || path.join(config.downloadsDir, folder);
  return path.join(dir, `${stem}.${ext}`);
}

export async function buildCbz(pages) {
  const zip = new JSZip();
  for (const p of pages) zip.file(p.name, p.buffer);
  return zip.generateAsync({ type: 'nodebuffer' });
}

export function pdfEmbeddable(pages) {
  return pages.every((p) => /\.(jpe?g|png)$/i.test(p.name));
}

export async function buildPdf(pages, meta = {}) {
  const doc = await PDFDocument.create();
  if (meta.title) doc.setTitle(meta.title);
  if (meta.publisher) doc.setAuthor(meta.publisher);
  if (meta.seriesTitle) doc.setSubject(meta.seriesTitle);
  for (const p of pages) {
    const img = /\.png$/i.test(p.name) ? await doc.embedPng(p.buffer) : await doc.embedJpg(p.buffer);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  return Buffer.from(await doc.save());
}

export function yearFromTitle(title) {
  const m = String(title).match(/\((\d{4})/);
  return m ? m[1] : null;
}

// Clean series name for ComicVine search: drop a trailing "(year)" / "[tag]"
// (repeated), keep colons/apostrophes. e.g. "Injustice: Gods Among Us [I]" -> "Injustice: Gods Among Us".
export function seriesForSearch(title) {
  let s = String(title ?? '').trim();
  let prev;
  do { prev = s; s = s.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim(); } while (s !== prev);
  return s;
}

// Write a finished download to its destination (creating the folder).
export async function placeFile({ buffer, destPath }) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, buffer);
  return { path: destPath };
}

function uniquePath(p) {
  const m = p.match(/^(.*?)(\.[^.\/\\]+)$/);
  const base = m ? m[1] : p, ext = m ? m[2] : '';
  let i = 2;
  while (existsSync(`${base} (${i})${ext}`)) i++;
  return `${base} (${i})${ext}`;
}

// Shared import step for every download source: take a finished comic (buffer or
// a file on disk), bake in the ComicVine ComicInfo.xml (if provided), and place
// it in the comic's folder. Returns { path, tagged }.
export async function finalizeComic({ buffer, srcPath, format = 'cbz', issue, seriesTitle, seriesYear, seriesPath, comicInfoXml = null }) {
  let buf = buffer || (srcPath ? await fsp.readFile(srcPath) : null);
  if (!buf) throw new Error('no comic data to finalize');
  // Sniff the REAL container from magic bytes, not the source's extension — a
  // source can hand us a .cbr (RAR) or a mislabeled file. A RAR must be repacked
  // to a real zip before we can tag it (tagCbzBuffer is JSZip) or file it as
  // .cbz; otherwise JSZip throws "Can't find end of central directory". This is
  // the download-import conversion path cbrBufferToCbz is meant to own.
  if (buf[0] === 0x50 && buf[1] === 0x4b) format = 'cbz';                     // "PK" → ZIP
  else if (buf.toString('latin1', 0, 4) === 'Rar!') { buf = await cbrBufferToCbz(buf); format = 'cbz'; } // "Rar!" → repack
  else if (buf.toString('latin1', 0, 4) === '%PDF') format = 'pdf';          // "%PDF"
  else {
    // Unrecognizable container = a corrupt/bogus download (truncated file, an
    // error page, junk a peer shares). Fail CLEARLY here rather than letting
    // the zip tagger throw its cryptic 'end of central directory' error.
    throw new Error('downloaded file is not a comic archive (corrupt or bogus source copy)');
  }

  // "Rename downloads" off: keep the source's original filename (usenet/torrent
  // completed files have one) — still filed into the comic's folder, with the
  // extension corrected to the sniffed container. Built-from-pages downloads
  // have no original name, so those always use the pattern.
  let dest;
  if (!config.renameDownloads && srcPath) {
    const stem = safeName(path.basename(srcPath).replace(/\.[^.]+$/, ''));
    const dir = seriesPath || path.join(config.downloadsDir, safeName(seriesTitle));
    dest = path.join(dir, `${stem}.${format === 'pdf' ? 'pdf' : 'cbz'}`);
  } else {
    dest = targetPath(seriesTitle, issue, format, seriesYear, seriesPath);
  }
  if (existsSync(dest)) {
    const cid = trailingIdFromUrl(issue.url); // stable source id when present
    dest = cid ? dest.replace(/(\.(?:cbz|pdf))$/i, ` (${cid})$1`) : uniquePath(dest);
  }
  let tagged = false;
  if (format === 'cbz' && comicInfoXml) { buf = await tagCbzBuffer(buf, comicInfoXml); tagged = true; }
  await placeFile({ buffer: buf, destPath: dest });
  return { path: dest, tagged };
}

// Recover issues left in 'downloading' by a previous crashed/killed run:
// if the CBZ already exists on disk it's done (no duplicate re-download),
// otherwise back to 'queued' — it was in-flight work, so it resumes with
// the rest of the queue when the boot kick-off runs.
export function reconcileDownloading(db) {
  for (const status of ['downloading', 'tagging']) {
    for (const issue of listIssues(db, { status })) {
      const sr = getSeriesById(db, issue.series_id);
      const title = sr?.title || 'Unknown';
      const cbz = targetPath(title, issue, 'cbz', sr?.year);
      const pdf = targetPath(title, issue, 'pdf', sr?.year);
      const existing = existsSync(cbz) ? cbz : existsSync(pdf) ? pdf : null;
      if (existing) setIssueStatus(db, issue.id, 'done', { filePath: existing });
      else setIssueStatus(db, issue.id, 'queued');
    }
  }
}

// Build the ComicVine-derived context an issue needs for filing + tagging:
// the display title/publisher/year, the target folder, and the ComicInfo.xml.
// Shared by the download worker and the background monitor. `cvClient` is a
// lazy getter so a keyless/tagging-off run never constructs a client.
export async function buildIssueContext(db, issue, cvClient) {
  const series = getSeriesById(db, issue.series_id);
  const cv = series?.cv_id ? getCvSeries(db, series.cv_id) : null;
  const seriesTitle = cv?.name || series?.title || 'Unknown';
  const publisher = cv?.publisher || series?.publisher;
  const seriesYear = cv?.start_year || series?.year;
  const seriesPath = series ? resolveSeriesDir(db, series) : undefined;
  // Every name a source may find this volume under (title + CV/user aliases) —
  // used to search and match indexers that name it differently.
  const seriesNames = series ? seriesSearchNames(db, series.id) : [seriesTitle];
  let comicInfoXml = null;
  if (taggingEnabled() && series?.cv_id) {
    try { comicInfoXml = await xmlForIssue(db, cvClient(), series, issue.issue_number); }
    catch (e) { console.warn('comicinfo build failed', issue.title, e?.message || e); }
  }
  return { series, cv, seriesTitle, seriesNames, publisher, seriesYear, seriesPath, comicInfoXml };
}

// Shared import tail: place the finished comic, mark the issue done, index it as
// owned, and emit tag-log/done progress. Used by both the immediate download path
// and the deferred (usenet) monitor.
export async function finishImport(db, { issue, ic, fetched, source, onProgress = () => {} }) {
  const result = await finalizeComic({ ...fetched, issue, seriesTitle: ic.seriesTitle, seriesYear: ic.seriesYear, seriesPath: ic.seriesPath, comicInfoXml: ic.comicInfoXml });
  setIssueStatus(db, issue.id, 'done', { filePath: result.path });
  // A cvissue:<id> row IS a specific ComicVine issue — pass that identity through
  // so the index links this file authoritatively (a release's embedded ComicInfo
  // can carry a wrong number, which would mislead the number-based relink).
  const cvIssueId = Number((/^cvissue:(\d+)$/.exec(String(issue.url || '')) || [])[1]) || null;
  try { await indexDownloadedFile(db, { path: result.path, seriesId: issue.series_id, issueId: issue.id, cvId: ic.series?.cv_id, cvIssueId }); }
  catch (e) { console.warn('index downloaded file failed', result.path, e?.message || e); }
  recordImport(db, { seriesId: issue.series_id, seriesTitle: ic.seriesTitle, issueTitle: issue.title, issueNumber: issue.issue_number, cvIssueId, source, path: result.path });
  if (taggingEnabled()) {
    onProgress({ event: 'tag-result', issue, series: ic.seriesTitle, source, result: {
      outcome: result.tagged ? 'tagged' : 'no-match',
      reason: result.tagged ? 'ComicVine metadata embedded' : (ic.series?.cv_id ? 'no matching ComicVine issue' : 'series not matched to ComicVine'),
      path: result.path,
    } });
  }
  onProgress({ event: 'done', issue, filePath: result.path, source });
  return result;
}

export async function runQueue({ db, onProgress = () => {}, concurrency = config.downloadConcurrency, isPaused = () => false, pinnedFor = () => null, consumePin = () => {} }) {
  reconcileDownloading(db);
  const { orderedSources } = await import('./sources/index.js');
  const { loadPlugins } = await import('./plugins.js');
  await loadPlugins(); // ensure external source plugins are registered
  const sources = orderedSources(config);

  // One CV client per queue run, created lazily (tagging may be off / keyless).
  let cvc = null;
  const cvClient = () => (cvc ||= makeCvClient(config));
  // Keep the worker pool alive briefly while the queue is active so issues added
  // one-at-a-time keep using full concurrency instead of collapsing to one worker.
  let busy = 0;
  let lastActivity = Date.now();
  const IDLE_GRACE_MS = 2000;

  // Each worker pulls queued issues. claimNextQueued marks the issue
  // 'downloading' atomically so two workers never grab the same one. When the
  // queue is empty, a worker idle-polls and exits only once nothing is queued or
  // in flight and the queue has been idle for the grace window. The queue is
  // source-agnostic: a source that needs a browser (e.g. a plugin) owns its own.
  const worker = async () => {
    for (;;) {
      if (isPaused()) { lastActivity = Date.now(); await sleep(400); continue; }
      const issue = claimNextQueued(db);
      if (!issue) {
        if (busy === 0 && Date.now() - lastActivity > IDLE_GRACE_MS) break;
        await sleep(250);
        continue;
      }
      lastActivity = Date.now();
      busy++;
      try {
      const ic = await buildIssueContext(db, issue, cvClient);
      const ctx = { db, config, issue, ...ic };
      // A manual pick (from the multi-source search) pins a specific candidate
      // from a specific source to this issue: try ONLY that source with that
      // candidate — the user chose it, so don't silently fall through to others.
      // Otherwise try each enabled source in priority order; first match wins.
      const pin = pinnedFor(issue.id);
      const trySources = pin ? sources.filter((s) => s.id === pin.source) : sources;
      let lastErr;
      let handled = false;
      for (const src of trySources) {
        let candidate;
        if (pin && pin.source === src.id) candidate = pin.candidate;
        else {
          // Searching a source is the real (and sometimes slow) work at the
          // start of a download — surface it so the queue row honestly says
          // "Searching…" instead of nothing (or a misleading fallback label).
          onProgress({ event: 'searching', issue, source: src.id, phase: 'searching' });
          try { candidate = await src.find(ctx); }
          catch (err) { lastErr = err; continue; }
        }
        if (!candidate) continue;

        if (src.kind === 'deferred') {
          // Hand off to an external client and record the grab; the background
          // monitor imports it when the client finishes. The worker returns its
          // slot immediately rather than blocking for the whole download.
          try {
            onProgress({ event: 'start', issue, source: src.id });
            const g = await src.grab(candidate, ctx);
            recordGrab(db, { issueId: issue.id, source: src.id, client: g.client, downloadId: g.downloadId, category: g.category, title: g.title, releaseGuid: g.releaseGuid });
            setIssueStatus(db, issue.id, 'grabbed');
            onProgress({ event: 'grabbed', issue, source: src.id, phase: 'grabbed' });
            handled = true;
          } catch (err) { lastErr = err; }
          if (handled) break;
          continue;
        }

        for (let attempt = 1; attempt <= 3 && !handled; attempt++) {
          try {
            onProgress({ event: 'start', issue, source: src.id });
            const fetched = await src.fetch(candidate, ctx, (p) =>
              onProgress({ event: 'page', issue, page: p.done, pages: p.total, source: src.id, phase: p.phase,
                // Optional richer progress (byte-stream sources): unit tells the
                // UI how to read page/pages, bps is speed, detail is a host label.
                unit: p.unit, bps: p.bps, detail: p.detail }));
            await finishImport(db, { issue, ic, fetched, source: src.id, onProgress });
            handled = true;
          } catch (err) {
            lastErr = err;
            // A source can mark an error fatal-for-this-issue (err.noRetry) when
            // retrying can't help — e.g. AirDC++ has the file on disk but we
            // can't locate it, so re-searching just loops. Stop the flicker.
            if (err?.noRetry) break;
            await sleep(config.actionDelayMs * attempt * 2);
          }
        }
        if (handled) break;
      }
      if (!handled) {
        // Distinguish a source erroring from simply finding nothing (lastErr stays
        // undefined when every source's find() returned null) — otherwise the
        // recorded error is the useless literal "undefined".
        const reason = lastErr ? String(lastErr.message || lastErr)
          : sources.length ? 'No enabled source had a match for this issue'
          : 'No download sources are enabled';
        // The queue row only shows the message — log the stack so a generic
        // error (e.g. a driver-level throw) is traceable to its actual source.
        if (lastErr?.stack) console.warn(`download failed for issue ${issue.id} (${issue.title}):`, lastErr.stack);
        setIssueStatus(db, issue.id, 'failed', { error: reason });
        onProgress({ event: 'failed', issue, error: reason });
      }
      } finally { consumePin(issue.id); busy--; lastActivity = Date.now(); }
    }
  };

  const n = Math.max(1, concurrency);
  await Promise.all(Array.from({ length: n }, () => worker()));
}
