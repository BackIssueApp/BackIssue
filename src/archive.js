import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import yauzl from 'yauzl';
import { load } from 'cheerio';
import { createExtractorFromData } from 'node-unrar-js';
import JSZip from 'jszip';

const IMG_RE = /\.(jpe?g|png|webp|gif|bmp)$/i;
export function isImageName(name) { return IMG_RE.test(String(name)); }

// ArrayBuffer for node-unrar-js without copying when possible. A Buffer from
// fs.readFile of a non-tiny file owns its whole ArrayBuffer, so we can hand it
// over directly; only pooled/sliced buffers need a sized copy. Avoiding the copy
// halves peak memory for big archives.
const toArrayBuffer = (buf) =>
  (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength)
    ? buf.buffer
    : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// node-unrar-js has no streaming API — it loads the ENTIRE .cbr into memory (RAR
// has no seekable directory). Two safeguards keep this from OOM-crashing the
// process (which is uncatchable):
//  1. A concurrency gate — at most a few whole-archive RAR loads at once,
//     regardless of the caller's concurrency, so a folder of large .cbr files
//     can't multiply into gigabytes.
//  2. A hard ceiling — above this a single file could exceed the WASM heap on
//     its own, so we skip inspection and just treat it as present.
const MAX_RAR_BYTES = 400 * 1024 * 1024;
const MAX_RAR_CONCURRENT = 2;
let rarActive = 0;
const rarQueue = [];
// Run fn while holding one of MAX_RAR_CONCURRENT slots; queues if none free.
function withRarSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      rarActive++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        rarActive--;
        const next = rarQueue.shift();
        if (next) next();
      });
    };
    if (rarActive < MAX_RAR_CONCURRENT) run(); else rarQueue.push(run);
  });
}
const isCI = (name) => /(^|\/)ComicInfo\.xml$/i.test(String(name));

// Parse the fields we care about out of a ComicInfo.xml string.
export function parseComicInfo(xml) {
  try {
    const $ = load(xml, { xmlMode: true });
    const g = (t) => { const v = $(t).first().text().trim(); return v || null; };
    return { series: g('Series'), number: g('Number'), volume: g('Volume'), title: g('Title'), count: g('Count'), publisher: g('Publisher'), year: g('Year'),
      // Where taggers leave ComicVine breadcrumbs: Web is the CV detail URL,
      // Notes carries the id (ComicTagger's "[CVDB123]", Kapowarr/Mylar's
      // "Issue ID 123"). Used by the import scan's exact-match fast path.
      web: g('Web'), notes: g('Notes') };
  } catch { return null; }
}

// .cbz — read only the ZIP central directory (yauzl seeks to it), then extract
// just ComicInfo.xml if present. Reads ~KB, not the whole file.
function readZipInfo(path) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return done({ ok: false, format: 'cbz', error: String(err?.message || 'open failed') });
      const names = [];
      let hasComicInfo = false;
      let comicInfo = null;
      zip.on('error', (e) => done({ ok: false, format: 'cbz', error: String(e?.message || e) }));
      zip.on('entry', (entry) => {
        names.push(entry.fileName);
        // Read ComicInfo.xml inline (openReadStream only works during iteration).
        if (isCI(entry.fileName)) {
          hasComicInfo = true;
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return zip.readEntry();
            const chunks = [];
            stream.on('data', (c) => chunks.push(c));
            stream.on('end', () => { comicInfo = parseComicInfo(Buffer.concat(chunks).toString('utf8')); zip.readEntry(); });
            stream.on('error', () => zip.readEntry());
          });
        } else {
          zip.readEntry();
        }
      });
      zip.on('end', () => done({ ok: true, format: 'cbz', pageCount: names.filter(isImageName).length, hasComicInfo, comicInfo }));
      zip.readEntry();
    });
  });
}

