// qBittorrent identifies a torrent by its infohash but does NOT return one from
// its add endpoint. We derive the hash ourselves so we can track the grab: from a
// magnet's btih, or by hashing the info dict of a .torrent file.
import crypto from 'node:crypto';

// btih out of a magnet URI → lowercase hex. Handles hex (40) and base32 (32).
export function magnetInfohash(magnet) {
  const m = /xt=urn:btih:([a-z2-7A-F0-9]+)/i.exec(String(magnet || ''));
  if (!m) return null;
  const h = m[1];
  if (h.length === 40) return h.toLowerCase();
  if (h.length === 32) return base32ToHex(h);
  return h.toLowerCase(); // v2 (already hex) — pass through
}

// v1 infohash of a .torrent: sha1 of the RAW bytes of its bencoded `info` value
// (slicing the original bytes avoids any re-encode canonicalization mismatch).
export function torrentInfohash(buf) {
  const info = sliceInfoDict(buf);
  return info ? crypto.createHash('sha1').update(info).digest('hex') : null;
}

// ---- minimal bencode ----
function readString(buf, i) {
  const colon = buf.indexOf(0x3a, i); // ':'
  if (colon < 0) return null;
  const len = Number(buf.toString('latin1', i, colon));
  if (!Number.isInteger(len) || len < 0) return null;
  const start = colon + 1, end = start + len;
  if (end > buf.length) return null;
  return { str: buf.toString('latin1', start, end), end };
}

function skipValue(buf, i) {
  const c = buf[i];
  if (c === 0x69) { const e = buf.indexOf(0x65, i); return e < 0 ? -1 : e + 1; } // 'i'nt
  if (c >= 0x30 && c <= 0x39) { const s = readString(buf, i); return s ? s.end : -1; } // string
  if (c === 0x6c || c === 0x64) { // 'l'ist / 'd'ict — children until 'e'
    i++;
    while (buf[i] !== 0x65) { if (i >= buf.length) return -1; i = skipValue(buf, i); if (i < 0) return -1; }
    return i + 1;
  }
  return -1;
}

// Return the raw bytes of the top-level `info` dict value, or null.
function sliceInfoDict(buf) {
  if (!buf || buf[0] !== 0x64) return null; // top level must be a dict
  let i = 1;
  while (i < buf.length && buf[i] !== 0x65) {
    const key = readString(buf, i); if (!key) return null; i = key.end;
    const valStart = i;
    const valEnd = skipValue(buf, i); if (valEnd < 0) return null; i = valEnd;
    if (key.str === 'info') return buf.subarray(valStart, valEnd);
  }
  return null;
}

function base32ToHex(b32) {
  const alph = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of b32.toUpperCase()) {
    const v = alph.indexOf(ch);
    if (v < 0) return b32.toLowerCase();
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 8 <= bits.length; i += 8) hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0');
  return hex.toLowerCase();
}
