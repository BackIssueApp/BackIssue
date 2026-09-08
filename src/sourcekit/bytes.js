// What came back from a download, and what to do with it. Shared by every
// site source so the queue's errors say the same true thing everywhere: a
// tiny HTML body is a challenge page or a rate limit, not a comic; a RAR
// becomes a CBZ so it can be tagged; a PDF stays a PDF.
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { cbrBufferToCbz } from '../archive.js';
import { suspiciouslySmall } from '../sources/usenet.js';

/** Keep the last body that was not a comic, so a failure can be inspected
 *  rather than guessed at. Best-effort: never breaks the download path. */
function keepEvidence(id, buffer, html) {
  if (!id) return '';
  try {
    const dir = path.join(config.dataDir, 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}-last-response.${html ? 'html' : 'bin'}`);
    fs.writeFileSync(file, buffer);
    return file;
  } catch { return ''; }
}

/** 'cbz' | 'cbr' | 'pdf' | 'jpg' | 'png' | 'webp' | 'gif' | null from magic bytes. */
export function sniffBuffer(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7)) return 'cbz';
  if (buf.slice(0, 4).toString('latin1') === 'Rar!') return 'cbr';
  if (buf.slice(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return 'png';
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'gif';
  return null;
}

export function isImageBuffer(buf) { return ['jpg', 'png', 'webp', 'gif'].includes(sniffBuffer(buf)); }

/**
 * Explain a body that is not the file we asked for: { html, title, cloudHost }.
 * `title` is the page's own <title> (Cloudflare's "Just a moment…", a host's
 * "Rate limited"), `cloudHost` names a cloud locker the link redirected to,
 * which no HTTP client can download from.
 */
export function describeBody(buf) {
  const head = buf.toString('latin1', 0, 512);
  const html = /<(!doctype|html)/i.test(head);
  const title = (head.match(/<title[^>]*>([^<]{0,120})/i) || [])[1]?.trim() || null;
  const cloudHost = /terabox|1024tera/i.test(head) ? 'TeraBox'
    : /mediafire/i.test(head) ? 'Mediafire'
      : /mega\.nz/i.test(head) ? 'MEGA' : null;
  return { html, title, cloudHost };
}

/**
 * Turn a downloaded archive into what the import tail wants: { buffer,
 * format }. CBR is repacked as CBZ (an oversized one that cannot be repacked
 * in memory is filed as .cbr — the app reads CBR natively); PDF passes
 * through. A body that is not an archive throws with a self-explanatory
 * message, and `noRetry` when a retry could not change the answer.
 */
export async function normalizeArchive(buffer, { label = 'the site', id = '', url = '' } = {}) {
  const fmt = sniffBuffer(buffer);
  if (fmt === 'cbz') return { buffer, format: 'cbz' };
  if (fmt === 'pdf') return { buffer, format: 'pdf' };
  if (fmt === 'cbr') {
    try { return { buffer: await cbrBufferToCbz(buffer), format: 'cbz' }; }
    catch { return { buffer, format: 'cbr' }; }
  }
  const d = describeBody(buffer);
  const saved = keepEvidence(id, buffer, d.html);
  if (saved) {
    console.warn(`${id}: ${label} returned ${buffer.length} bytes of ${d.html ? 'HTML' : 'unknown data'}${url ? ` from ${url}` : ''}${d.title ? ` — page title: "${d.title}"` : ''} (saved to ${saved})`);
  }
  if (!d.html) {
    throw Object.assign(new Error(suspiciouslySmall(buffer.length)
      ? 'downloaded file is suspiciously small and not a comic archive'
      : 'downloaded file is not a comic archive'), { noRetry: !suspiciouslySmall(buffer.length) });
  }
  if (d.cloudHost) {
    throw Object.assign(new Error(`this link redirects to ${d.cloudHost}, which BackIssue cannot download from directly — try another release`), { noRetry: true });
  }
  throw new Error(`${label} sent a web page instead of the file${d.title ? ` ("${d.title}")` : ''} — a Cloudflare challenge or rate limit on the download host`);
}
