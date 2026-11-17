// Lossless PDF / EPUB → CBZ (#22): one image per page is copied out as it is;
// anything else is refused with a reason and the original is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { pdfToCbz, epubToCbz, isEpub, encodePng } from '../src/cbzconvert.js';

// A JPEG as far as pdf-lib's embedder reads it (SOI + SOF0 header): what
// matters here is that the exact bytes come back out.
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
const RGB = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]); // 2x2
const PNG = encodePng({ width: 2, height: 2, channels: 3, pixels: RGB });

async function pdfOf(build) {
  const doc = await PDFDocument.create();
  await build(doc);
  return Buffer.from(await doc.save());
}
const names = async (buf) => Object.keys((await JSZip.loadAsync(buf)).files).sort();
const entry = async (buf, name) => (await JSZip.loadAsync(buf)).file(name).async('nodebuffer');

test('a one-image-per-page PDF: JPEGs are copied byte for byte, Flate images become PNGs', async () => {
  const pdf = await pdfOf(async (doc) => {
    const j = await doc.embedJpg(Uint8Array.from(JPG));
    doc.addPage([300, 200]).drawImage(j, { x: 0, y: 0, width: 300, height: 200 });
    const p = await doc.embedPng(Uint8Array.from(PNG));
    doc.addPage([2, 2]).drawImage(p, { x: 0, y: 0, width: 2, height: 2 });
  });
  const r = await pdfToCbz(pdf);
  assert.ok(r.buffer, r.reason);
  assert.equal(r.pages, 2);
  assert.deepEqual(await names(r.buffer), ['001.jpg', '002.png']);
  assert.ok((await entry(r.buffer, '001.jpg')).equals(JPG), 'the JPEG is the same bytes');
  // The PNG decodes back to the pixels the PDF held.
  const png = await entry(r.buffer, '002.png');
  assert.equal(png.readUInt32BE(16), 2); assert.equal(png.readUInt32BE(20), 2);
  const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8);
  const raw = zlib.inflateSync(idat);
  assert.deepEqual([...raw], [0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
});

test('a PDF with text, no image, or two images on a page is refused with the page named', async () => {
  const text = await pdfOf(async (doc) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const j = await doc.embedJpg(Uint8Array.from(JPG));
    const page = doc.addPage([300, 200]);
    page.drawImage(j, { x: 0, y: 0, width: 300, height: 200 });
    page.drawText('Chapter 1', { x: 10, y: 10, font, size: 12 });
  });
  assert.match((await pdfToCbz(text)).reason, /page 1 has text/);
  const blank = await pdfOf(async (doc) => { doc.addPage([100, 100]); });
  assert.match((await pdfToCbz(blank)).reason, /page 1 has 0 images/);
  const two = await pdfOf(async (doc) => {
    const j = await doc.embedJpg(Uint8Array.from(JPG));
    const p = await doc.embedPng(Uint8Array.from(PNG));
    const page = doc.addPage([300, 200]);
    page.drawImage(j, { x: 0, y: 0, width: 150, height: 200 });
    page.drawImage(p, { x: 150, y: 0, width: 150, height: 200 });
  });
  assert.match((await pdfToCbz(two)).reason, /page 1 has 2 images/);
  assert.match((await pdfToCbz(Buffer.from('%PDF-1.4 garbage'))).reason, /unreadable PDF/);
});

async function epubOf({ spine = ['p1', 'p2'], extra = {} } = {}) {
  const z = new JSZip();
  z.file('mimetype', 'application/epub+zip');
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  z.file('OEBPS/content.opf', `<package><manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="p1" href="text/p1.xhtml" media-type="application/xhtml+xml"/>
    <item id="p2" href="text/p2.xhtml" media-type="application/xhtml+xml"/>
    <item id="i1" href="images/a%20b.jpg" media-type="image/jpeg"/>
    <item id="i2" href="images/c.png" media-type="image/png"/>
  </manifest><spine>${['nav', ...spine].map((s) => `<itemref idref="${s}"/>`).join('')}</spine></package>`);
  z.file('OEBPS/nav.xhtml', '<html><body><nav><ol><li><a href="text/p1.xhtml">1</a></li></ol></nav></body></html>');
  z.file('OEBPS/text/p1.xhtml', '<html><body><img src="../images/a%20b.jpg" alt="page"/></body></html>');
  z.file('OEBPS/text/p2.xhtml', '<html><body><svg><image xlink:href="../images/c.png"/></svg></body></html>');
  z.file('OEBPS/images/a b.jpg', JPG);
  z.file('OEBPS/images/c.png', PNG);
  for (const [n, c] of Object.entries(extra)) z.file(n, c);
  return z.generateAsync({ type: 'nodebuffer' });
}

test('a fixed-layout EPUB: page images in spine order, the nav skipped, names resolved against each page', async () => {
  const epub = await epubOf();
  assert.equal(await isEpub(epub), true);
  const r = await epubToCbz(epub);
  assert.ok(r.buffer, r.reason);
  assert.deepEqual(await names(r.buffer), ['001.jpg', '002.png']);
  assert.ok((await entry(r.buffer, '001.jpg')).equals(JPG));
  assert.ok((await entry(r.buffer, '002.png')).equals(PNG));
  // Reversed spine, reversed pages.
  const back = await epubToCbz(await epubOf({ spine: ['p2', 'p1'] }));
  assert.ok((await entry(back.buffer, '001.png')).equals(PNG));
});

test('an EPUB with a text page is refused; a plain CBZ is not an EPUB', async () => {
  const textPage = await epubOf({ extra: { 'OEBPS/text/p2.xhtml': '<html><body><p>Copyright 2022</p></body></html>' } });
  assert.match((await epubToCbz(textPage)).reason, /p2\.xhtml has 0 images/);
  const cbz = new JSZip(); cbz.file('001.jpg', JPG);
  assert.equal(await isEpub(await cbz.generateAsync({ type: 'nodebuffer' })), false);
});
