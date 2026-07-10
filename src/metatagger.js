import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { getCvIssue, getCvSeries, setCvIssueDetail, getLibraryFile } from './db.js';
import { logWarn } from './logstore.js';
import { convertCbrToCbz } from './archive.js';
import { normalizeNumber } from './matcher.js';
import { cvKey } from './cv.js';
import config from './config.js';

// Native metadata tagger: builds a standard ComicInfo.xml from our cached
// ComicVine data and writes it into the CBZ. Replaces ComicTagger — matching is
// already solved (library files carry cv_issue_id), so tagging is just data.

export function taggingEnabled() {
  return config.tagOnDownload === 'on' && !!cvKey(config.comicvineKeys);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// ComicVine descriptions are HTML; ComicInfo Summary is plain text.
export function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ComicVine credit roles → ComicInfo elements. CV roles are comma-separated
// ("penciler, cover"), one credit may land in several elements.
const ROLE_MAP = [
  [/writer|script|plot|story/i, 'Writer'],
  [/pencil|artist|painter|illustrator/i, 'Penciller'],
  [/inker/i, 'Inker'],
  [/colorist|colourist|colors|colours/i, 'Colorist'],
  [/letterer/i, 'Letterer'],
  [/cover/i, 'CoverArtist'],
  [/editor/i, 'Editor'],
];

export function mapCredits(credits) {
  const out = {};
  for (const c of credits || []) {
    if (!c || !c.name) continue;
    for (const role of String(c.role || '').split(',')) {
      for (const [re, el] of ROLE_MAP) {
        if (re.test(role)) {
          (out[el] ||= new Set()).add(c.name);
          break;
        }
      }
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].join(', ')]));
}

