// Books and audiobooks on the download sources. A comic is wanted by series +
// number and matched by the strict release parser in usenet.js; a book has no
// number and its releases are named every which way ("Author - Title (2010)
// [EPUB]", "Title by Author", "Author.Title.2010.M4B-GRP"). This module carries
// the book-shaped half of the search: the queries to send, the indexer
// categories, and a word-overlap matcher that accepts a release when it names
// the whole title (and the author, where the title alone is ambiguous) and
// carries the right kind of file.
//
// A "book context" is the ctx the queue hands a source's find(), with
// series.type set to 'ebook' or 'audiobook' and a `book` block:
//   { type, title, author, year }
// Every built-in source (and defineSource's default find) branches on
// isBookContext() so a single sources list serves comics and books alike.

export const BOOK_TYPES = ['ebook', 'audiobook'];

// Newznab/Torznab categories: 7020 = Books/Ebook, 3030 = Audio/Audiobook.
const CATEGORY = { ebook: '7020', audiobook: '3030' };
export function bookCategory(type) { return CATEGORY[String(type || '').toLowerCase()] || ''; }

export function isBookContext(ctx) {
  const t = String(ctx?.book?.type || ctx?.series?.type || '').toLowerCase();
  return BOOK_TYPES.includes(t) && !!(ctx?.book?.title || ctx?.seriesTitle);
}