// .cbr — RAR has no end-of-file directory, so read the whole buffer (rare).
async function readRarInfo(path) {
  // Above the ceiling, don't risk loading it into memory at all.
  const size = await fs.stat(path).then((s) => s.size).catch(() => 0);
  if (size > MAX_RAR_BYTES) {
    return { ok: true, format: 'cbr', pageCount: null, hasComicInfo: false, comicInfo: null, oversized: true };
  }
  return withRarSlot(async () => {
    try {
      const buf = await fs.readFile(path);
      const extractor = await createExtractorFromData({ data: toArrayBuffer(buf) });
      const names = [...extractor.getFileList().fileHeaders].filter((h) => !h.flags?.directory).map((h) => h.name);
      const pageCount = names.filter(isImageName).length;
      const ciNames = names.filter(isCI);
      let comicInfo = null;
      if (ciNames.length) {
        // getFileList already proved the archive is valid; a failed content
        // extract (e.g. a solid archive) just means metadata is unknown, not corrupt.
        try {
          const arr = [...extractor.extract({ files: ciNames }).files];
          if (arr[0]?.extraction) comicInfo = parseComicInfo(Buffer.from(arr[0].extraction).toString('utf8'));
        } catch { /* metadata unknown */ }
      }
      return { ok: true, format: 'cbr', pageCount, hasComicInfo: ciNames.length > 0, comicInfo };
    } catch (e) {
      return { ok: false, format: 'cbr', error: String(e?.message || e) };
    }
  });
}

// Detect the real archive format from its magic bytes — comic files are very
// often mislabeled (a RAR saved as .cbz, a ZIP saved as .cbr). Returns 'cbz' /
// 'cbr' / 'pdf', or null if the header is unreadable/unrecognized (caller then
// falls back to the extension). Real comic readers sniff too; trusting the
// extension is what made us flag readable files as "corrupt".
export async function sniffFormat(p) {
  let fh;
  try {
    fh = await fs.open(p, 'r');
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(8), 0, 8, 0);
    if (bytesRead >= 4) {
      if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'cbz';           // "PK"  → ZIP
      if (buffer.toString('latin1', 0, 4) === 'Rar!') return 'cbr';         // "Rar!" → RAR
      if (buffer.toString('latin1', 0, 4) === '%PDF') return 'pdf';         // "%PDF"
    }
  } catch { /* unreadable header → fall back to extension */ }
  finally { await fh?.close(); }
  return null;
}

export async function readArchiveInfo(path) {
  const p = String(path);
  const byExt = /\.cbr$/i.test(p) ? 'cbr' : 'cbz';
  if (!existsSync(p)) return { ok: false, format: byExt, error: 'missing' };
  // Prefer the sniffed format so a mislabeled file (RAR bytes in a .cbz, etc.)
  // is read with the right decoder instead of being reported corrupt.
  const fmt = (await sniffFormat(p)) ?? byExt;
  return fmt === 'cbr' ? readRarInfo(p) : readZipInfo(p);
}