// Build ComicInfo.xml from a cv_series row + cv_issues row.
export function buildComicInfoXml({ series, issue }) {
  const tags = [];
  const add = (el, v) => { if (v != null && String(v).trim() !== '') tags.push(`  <${el}>${esc(String(v).trim())}</${el}>`); };

  add('Title', issue.name);
  add('Series', series.name);
  add('Number', issue.issue_number);
  add('Count', series.count_of_issues);
  add('Volume', series.start_year);
  add('Summary', stripHtml(issue.description));
  const date = issue.cover_date || issue.store_date;
  const m = date ? String(date).match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  if (m) { add('Year', Number(m[1])); add('Month', Number(m[2])); add('Day', Number(m[3])); }
  else if (series.start_year) add('Year', series.start_year);

  let credits = issue.credits;
  if (typeof credits === 'string') { try { credits = JSON.parse(credits); } catch { credits = []; } }
  for (const [el, names] of Object.entries(mapCredits(credits))) add(el, names);

  add('Publisher', series.publisher);
  add('Web', issue.site_detail_url || series.site_detail_url);
  add('Notes', `Tagged by BackIssue from ComicVine issue ${issue.comicvine_id ?? issue.id}.`);

  return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n${tags.join('\n')}\n</ComicInfo>`;
}

// Fetch + cache an issue's full detail (dates, summary, credits) once, ever —
// plus one extra fetch for rows cached before enrichment was enabled, so
// their Metron extras (price, barcode, stories, reprints) fill in lazily.
export async function ensureCvIssueDetail(db, client, cvIssueId) {
  const cached = getCvIssue(db, cvIssueId);
  const wantsEnrich = !!config.cvEnrich && cached && cached.has_detail && !cached.metron_checked;
  if (cached && cached.has_detail && !wantsEnrich) return cached;
  const d = await client.issue(cvIssueId);
  setCvIssueDetail(db, cvIssueId, {
    cover_date: d.cover_date, store_date: d.store_date,
    description: d.description, credits: d.credits, site_detail_url: d.site_detail_url,
    image_url: d.image_url,
    character_credits: d.character_credits, team_credits: d.team_credits,
    location_credits: d.location_credits, story_arc_credits: d.story_arc_credits,
    associated_images: d.associated_images,
    ...(d.metron !== undefined ? { metron: d.metron } : {}),
  });
  return getCvIssue(db, cvIssueId);
}

// Download ComicVine detail (description, credits, dates, cover) for every
// cached issue that doesn't have it yet — the "Download issue metadata" tool.
// Sequential, so the CV client's own pacing/key rotation governs the rate;
// stops cleanly on a rate limit so a re-run finishes the rest. cv_issues only
// holds issues for series in the collection, so this is naturally scoped, and
// has_detail flips to 1 on each fetch so the set converges (no re-fetching).
export async function fetchAllIssueMetadata(db, client, onProgress = () => {}) {
  const ids = db.prepare('SELECT comicvine_id FROM cv_issues WHERE has_detail = 0 ORDER BY comicvine_id')
    .all().map((r) => r.comicvine_id);
  let fetched = 0;
  let failed = 0;
  let rateLimited = false;
  onProgress({ done: 0, total: ids.length });
  for (const id of ids) {
    try {
      await ensureCvIssueDetail(db, client, id);
      fetched++;
    } catch (e) {
      if (e?.rateLimited) { rateLimited = true; break; } // all keys throttled — stop, resume on re-run
      failed++;
    }
    onProgress({ done: fetched + failed, total: ids.length, message: `${fetched} fetched` });
  }
  const remaining = ids.length - fetched - failed;
  return rateLimited ? { fetched, failed, remaining } : { fetched, failed };
}

// Replace/insert ComicInfo.xml inside a CBZ buffer (used at download time).
export async function tagCbzBuffer(buffer, xml) {
  const zip = await JSZip.loadAsync(buffer);
  for (const name of Object.keys(zip.files)) {
    if (/(^|\/)comicinfo\.xml$/i.test(name)) zip.remove(name);
  }
  zip.file('ComicInfo.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Rewrite a CBZ on disk with the given ComicInfo.xml (atomic temp → rename).
export async function writeComicInfo(cbzPath, xml) {
  if (!/\.cbz$/i.test(cbzPath)) throw new Error('can only tag .cbz files');
  const buffer = await fs.readFile(cbzPath);
  const out = await tagCbzBuffer(buffer, xml);
  const tmp = path.join(path.dirname(cbzPath), `.tag-${process.pid}-${path.basename(cbzPath)}`);
  await fs.writeFile(tmp, out);
  await fs.rename(tmp, cbzPath);
}

// The XML for an issue about to be downloaded: map its number to the
// series' CV issue, ensure detail, build. Returns null when unmatched (the
// download proceeds untagged).
export async function xmlForIssue(db, client, series, issueNumber) {
  if (!series || !series.cv_id) return null;
  const want = normalizeNumber(issueNumber);
  if (!want) return null;
  const cvIssue = db.prepare('SELECT * FROM cv_issues WHERE cv_series_id=?').all(series.cv_id)
    .find((i) => normalizeNumber(i.issue_number) === want);
  if (!cvIssue) return null;
  let issue = cvIssue;
  try { issue = await ensureCvIssueDetail(db, client, cvIssue.comicvine_id); }
  catch { /* tag with the cached stub (series/number/name) rather than fail */ }
  const cvSeries = getCvSeries(db, series.cv_id);
  if (!cvSeries) return null;
  return buildComicInfoXml({ series: cvSeries, issue });
}

// Tag one existing library file from its CV linkage. Records a tag_log entry.
export async function tagFileFromCv(db, client, filePath) {
  let row = getLibraryFile(db, filePath);
  // Surface tag problems on the Logs page (category 'tag'); successes are
  // summarized by the caller, so we don't log every tagged file.
  const log = (outcome, reason) => {
    logWarn(`Tag ${outcome}: ${row?.name || path.basename(filePath)} — ${reason}`, 'tag');
    return { outcome, reason };
  };
  if (!row) return log('error', 'file not in library index');
  if (!row.valid) return log('skipped', 'corrupt archive');
  // Tagging writes ComicInfo.xml into a zip, so a .cbr must be converted to .cbz
  // first. Do it here (extracts all entries solid-safe, removes the .cbr), then
  // re-point the index row and tag the new .cbz.
  if (/\.cbr$/i.test(filePath)) {
    try {
      const { cbzPath } = await convertCbrToCbz(filePath);
      db.prepare('UPDATE library_files SET path=?, name=? WHERE path=?').run(cbzPath, path.basename(cbzPath), filePath);
      filePath = cbzPath;
      row = getLibraryFile(db, cbzPath);
    } catch (e) { return log('error', `CBR→CBZ conversion failed: ${e?.message || e}`); }
  } else if (!/\.cbz$/i.test(filePath)) {
    return log('skipped', 'not a .cbz or .cbr (convert first)');
  }
  if (!row.cv_issue_id) return log('no-match', 'file not linked to a ComicVine issue');
  const cvIssue = getCvIssue(db, row.cv_issue_id);
  const cvSeries = cvIssue ? getCvSeries(db, cvIssue.cv_series_id) : null;
  if (!cvIssue || !cvSeries) return log('error', 'ComicVine cache missing for this issue');

  let issue = cvIssue;
  try { issue = await ensureCvIssueDetail(db, client, cvIssue.comicvine_id); }
  catch (e) {
    // A rate limit means all keys are spent — don't write a half-complete tag from
    // the stub (it would mark the file tagged and never get revisited). Propagate
    // so the batch halts and this file is retried on a later run.
    if (e?.rateLimited) throw e;
    /* any other detail error: proceed with the cached stub */
  }
  const xml = buildComicInfoXml({ series: cvSeries, issue });
  try {
    await writeComicInfo(filePath, xml);
  } catch (e) {
    return log('error', String(e?.message || e));
  }
  // Keep the index consistent with the rewritten file (new size/mtime, tagged).
  const st = await fs.stat(filePath).catch(() => null);
  db.prepare('UPDATE library_files SET has_metadata=1, ci_series=?, ci_number=?, ci_volume=?, ci_title=?, size=COALESCE(?, size), mtime=COALESCE(?, mtime) WHERE path=?')
    .run(cvSeries.name, issue.issue_number, cvSeries.start_year, issue.name, st ? st.size : null, st ? Math.floor(st.mtimeMs) : null, filePath);
  return { outcome: 'tagged' };
}
