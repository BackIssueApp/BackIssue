# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the Docker image of the same version).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

### Added
- **Mylar-style folder layouts import correctly.** Libraries organized as
  `Publisher/Series/Volume (year)` (e.g. `Marvel/X-Men/v2004`) previously
  matched against the volume folder's name ("V2004") instead of the series.
  A folder that is only a volume marker (`v2004`, `Vol. 3 (1999)`, `Volume 2`)
  now takes its series name from the folder above it — searched and matched as
  "X-Men (2004)" — while each volume folder still maps to its own ComicVine
  volume. Applies to both the import tab and library scans.

## [0.6.6] — 2026-07-15

### Fixed
- **Usenet grabs no longer fail with "Too few parameter values were provided".**
  Indexers that answer in JSON sometimes send the release guid as an object
  rather than a string; since 0.6.5 that guid is recorded with the grab, and the
  object shape broke the database write, failing the download at the moment it
  was handed to the client. Guids are now always normalized to strings (falling
  back to the NZB URL), and the database layer drops any non-string guid instead
  of failing the grab.
- **Failed downloads log the full error trace.** A download that fails with a
  generic low-level error (e.g. a database driver message) previously recorded
  only the bare message on the queue row; the Logs page now captures the stack
  trace so the actual source is identifiable. Release blacklisting is also
  hardened: a bookkeeping error there can no longer replace the real failure
  reason on the queue row or fail a search.

## [0.6.5] — 2026-07-15

### Added
- **Failed Usenet releases are blacklisted.** When the download client reports a
  Usenet download as failed (broken par2/repair, missing articles), that exact
  release is remembered and skipped on future searches, so a retry grabs the
  next-best release instead of re-fetching the same broken one over and over.
  Only a client-reported failure blacklists — an import hiccup or an offline
  client doesn't. A new **Blocklist** tab on the History page lists blocked
  releases and lets you remove one (allowing it to be auto-grabbed again) or
  clear them all.

## [0.6.4] — 2026-07-15

### Added
- **Add series picker** — results already in your library are now grayed out with
  an "In library" shortcut that opens the existing series (instead of only telling
  you after you click Add), and each result's name links to its details page.
- **Browser image variant** — a `…-browser` image tag (e.g.
  `ghcr.io/backissueapp/backissue:latest-browser`) built with Chromium + Xvfb for
  plugins/addons that drive a real browser. Most installs use the lean default;
  switch the tag only if an addon needs it.

### Security
- **Tightened API permissions.** The import folder picker (`/api/scan-folder`),
  which lists server directories, now requires library management; download-queue
  controls (pause / resume / clear) now require `downloads.grab`, matching who can
  view the queue; and library-mutating writes are pinned to the manage permission
  explicitly so they can't drift if defaults change. (Marking your own
  notifications read now only needs viewer access.)

### Fixed
- **Add series search** — results no longer flip to a stale query (e.g. showing
  "Hu…" matches right after you finished typing "Hulk"). Out-of-order search
  responses are discarded, so only the current query's results are shown.
- **Browser image** — the headed browser now starts reliably after a container
  restart. A stale X11 lock kept across a `docker restart` (autoheal, restart
  policy) made Xvfb abort with "display already active", leaving the browser with
  no display; the entrypoint now clears the stale lock/socket on boot.
- **Usenet download cleanup** — when the download client refuses to remove a
  finished download, it's now logged instead of failing silently, and SABnzbd's
  history delete is checked for a logical failure. Completed files that weren't
  being removed now surface a reason in the log.

## [0.6.3] — 2026-07-13

### Added
- **Unraid** — BackIssue can now be installed straight from the **Apps** tab. The
  repository ships a Community Applications template (`templates/backissue.xml`)
  with the paths, ports, and permissions pre-mapped, plus a `ca_profile.xml`.

### Fixed
- **Add indexer** in Settings opens its dialog again. The indexer modal was never
  mounted, so the "Add indexer" button — and the per-row Edit button, for both
  Newznab and Torznab — did nothing.

## [0.6.2] — 2026-07-12

### Changed
- External login backends (credential-provider plugins) now also verify
  **HTTP Basic** credentials, not just the web login form — so users who sign
  in with those credentials can reach the API and **OPDS** with them too. A
  verified pair is cached briefly so the backend isn't called on every
  request, and the login lockout still applies.

### Fixed
- **"-1" issues** (the Marvel Flashback minus-one issues) can now be found and
  downloaded. Search read `-1` as `1`, so the query dropped the number and every
  result came back as the wrong issue. The release parser now treats a
  standalone leading minus as the issue number — a hyphen inside a series name
  (*X-23*, *Spider-Man*) is unaffected — and the search query keeps the `-1`.
  Fixes matching across Usenet, torrents, and AirDC++.

### Security
- Accounts that sign in through an external service can no longer be given a
  **local password** — neither by the user (Change password is hidden and the
  endpoint refuses) nor by an admin. Access stays governed by the provider, so
  revoking it there (e.g. a lapsed subscription) reliably locks the account
  out, with no local password left as a back door.
- Viewing the **download queue** now requires the `downloads.grab` permission.
  Previously any signed-in user could read `/api/queue`; a read-only viewer
  shouldn't see what others are downloading. (The web UI already hid the queue
  view — this enforces it at the API.)
- Viewing the **download history** (`/api/history`) now likewise requires
  `downloads.grab` — it exposes the download source per issue, which a
  read-only viewer shouldn't see.

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
