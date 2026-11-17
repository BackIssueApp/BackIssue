// Lossless PDF / EPUB → CBZ for downloads (Settings → Library → "Convert PDF
// and EPUB downloads to CBZ"). Official digital volumes come as a PDF or a
// fixed-layout EPUB holding exactly one image per page; those images are
// copied out as they are (a JPEG stays the same bytes, a raw Flate image is
// wrapped as a PNG) and zipped in page order, so the result can carry
// ComicInfo.xml and be read like any other comic. Nothing is ever rendered:
// a file that is not one-image-per-page is reported, not approximated, and
// the caller keeps the original.
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFNumber, decodePDFRawStream } from 'pdf-lib';

const MAX_BYTES = 512 * 1024 * 1024; // pdf-lib parses in memory
const pageName = (i, total, ext) => `${String(i).padStart(Math.max(3, String(total).length), '0')}.${ext}`;
const STORE = { type: 'nodebuffer', compression: 'STORE' };

// ---------------------------------------------------------------- PNG
// A minimal PNG writer for 8-bit RGB or grayscale pixels: what a Flate image
// in a PDF decodes to. No alpha, no palette — those pages are refused above.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
export function encodePng({ width, height, channels, pixels }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 3 ? 2 : 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- PDF
const nameOf = (v) => (v instanceof PDFName ? v.decodeText() : null);
function filtersOf(dict) {
  const f = dict.get(PDFName.of('Filter'));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map(nameOf).filter(Boolean);
  return [];
}
// Channels of an image's colour space, or null when it is not plain RGB/gray
// (indexed, CMYK, separations…), which a PNG cannot carry as-is.
function channelsOf(doc, cs) {
  const n = nameOf(cs);
  if (n === 'DeviceRGB' || n === 'CalRGB') return 3;
  if (n === 'DeviceGray' || n === 'CalGray') return 1;
  if (cs instanceof PDFArray && cs.size() >= 2 && nameOf(cs.get(0)) === 'ICCBased') {
    const s = doc.context.lookup(cs.get(1));
    const N = s?.dict?.get(PDFName.of('N'));
    if (N instanceof PDFNumber) return N.asNumber() === 3 ? 3 : N.asNumber() === 1 ? 1 : null;
  }
  return null;
}
// The page file for one image XObject, or why it cannot be one.
function imageFile(doc, s) {
  const d = s.dict;
  const filters = filtersOf(d);
  if (filters.includes('JPXDecode')) return { reason: 'JPEG 2000 image' };
  if (filters.includes('CCITTFaxDecode') || filters.includes('JBIG2Decode')) return { reason: 'fax-encoded image' };
  if (filters.includes('DCTDecode')) {
    if (filters.length !== 1) return { reason: 'JPEG wrapped in another encoding' };
    return { ext: 'jpg', buffer: Buffer.from(s.contents) }; // the JPEG, byte for byte
  }
  if (d.has(PDFName.of('SMask')) || d.has(PDFName.of('Mask')) || d.has(PDFName.of('Decode'))) return { reason: 'image with a mask or decode array' };
  const bpc = d.get(PDFName.of('BitsPerComponent'));
  if (!(bpc instanceof PDFNumber) || bpc.asNumber() !== 8) return { reason: 'image is not 8 bits per channel' };
  const channels = channelsOf(doc, d.get(PDFName.of('ColorSpace')));
  if (!channels) return { reason: 'image colour space is not RGB or grayscale' };
  const width = d.get(PDFName.of('Width'))?.asNumber?.(), height = d.get(PDFName.of('Height'))?.asNumber?.();
  if (!width || !height) return { reason: 'image has no size' };
  let pixels;
  try { pixels = decodePDFRawStream(s).decode(); } catch (e) { return { reason: `image could not be decoded (${e?.message || e})` }; }
  if (pixels.length !== width * height * channels) return { reason: 'image data does not match its size' };
  return { ext: 'png', buffer: encodePng({ width, height, channels, pixels }) };
}
// Does the page's content stream draw text? Strings are blanked first so a
// quote inside one is not read as the ' or " operator.
function drawsText(doc, page) {
  const c = page.node.Contents();
  if (!c) return false;
  const refs = c instanceof PDFArray ? c.asArray() : [c];
  for (const r of refs) {
    const s = r instanceof PDFRawStream ? r : doc.context.lookup(r);
    if (!(s instanceof PDFRawStream)) return true; // cannot tell: assume content we would lose
    let txt;
    try { txt = Buffer.from(decodePDFRawStream(s).decode()).toString('latin1'); } catch { return true; }
    const stripped = txt.replace(/\\[()\\]/g, '').replace(/\([^)]*\)/g, '()').replace(/<[0-9a-fA-F\s]*>/g, '<>');
    if (/(^|[\s\]>)])(Tj|TJ|'|")(?=\s|$)/.test(stripped)) return true;
  }
  return false;
}