// Convert RAR bytes (a .cbr) into CBZ bytes in memory — THE one cbr→cbz core.
// Every conversion path (file convert, in-place repack, download import) must go
// through this: it extracts ALL entries in archive order (solid-archive safe;
// per-file subsets can spuriously fail on solid RARs), preserves ComicInfo.xml,
// uses STORE (pages are already-compressed JPEG/PNG — re-deflating burns CPU for
// ~zero gain), and runs inside the RAR concurrency gate with the size ceiling so
// concurrent conversions can't multiply into an uncatchable OOM.
export async function cbrBufferToCbz(buffer) {
  if (buffer.byteLength > MAX_RAR_BYTES) throw new Error(`too large to convert safely (${Math.round(buffer.byteLength / 1024 / 1024)}MB)`);
  return withRarSlot(async () => {
    const extractor = await createExtractorFromData({ data: toArrayBuffer(buffer) });
    const zip = new JSZip();
    for (const f of extractor.extract({}).files) {
      if (f.extraction && !f.fileHeader.flags?.directory) zip.file(f.fileHeader.name.replace(/\\/g, '/'), f.extraction);
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  });
}

// Convert a .cbr FILE into a .cbz (preserving all entries incl. ComicInfo.xml),
// written atomically, then remove the .cbr. Never clobbers an existing .cbz.
export async function convertCbrToCbz(path) {
  const cbzPath = String(path).replace(/\.cbr$/i, '.cbz');
  if (cbzPath === String(path)) throw new Error('not a .cbr');
  if (existsSync(cbzPath)) throw new Error('target .cbz already exists');
  // Many ".cbr" files are actually ZIPs (mislabeled). There's nothing to unpack —
  // just rename so the extension is honest. (Feeding a ZIP to the RAR extractor is
  // exactly what produced "File is not RAR archive".)
  if ((await sniffFormat(path)) === 'cbz') {
    await fs.rename(path, cbzPath);
    return { cbzPath, renamed: true };
  }
  await assertRarConvertible(path); // stat check — don't read an oversized file into memory
  const out = await cbrBufferToCbz(await fs.readFile(path));
  const tmp = cbzPath + '.part';
  await fs.writeFile(tmp, out);
  await fs.rename(tmp, cbzPath);
  await fs.unlink(path);
  return { cbzPath };
}

// Repack a mislabeled archive — RAR bytes carrying a .cbz/.zip name — into a
// genuine ZIP at the SAME path, so the extension finally tells the truth. Every
// entry (pages + ComicInfo.xml) is preserved; the rewrite is atomic (temp file +
// rename) so a crash mid-write can't leave a half-file. Returns { repacked, bytes }.
// Cheap stat-level guard so file-based converters never read an oversized RAR
// into memory just to have cbrBufferToCbz reject it.
async function assertRarConvertible(p) {
  const size = await fs.stat(p).then((s) => s.size).catch(() => 0);
  if (size > MAX_RAR_BYTES) throw new Error(`too large to convert safely (${Math.round(size / 1024 / 1024)}MB)`);
}

export async function repackRarAsZip(path) {
  const p = String(path);
  await assertRarConvertible(p);
  const out = await cbrBufferToCbz(await fs.readFile(p)); // shared core: guarded, solid-safe
  const tmp = p + '.part';
  await fs.writeFile(tmp, out);
  await fs.rename(tmp, p);
  return { repacked: true, bytes: out.length };
}

// Deep integrity: read/inflate every entry; ok:false if any fails.
export async function verifyArchive(path) {
  const info = await readArchiveInfo(path);
  if (!info.ok) return { ok: false, error: info.error };
  // Use the format readArchiveInfo actually decoded (sniffed), not the extension
  // — a RAR-content .cbz must be verified as RAR, not handed to the zip reader.
  if (info.format === 'cbr') {
    // Too large to inflate in memory without risking an OOM — don't flag it
    // corrupt, just skip the deep check.
    const size = await fs.stat(path).then((s) => s.size).catch(() => 0);
    if (size > MAX_RAR_BYTES) return { ok: true, skipped: 'too large to verify' };
    return withRarSlot(async () => {
    try {
      const buf = await fs.readFile(path);
      const ex = await createExtractorFromData({ data: toArrayBuffer(buf) });
      // Extract ALL entries in archive order — solid-archive safe. A per-file
      // subset (extract({ files })) can spuriously fail on solid RARs and flag a
      // perfectly good file as corrupt. getFileList already proved the structure;
      // this confirms the entries actually inflate.
      let extracted = 0;
      for (const f of ex.extract({}).files) {
        if (f.fileHeader.flags?.directory) continue;
        if (f.extraction) extracted++;
      }
      return extracted > 0 ? { ok: true } : { ok: false, error: 'no readable entries' };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    // autoClose:false — we close the fd ourselves, only once every entry has
    // fully drained. The default (autoClose) closes on the 'end' of entry
    // *enumeration*, which with concurrent read streams races the still-pending
    // reads and crashes fd-slicer with "Cannot read properties of null (fd)".
    // validateEntrySizes:false — some real-world CBZs declare an uncompressed size
    // that's off by a byte from what the deflate stream actually yields; every
    // comic reader opens them fine, so an off-by-one size is not corruption. We
    // still catch true corruption because a broken deflate stream errors in zlib.
    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: false }, (err, zip) => {
      if (err || !zip) return resolve({ ok: false, error: String(err?.message || 'open') });
      let bad = false;
      const fin = (v) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* already closed */ }
        resolve(v);
      };
      zip.on('error', () => fin({ ok: false, error: 'zip error' }));
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        // Read this entry to completion BEFORE requesting the next one, so at most
        // one read stream is ever open — no fd is closed with reads outstanding.
        zip.openReadStream(entry, (e, s) => {
          if (e || !s) { bad = true; return zip.readEntry(); }
          s.on('data', () => {});
          s.on('error', () => { bad = true; zip.readEntry(); });
          s.on('end', () => zip.readEntry());
        });
      });
      zip.on('end', () => fin({ ok: !bad, error: bad ? 'entry crc/read failed' : undefined }));
      zip.readEntry();
    });
  });
}
