// Page-image sources: a chapter is a list of image URLs, and the comic file
// is built here. This is the shape every manga and manhwa site has, and the
// one site plugin that did it before carried the whole thing itself.
import { setTimeout as sleep } from 'node:timers/promises';
import config from '../config.js';
import { buildCbz, buildPdf, pdfEmbeddable } from '../downloader.js';
import { downloadToBuffer } from './http.js';
import { sniffBuffer, describeBody } from './bytes.js';

function extFor(url, buf) {
  const k = sniffBuffer(buf);
  if (k === 'jpg') return '.jpg';
  if (k === 'png') return '.png';
  if (k === 'webp') return '.webp';
  if (k === 'gif') return '.gif';
  const m = String(url).match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i);
  return m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
}

/**
 * Download every page of a chapter → [{ name, buffer }] in reading order,
 * names zero-padded so any reader sorts them. `pages` is an array of URLs or
 * { url, headers }. Page URLs on these sites usually expire within minutes,
 * so this runs right after they were listed, with `concurrency` parallel
 * fetches (paced per host by the HTTP layer) and three attempts per page.
 * A page that comes back as HTML is a hotlink block or a challenge and fails
 * the chapter with a message that says so. onPage({ done, total }) per page.
 */
export async function fetchPages({ pages, referer = '', headers = {}, session = {}, concurrency = 3, rateMs = null, maxBytes = 64 * 1024 * 1024, onPage = () => {}, label = 'the site' } = {}) {
  const list = (pages || []).map((p) => (typeof p === 'string' ? { url: p } : p)).filter((p) => p?.url);
  if (!list.length) throw new Error('the chapter has no pages');
  const out = new Array(list.length);
  let next = 0;
  let done = 0;
  const one = async (i) => {
    const p = list[i];
    let lastErr = null;
    for (let att = 1; att <= 3; att++) {
      try {
        const { buffer } = await downloadToBuffer(p.url, { referer: p.referer ?? referer, headers: { ...headers, ...(p.headers || {}) }, session, maxBytes, rateMs: att === 1 ? rateMs : null });
        if (!buffer.length) throw new Error('empty body');
        const kind = sniffBuffer(buffer);
        if (!['jpg', 'png', 'webp', 'gif'].includes(kind)) {
          const d = describeBody(buffer);
          throw Object.assign(new Error(d.html
            ? `${label} sent a web page instead of page ${i + 1}${d.title ? ` ("${d.title}")` : ''} — hotlink protection or a challenge`
            : `page ${i + 1} is not an image`), { noRetry: d.html });
        }
        out[i] = { name: String(i + 1).padStart(3, '0') + extFor(p.url, buffer), buffer };
        done++;
        onPage({ done, total: list.length });
        return;
      } catch (e) {
        lastErr = e;
        if (e?.noRetry || att === 3) break;
        await sleep(300 * att);
      }
    }
    // A 403/404 on some pages but not others, with no referer sent, is the
    // classic hotlink protection on an image host — say so, because the page
    // URLs themselves are perfectly valid and the cause is not obvious.
    const hotlink = !(p.referer ?? referer) && [403, 404].includes(lastErr?.status)
      ? ' — the image host refused it; these hosts usually require a referer, so return one from resolve()' : '';
    throw Object.assign(new Error(`page ${i + 1}: ${lastErr?.message || lastErr}${hotlink}`), lastErr?.noRetry ? { noRetry: true } : {});
  };
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      await one(i);
      if (config.imageDelayMs > 0) await sleep(config.imageDelayMs);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Pages → the file the import tail wants: { buffer, format }. Honours the
 * instance's preferred format (PDF when every page can be embedded, else CBZ).
 */
export async function pagesToArchive(pages, { title = '', publisher = '', seriesTitle = '' } = {}) {
  if (config.format === 'pdf' && pdfEmbeddable(pages)) {
    return { buffer: await buildPdf(pages, { title, publisher, seriesTitle }), format: 'pdf' };
  }
  return { buffer: await buildCbz(pages), format: 'cbz' };
}