/** Copy a one-image-per-page PDF's images into a CBZ. Resolves to
 *  { buffer, pages } or { reason } when the PDF is not that kind of file. */
export async function pdfToCbz(bytes) {
  if (bytes.length > MAX_BYTES) return { reason: 'PDF too large to convert in memory' };
  let doc, pages;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    pages = doc.getPages();
  } catch (e) { return { reason: `unreadable PDF (${e?.message || e})` }; }
  if (!pages.length) return { reason: 'no pages' };
  const out = new JSZip();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const res = page.node.Resources();
    const xo = res?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const images = [];
    if (xo) {
      for (const [, ref] of xo.entries()) {
        const s = doc.context.lookup(ref);
        if (!(s instanceof PDFRawStream)) continue;
        const sub = nameOf(s.dict.get(PDFName.of('Subtype')));
        if (sub === 'Image') images.push(s);
        else if (sub === 'Form') return { reason: `page ${i + 1} has drawn content, not one image` };
      }
    }
    if (images.length !== 1) return { reason: `page ${i + 1} has ${images.length} images, not one` };
    if (drawsText(doc, page)) return { reason: `page ${i + 1} has text over the image` };
    const img = imageFile(doc, images[0]);
    if (!img.buffer) return { reason: `page ${i + 1}: ${img.reason}` };
    out.file(pageName(i + 1, pages.length, img.ext), img.buffer);
  }
  return { buffer: await out.generateAsync(STORE), pages: pages.length };
}

// ---------------------------------------------------------------- EPUB
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`, 'i')); return m ? (m[1] ?? m[2]) : null; };
const join = (dir, rel) => path.posix.normalize(path.posix.join(dir, rel)).replace(/^\.\//, '');
const IMG = /\.(jpe?g|png|gif|webp)$/i;

/** Is this zip an EPUB? (A fixed-layout EPUB sniffs as a plain zip.) */
export async function isEpub(bytes) {
  const zip = await JSZip.loadAsync(bytes).catch(() => null);
  if (!zip) return false;
  if (zip.file('META-INF/container.xml')) return true;
  const mt = zip.file('mimetype');
  return !!mt && /^application\/epub\+zip/.test(await mt.async('string'));
}

/** Copy a fixed-layout EPUB's page images, in spine order, into a CBZ.
 *  Resolves to { buffer, pages } or { reason }. */
export async function epubToCbz(bytes) {
  const zip = await JSZip.loadAsync(bytes).catch(() => null);
  if (!zip) return { reason: 'not a zip' };
  const container = zip.file('META-INF/container.xml');
  if (!container) return { reason: 'no META-INF/container.xml' };
  const rootfile = (await container.async('string')).match(/<rootfile\b[^>]*>/i);
  const opfPath = rootfile ? attr(rootfile[0], 'full-path') : null;
  const opfFile = opfPath && zip.file(opfPath);
  if (!opfFile) return { reason: 'package document missing' };
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = await opfFile.async('string');
  const manifest = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = attr(m[0], 'id'), href = attr(m[0], 'href');
    if (id && href) manifest.set(id, { path: join(opfDir, decodeURI(href)), type: attr(m[0], 'media-type') || '', props: attr(m[0], 'properties') || '' });
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*>/gi)].map((m) => attr(m[0], 'idref')).filter(Boolean);
  if (!spine.length) return { reason: 'empty spine' };
  const pages = [];
  for (const id of spine) {
    const item = manifest.get(id);
    if (!item) return { reason: `spine item "${id}" is not in the manifest` };
    if (/^image\//.test(item.type)) { pages.push(item.path); continue; }
    if (/\bnav\b/.test(item.props)) continue; // the table of contents is not a page
    const f = zip.file(item.path);
    if (!f) return { reason: `${item.path} is missing from the archive` };
    const html = await f.async('string');
    const imgs = [...html.matchAll(/<(?:img|image)\b[^>]*?\b(?:src|xlink:href|href)\s*=\s*"([^"]+)"/gi)].map((m) => decodeURI(m[1]));
    if (imgs.length !== 1) return { reason: `${item.path} has ${imgs.length} images, not one` };
    pages.push(join(path.posix.dirname(item.path), imgs[0]));
  }
  if (!pages.length) return { reason: 'no page images' };
  const out = new JSZip();
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const ext = (p.match(IMG) || [])[1];
    if (!ext) return { reason: `${p} is not a page image` };
    const f = zip.file(p);
    if (!f) return { reason: `${p} is missing from the archive` };
    out.file(pageName(i + 1, pages.length, ext.toLowerCase().replace('jpeg', 'jpg')), await f.async('nodebuffer'));
  }
  return { buffer: await out.generateAsync(STORE), pages: pages.length };
}
