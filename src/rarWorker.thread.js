// RAR work for src/rarWorker.js, off the main thread: node-unrar-js decodes
// synchronously in WASM, which held the event loop for seconds on a big .cbr.
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import JSZip from 'jszip';
import { createExtractorFromData } from 'node-unrar-js';

const toArrayBuffer = (buf) =>
  (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength)
    ? buf.buffer
    : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const isCI = (name) => /(^|\/)ComicInfo\.xml$/i.test(String(name));

const OPS = {
  // Entry names, plus the ComicInfo.xml text when there is one.
  async info({ path }) {
    const extractor = await createExtractorFromData({ data: toArrayBuffer(fs.readFileSync(path)) });
    const names = [...extractor.getFileList().fileHeaders].filter((h) => !h.flags?.directory).map((h) => h.name);
    const ciNames = names.filter(isCI);
    let ciXml = null;
    if (ciNames.length) {
      // A failed content extract (e.g. a solid archive) means metadata unknown, not corrupt.
      try {
        const arr = [...extractor.extract({ files: ciNames }).files];
        if (arr[0]?.extraction) ciXml = Buffer.from(arr[0].extraction).toString('utf8');
      } catch { /* metadata unknown */ }
    }
    return { result: { names, hasCi: ciNames.length > 0, ciXml } };
  },
  // Every file entry's name, as stored in the archive (no decompression).
  async list({ path }) {
    const ex = await createExtractorFromData({ data: toArrayBuffer(fs.readFileSync(path)) });
    return { result: [...ex.getFileList().fileHeaders].filter((h) => !h.flags?.directory).map((h) => h.name) };
  },
  // [name, bytes] for the named entries (names as stored), or every file entry
  // when `files` is null. Bytes are transferred, not copied.
  async extract({ path, files }) {
    const ex = await createExtractorFromData({ data: toArrayBuffer(fs.readFileSync(path)) });
    const entries = [];
    for (const f of ex.extract(files ? { files } : {}).files) {
      if (f.extraction && !f.fileHeader.flags?.directory) entries.push([f.fileHeader.name, toArrayBuffer(f.extraction)]);
    }
    return { result: entries, transfer: entries.map(([, b]) => b) };
  },
  // How many entries inflate (all of them, in archive order: solid-archive safe).
  async verify({ path }) {
    const ex = await createExtractorFromData({ data: toArrayBuffer(fs.readFileSync(path)) });
    let extracted = 0;
    for (const f of ex.extract({}).files) {
      if (f.fileHeader.flags?.directory) continue;
      if (f.extraction) extracted++;
    }
    return { result: { extracted } };
  },
  // RAR bytes → CBZ bytes (STORE), every entry in archive order.
  async toCbz({ data }) {
    const extractor = await createExtractorFromData({ data });
    const zip = new JSZip();
    for (const f of extractor.extract({}).files) {
      if (f.extraction && !f.fileHeader.flags?.directory) zip.file(f.fileHeader.name.replace(/\\/g, '/'), f.extraction);
    }
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    const ab = toArrayBuffer(out);
    return { result: ab, transfer: [ab] };
  },
};

parentPort.on('message', async ({ id, op, args }) => {
  try {
    const { result, transfer } = await OPS[op](args);
    parentPort.postMessage({ id, result }, transfer || []);
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.message || e) });
  }
});