/** An ISBN as bare digits (13 preferred, 10 accepted), or null. */
export function isbnOf(v) {
  const d = String(v || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return d.length === 13 || d.length === 10 ? d : null;
}

/** The scoring target: what was asked for, normalised once. */
export function bookTarget(ctx) {
  const b = ctx?.book || {};
  return {
    type: String(b.type || ctx?.series?.type || 'ebook').toLowerCase(),
    title: String(b.title || ctx?.seriesTitle || '').trim(),
    author: String(b.author || '').trim() || null,
    year: (String(b.year || ctx?.seriesYear || '').match(/\d{4}/) || [])[0] || null,
    isbn: isbnOf(b.isbn),
  };
}

/** The queries to send for one book, most specific first. The
 *  author-and-title form finds the well-named releases; the bare title
 *  catches the ones that dropped the author. With `isbn: true` the book's
 *  ISBN goes first — a catalog site answers it with exactly that book,
 *  where an indexer of release names would answer nothing. */
export function bookQueries(ctx, { isbn = false } = {}) {
  const t = bookTarget(ctx);
  const out = [];
  if (isbn && t.isbn) out.push(t.isbn);
  if (t.author) out.push(`${t.author} ${t.title}`);
  out.push(t.title);
  return [...new Set(out.map((q) => q.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

// Words that carry no identity — a release that drops them still names the book.
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'by', 'with', 'from']);
export function bookWords(s) {
  return String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter(Boolean);
}
const significant = (words) => words.filter((w) => !STOP.has(w));

const EBOOK_HINT = /\b(epub|mobi|azw3?|kfx|pdf|ebook|e-book|retail)\b/i;
// A release that is a changed form of the book — cut, simplified, retold,
// summarised — or a companion to it rather than the book itself. Ranked
// last, not rejected: it may be the only copy.
const ALTERED = /\b(classroom edition|school edition|young readers?['’]? edition|abridged|large print|summary|study guide|workbook|companion|excerpt|sample|preview|teaser|graphic novel|adaptation|illustrated edition|colou?ring book)\b/i;
const AUDIO_HINT = /\b(m4b|mp3|m4a|flac|audiobook|audio\s*book|unabridged|abridged|narrat(ed|or)|\d{1,3}\s*kbps)\b/i;

/**
 * Score a release name against the wanted book, or null when it is not this
 * book. Every significant word of the title must appear in the release; the
 * author (last name at least) must appear when the title is a single word
 * ("Dune", "It", "The Road") and earns a bonus otherwise; a
 * release that announces the other kind of file (an m4b for an ebook wanted,
 * an epub for an audiobook) is rejected. Year and format hints only rank.
 */
export function scoreBookRelease(title, target) {
  const rel = bookWords(title);
  if (!rel.length) return null;
  const relSet = new Set(rel);
  const want = significant(bookWords(target.title));
  if (!want.length) return null;
  if (!want.every((w) => relSet.has(w))) return null;
  const relText = rel.join(' ');
  // Every word of the title in order — a release "Kings of the Way" is not
  // "The Way of Kings". Checked on the significant words, allowing the stop
  // words in between to go missing.
  const ordered = new RegExp('\\b' + want.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\b(?:\\s+\\w+){0,2}?\\s+\\b') + '\\b');
  if (!ordered.test(relText)) return null;

  const isAudio = AUDIO_HINT.test(String(title));
  const isEbook = EBOOK_HINT.test(String(title));
  if (target.type === 'audiobook' && isEbook && !isAudio) return null;
  if (target.type === 'ebook' && isAudio && !isEbook) return null;

  let score = 100;
  const authorWords = significant(bookWords(target.author));
  if (authorWords.length) {
    const last = authorWords[authorWords.length - 1];
    const full = authorWords.every((w) => relSet.has(w));
    const surname = relSet.has(last);
    if (full) score += 20;
    else if (surname) score += 10;
    else if (want.length <= 1) return null; // a one-word title is anyone's without its author
    else score -= 15;
  }
  if (target.year) {
    const years = String(title).match(/\b(19|20)\d{2}\b/g) || [];
    if (years.length) score += years.includes(target.year) ? 10 : -5;
  }
  if (target.type === 'ebook') {
    if (/\bepub\b/i.test(title)) score += 10;
    else if (isEbook) score += 5;
  } else {
    if (/\bm4b\b/i.test(title)) score += 10;
    else if (isAudio) score += 5;
  }
  // A release naming far more than the book (a whole series pack, a
  // collection) ranks below the single book — it may still be the only copy.
  // A bracketed subtitle or series note ("(The Stormlight Archive #1)") is
  // how books are named, not extra content, so it does not count.
  const bare = bookWords(String(title).replace(/\([^)]*\)|\[[^\]]*\]/g, ' '));
  if (bare.length > want.length + authorWords.length + 8) score -= 10;
  // Between two matches, the one that names just the book beats the one
  // that names the book and something more ("Classroom Edition", "A Novel"):
  // a point per extra word, a couple allowed for the format and the like.
  const extra = bare.filter((w) => !STOP.has(w) && !want.includes(w) && !authorWords.includes(w)).length;
  if (extra > 2) score -= Math.min(extra - 2, 8);
  if (ALTERED.test(String(title).replace(/\bunabridged\b/gi, ''))) score -= 30;
  return score;
}

// An ebook can legitimately be a few hundred kilobytes; an audiobook cannot.
export const MIN_EBOOK_BYTES = 50 * 1024;
export const MIN_AUDIOBOOK_BYTES = 1024 * 1024;
export function bookTooSmall(type, size) {
  const n = Number(size);
  if (!(n > 0)) return false; // unknown size is not evidence
  return n < (type === 'audiobook' ? MIN_AUDIOBOOK_BYTES : MIN_EBOOK_BYTES);
}

/**
 * The shared automatic search for an indexer-backed source. `search(query,
 * cat)` returns that source's result rows; `urlOf(row)` names the field that
 * makes a row unique (nzbUrl / downloadUrl). Searches the book's category
 * first and falls back to an uncategorised search when that finds nothing
 * (many indexers file books loosely). Returns the best-scoring row or null.
 */
export async function findBookRelease(ctx, search, { urlOf, isBlocked = () => false } = {}) {
  const target = bookTarget(ctx);
  const byUrl = new Map();
  const gather = async (cat) => {
    for (const q of bookQueries(ctx)) {
      const rows = await search(q, cat);
      for (const r of rows || []) {
        const key = urlOf(r);
        if (key && !byUrl.has(key)) byUrl.set(key, r);
      }
    }
  };
  await gather(bookCategory(target.type));
  if (!byUrl.size) await gather('');
  const scored = [...byUrl.values()]
    .filter((r) => !bookTooSmall(target.type, r.size) && !isBlocked(r))
    .map((r) => ({ r, score: scoreBookRelease(r.title, target) }))
    .filter((x) => x.score != null)
    .sort((a, b) => (b.score - a.score) || ((b.r.seeders || 0) - (a.r.seeders || 0)) || ((b.r.size || 0) - (a.r.size || 0)));
  return scored[0]?.r || null;
}
