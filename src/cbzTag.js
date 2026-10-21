// Write ComicInfo.xml into a .cbz ON DISK, without loading the archive.
//
// A zip's table of contents (the central directory) sits at the very end of
// the file, after every entry's data. So tagging only has to touch the tail:
// the new ComicInfo.xml entry is written where the old directory began, then
// a fresh directory (the old records, minus any previous ComicInfo.xml, plus
// the new one) and the end record. The page entries are never read or
// rewritten, so memory and I/O stay a few kilobytes whatever the file's size
// (rebuilding a multi-GB collected edition in memory ran the host out of it).
//
// A previous ComicInfo.xml that is the LAST entry (as our own tagging leaves
// it) is overwritten in place; one elsewhere just loses its directory record,
// so readers no longer see it. Zip64 archives (over 4GB or 65535 entries) and
// anything unexpected throw NOT_SIMPLE_ZIP so the caller can fall back.
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LOCAL_SIG = 0x04034b50;
const EOCD_LOCATOR64_SIG = 0x07064b50;
const COMICINFO_RE = /(^|\/)comicinfo\.xml$/i;

let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function notSimple(why) {
  const e = new Error(`can't tag in place: ${why}`);
  e.code = 'NOT_SIMPLE_ZIP';
  return e;
}

// MS-DOS time/date for the new entry's timestamp.
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// Locate and read the end record + central directory from the file's tail.
async function readDirectory(fh, size) {
  const tailLen = Math.min(size, 65535 + 22);
  const tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG && i + 22 + tail.readUInt16LE(i + 20) === tailLen) { eocd = i; break; }
  }
  if (eocd < 0) throw notSimple('no end-of-directory record');
  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === EOCD_LOCATOR64_SIG) throw notSimple('zip64 archive');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) throw notSimple('multi-disk archive');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw notSimple('zip64 archive');
  const eocdPos = size - tailLen + eocd;
  if (cdOffset + cdSize !== eocdPos) throw notSimple('unexpected data around the directory');
  const comment = Buffer.from(tail.subarray(eocd + 22));
  const cd = Buffer.alloc(cdSize);
  await fh.read(cd, 0, cdSize, cdOffset);
  const records = [];
  for (let p = 0; p < cdSize;) {
    if (p + 46 > cdSize || cd.readUInt32LE(p) !== CD_SIG) throw notSimple('damaged directory');
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    const len = 46 + nameLen + extraLen + commentLen;
    const csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), offset = cd.readUInt32LE(p + 42);
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw notSimple('zip64 entry');
    records.push({ raw: cd.subarray(p, p + len), name: cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'), offset });
    p += len;
  }
  if (records.length !== count) throw notSimple('directory count mismatch');
  return { records, cdOffset, comment };
}

export async function writeComicInfoInPlace(cbzPath, xml) {
  const fh = await fs.open(cbzPath, 'r+');
  try {
    const { size } = await fh.stat();
    const { records, cdOffset, comment } = await readDirectory(fh, size);
    const keep = records.filter((r) => !COMICINFO_RE.test(r.name));
    const old = records.filter((r) => COMICINFO_RE.test(r.name));
    // Reuse the old ComicInfo.xml's space when nothing comes after it.
    const lastKept = keep.reduce((m, r) => Math.max(m, r.offset), -1);
    let at = cdOffset;
    for (const r of old) if (r.offset > lastKept && r.offset < at) at = r.offset;
    // Make sure that offset really is a local header before writing over it.
    if (at !== cdOffset) {
      const sig = Buffer.alloc(4);
      await fh.read(sig, 0, 4, at);
      if (sig.readUInt32LE(0) !== LOCAL_SIG) at = cdOffset;
    }

    const data = Buffer.from(xml, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const name = Buffer.from('ComicInfo.xml');
    const { time, date } = dosDateTime();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CD_SIG, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal attrs, external attrs: all zero
    central.writeUInt32LE(at, 42);

    const entryLen = 30 + name.length + packed.length;
    const newCdOffset = at + entryLen;
    if (newCdOffset > 0xfffffffe) throw notSimple('archive would need zip64');
    const cdParts = [...keep.map((r) => r.raw), central, name];
    const cdSize = cdParts.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(EOCD_SIG, 0);
    end.writeUInt16LE(keep.length + 1, 8);
    end.writeUInt16LE(keep.length + 1, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(newCdOffset, 16);
    end.writeUInt16LE(comment.length, 20);

    // One positional write of the whole new tail (a few KB), then trim
    // whatever of the old tail lies beyond it.
    const tailBuf = Buffer.concat([local, name, packed, ...cdParts, end, comment]);
    await fh.write(tailBuf, 0, tailBuf.length, at);
    await fh.truncate(at + tailBuf.length);
    await fh.sync();
  } finally {
    await fh.close();
  }
}
