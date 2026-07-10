# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the Docker image of the same version).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

## [0.6.1] — 2026-07-10

### Added
- New **Download issue metadata** tool (Tools page): fetches ComicVine detail
  — descriptions, credits, dates, covers — for every issue in your collection
  that's missing it. Already-cached issues are skipped, and it stops cleanly on
  a ComicVine rate limit so you can re-run to finish.
- New **Re-index series folders** tool (Tools page): for every ComicVine-matched
  series, authoritatively re-indexes its own folder and attributes the files
  there — without fuzzy matching. Fixes files that were attached to the wrong
  same-named series, and repairs owned/missing counts. (Discovering brand-new
  comics is still "Scan entire library".)
- Profile → API key now shows a **QR code** when you generate a key, so a
  companion app can pair by scanning it instead of typing the key.

### Fixed
- **Scan entire library** no longer re-attributes a file that already belongs
  to a series. Previously a re-scan re-ran the fuzzy matcher on every file and
  could move owned files onto a different same-named series (e.g. an unmatched
  catalog row whose title carries the year), showing them as missing. A scan
  now only matches files that aren't linked to a series yet.

## [0.6.0] — 2026-07-09

### Added
- Personal **API keys** for building your own apps against a BackIssue
  install: generate one key per account from your Profile, send it as
  `X-Api-Key` (or `Authorization: Bearer`), and use the same API the web UI
  runs on — including plugin routes (e.g. the Reader's page endpoints for an
  external comic-reader app). A key acts as its user: everything is clamped
  to the role's permissions, keys are stored hashed and shown once, and
  regenerating or revoking takes effect immediately.
- Plugin hook for outbound notification channels (`registerNotifier`): every
  in-app notification event is handed to registered plugin channels. First
  consumer is the new **Notifications Hub** plugin — Discord (rich embeds with
  cover art), Telegram, Pushover, ntfy, and a generic webhook, each with its
  own category filter and a per-channel test button in Settings.
- Per-user follows: the star is now a personal pull-list bookmark for each user.
  Download automation is controlled by a separate per-series **Auto-download**
  toggle (⋯ menu on the series page). Existing auto-downloads carry over
  unchanged; personal follow lists start empty.
- New **Followed** library filter (your follows); "Not followed" is now
  "Not monitored".

### Fixed
- Issue covers appear the moment their metadata loads — opening an issue fills
  its grid tile immediately, and "Refresh metadata" fills covers in live while
  the background sweep runs (no page reload).
- Followed star, selection checkbox, and progress bar render above cover art on
  library posters (they could hide behind the cover).
- Plugin updates no longer fail on Windows when the running server has the
  plugin's native module loaded (the old install is swapped aside instead of
  deleted in place).

### Removed
- The built-in outbound webhook (Settings → Notifications). The Notifications
  Hub plugin's generic-webhook channel replaces it and reuses the same saved
  settings, so existing webhook configs carry over by installing the plugin.

## [0.5.1] — 2026-07-09

### Added
- Settings slot for plugin library-behavior preferences — first used by the
  Comic Reader plugin's "use the file's first page as the issue cover" option
  (reader ≥ 1.4.1).
- Dev and nightly Docker images identify themselves in About
  (e.g. `0.5.1-dev.a1b2c3d`); releases keep the clean version.

### Changed
- Weekly releases view redesigned: cover thumbnails, a pinned "In your
  collection" section, publisher group headers, story titles, two-column
  layout on wide screens, and a compact download button.
- The `latest` Docker tag now moves **only** on release tags; the nightly build
  stays on `:nightly`, and every push to main builds a rolling `:dev` image.

### Fixed
- Jobs page shows when a run finished ("5m ago · took 19s") instead of
  mislabeling its duration as "ago".
- Scrollbars are deterministically dark and thin (Chrome no longer guesses).

## [0.5.0] — 2026-07-09

### Security
- Restricted-series content is now hidden from roles without the permission on
  every surface: download queue, import history, failed downloads, statistics,
  direct issue lookups, and notifications (notifications also gained per-series
  awareness — flagging a series retroactively hides its old notifications).
- Notifications are filtered by permission per category (imports/failures need
  download rights, request activity needs request management, and so on).

## [0.4.7] — 2026-07-09

### Added
- Permission-aware notification categories (first pass of the 0.5.0 filtering).

## [0.4.6] — 2026-07-09

### Fixed
- Disabling a plugin now survives a restart under Docker (the disabled list was
  read from the wrong path in containers).

## [0.4.5] — 2026-07-09

### Added
- Metadata enrichment re-enabled: content ratings, series status, and per-issue
  extras (price, UPC, story titles) via a supported metadata server — toggle in
  Settings → Metadata.

## [0.4.4] — 2026-07-08

### Fixed
- Mobile: the Settings Save button is reachable again; cramped rows wrap or
  scroll instead of overflowing off-screen.

## [0.4.3] — 2026-07-08

### Fixed
- Docker: plugins that import core modules load correctly when installed under
  `/data/plugins` (relative imports resolved, not just bare dependencies).

## [0.4.2] — 2026-07-08

### Fixed
- Docker: plugin dependencies (e.g. better-sqlite3) resolve when the plugins
  directory lives outside the app tree.

## [0.4.1] — 2026-07-08

### Changed
- Much slimmer Docker image (multi-stage build; roughly a third of the size).

## [0.4.0] — 2026-07-08

### Added
- Scheduled database backups (on by default, weekly).
- RSS watch: new uploads on your indexers are grabbed within one poll of
  appearing.
- AirDC++ announce-bot watching (via the AirDC++ plugin) with automatic grabs
  of missing issues from followed series.
- Settings page redesign: section chips with scroll-spy and filtering.

### Fixed
- Newznab quirks: XML-only servers and servers that reject empty query params.
- Release ship dates seed the metadata cache, feeding the new-releases search.
