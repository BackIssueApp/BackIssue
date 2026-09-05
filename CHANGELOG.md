# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the Docker image of the same version).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

### Fixed

- The weekly release feed now carries a full issue name in its title field;
  the Releases view no longer shows it as a second line under the series, and
  it is never cached as the issue's story title.

## [0.7.9] — 2026-09-04

### Added

- **Monitoring policies and per-issue picks.** Every series now has a
  monitoring policy — **All issues**, **New issues from #…**, or **Off** — set
  from the ⋯ menu on the series page or in bulk from the Library. On top of the
  policy, any issue can be **picked** or **skipped** by hand (the target button
  on issue rows and on the Wanted page); a pick always beats the policy, so
  you can want one issue of a series you don't otherwise monitor, or skip one
  issue of a run you do. Pressing Download on an issue the policy doesn't want
  records a pick, so a failed grab keeps being retried. "Wanted" is now one
  definition shared by the Wanted page, the search schedules and the RSS and
  announce watchers.
- **Wanted page: gaps, sorting, bulk selection.** The page shows what
  automation is going after, with a *picked* marker on issues you asked for
  and each series' policy; **All gaps** switches to every missing issue,
  wanted or not, so anything can be wanted with one click. Sort by series,
  newest/oldest release, or most/fewest wanted; tick rows (shift-click for a
  range) to Want, Don't want or Download them together. Skipping a queued or
  failed issue takes it out of the queue.
- **Choose the default policy.** Settings → Downloading → **Monitor added
  series** decides what a series gets when it enters the library (added by
  hand, Discover, Releases, reading lists, requests, import): All issues,
  New issues only, or Off. Download on add queues what that policy wants.
- **You're told when a picked issue lands.** Whoever picked an issue (by
  hand, from a list, or through an approved request) gets a notification when
  it arrives, and the pick retires. Picks whose issue turned up by other means
  (a scan, a pack) are swept up by the nightly wanted search.
- **Ongoing / Ended filters** in the Library, from enriched publication
  status, with the status shown on list rows; and **System → Tools → Refresh
  series metadata**, which re-pulls every matched series (one request a
  second, stops cleanly on a rate limit) so older series get that status,
  enrichment and any issues published since.
- **Want a whole reading list.** *Want all* on a list makes every issue on it
  wanted: series already in the library get the issues picked, series that
  aren't are added with monitoring off and just those issues picked.
- **Download only the issues you asked for.** Settings → Downloading →
  **Only the issues that were asked for**: when a series is added because of
  specific issues — a reading-list entry, a release, a CBL import — it arrives
  with monitoring off and just those issues picked, so only they are
  downloaded (now, and again if a grab fails). Adding from the Library or
  Discover, where no particular issue was in mind, still monitors the whole
  run. Off by default, so nothing changes unless you turn it on.

### Changed

- **Library filters** gain **Monitored** beside **Not monitored**; series
  monitoring new issues only show *new from #…* in the list view, and the bulk
  bar has a **Monitoring…** action. The series page shows the policy as a
  header tag, a **Wanted** count in the completion bar and a **Wanted** issue
  filter; the old on/off *Auto-download* toggle is replaced by the policy menu.
- Existing libraries migrate automatically: series that were auto-downloading
  become **All issues**, everything else **Off** — nothing that was being
  fetched stops. The Wanted page now defaults to wanted issues; the previous
  every-gap view is the **All gaps** chip.

## [0.7.8] — 2026-09-04

### Added

- **Dedupe good copies.** A series with two valid copies of the same issue
  (two downloads, a scan beside a digital release) had no way to tidy up —
  "Remove duplicates" only covered corrupt copies a good one had replaced.
  It now removes extra good copies too, keeping the best (tagged first, then
  the most pages, then the largest), and says which it kept. Tools → Remove
  duplicate files does the same library-wide, previewing the good-copy part
  to Logs unless you tick the box.
- **Tools → Re-check mismatched volumes.** Finds series whose files go beyond
  their ComicVine volume's last issue and re-matches them with the improved
  matcher; a clear winner is applied and its files re-linked, the rest are
  left for Fix match.

### Fixed

- **Files that were clearly on disk showed their issue as missing.** Three
  causes, all fixed. Filenames in the *Series (Year) NNN (tags)* style — a
  common convention for libraries organised by other tools — parsed to no
  issue number at all, so the file could never be tied to its ComicVine issue.
  A ComicInfo tag whose `<Number>` didn't match ComicVine's numbering blocked
  the link even when the filename was fine; the filename is now tried as well.
  And `001a`-style numbers now match ComicVine's `1A`. The series page also
  gains an **unmatched files** panel listing any file in the folder that isn't
  tied to an issue, with the number BackIssue read from it — so the reason is
  visible instead of the file being silently invisible. Rescanning a series
  (or the next library scan) relinks existing files; no re-import needed.
- **Auto-match no longer picks a same-name mini over the real run.** Matching
  now weighs a volume's issue count against the files you have — a 13-issue
  volume can't be the home of your #14–#163 — and, when the first search
  isn't conclusive, also asks ComicVine for that year's volumes by name
  (common titles have hundreds of volumes and the search stops at 100, so
  the right run could be missing entirely). It also tries the series name
  and year the files themselves carry in their tags — a short legacy row
  ("Jeff") that captured the folder of *It's Jeff Infinity Comic* now finds
  the real volume. **Fix match** counts every file on disk, linked or not, so
  the right volume ranks first.
- **PDFs were flagged corrupt.** A PDF was being verified as if it were a ZIP
  ("not a zip file"); it's now recognised as a PDF, with its page count.
- **A completed download with a non-ASCII name could fail to import forever.**
  When the download client's reported file can't be read (a name like
  "Blüdwire" mangled across a network mount), the job folder is searched for
  the comic instead; and a release that still can't be read is blocklisted
  rather than re-grabbed on every wanted search.
- **Negative issue numbers** (`#-1` flashback issues) now link.
- **Two series rows on one ComicVine volume.** A series added straight from
  ComicVine while the folder's own row was matched to the wrong volume left
  two rows — and, once the folder row was re-matched, two copies of every
  file. Matching now folds a twin row into the one being matched (files,
  wanted issues and follows move over), and **Tools → Merge duplicate
  series** cleans up pairs that already exist.

## [0.7.7] — 2026-09-03

### Added

- **CBL reading lists.** Lists → **Import CBL** takes a `.cbl` file (the
  reading-list format shared by many comic apps), or browses the community
  catalog of 1,700+ curated lists — whole events, character runs and
  alternate universes, far larger than a single ComicVine story arc — and
  imports one in a click. The catalog is browsed like the repo itself:
  publisher folders with counts, breadcrumbs, lists only at the level you're
  in, and a search that flattens every folder at once; lists you've already
  imported are marked. Any list can be **previewed** first — its books in
  reading order with owned / missing / no-id counts, filters, and same-series
  runs grouped without reordering — and a file you upload is previewed
  before anything is created. Books resolve to ComicVine issues by the ids the
  files carry (with a name + year + number fallback), the file's own reading
  order is kept, and anything that can't be matched is shown after the
  import — each with the reason — rather than dropped. Download missing, sharing and OPDS work on
  the result like any other list.

- **URL base for download clients.** When a reverse proxy serves a download
  client under a subpath rather than at the root — common with seedbox
  providers and Docker stacks — set **URL base** on the client and BackIssue
  talks to `http://host:port/<base>/api/…`. Same field the *arr apps call
  "URL Base", and available for **every** client: SABnzbd, NZBGet,
  qBittorrent, Transmission and Deluge. Blank keeps the previous behaviour
  exactly. A path typed into the Host field is now understood as a URL base
  too, instead of producing a broken address like `http://host/sabnzbd:8080`.
- **Share a reading list with everyone.** A list (or an imported story arc) can
  be published so every user sees it alongside their own — useful for a house
  reading order or a curated run. Only the owner can edit or delete a shared
  list, and publishing rides a new **Share reading lists** permission
  (`lists.share`, trusted tier) so admins decide who can put a list in front of
  the whole install. Shared lists never expose mature content to roles that
  can't otherwise see it.
- **Sidecar metadata (share-safe tagging).** A new **Tag placement** setting
  (Settings → Metadata → Tagging & files, with a per-library override) writes
  each comic's ComicInfo metadata to a `.xml` file next to the archive instead
  of into it. The archive is never modified — its bytes stay identical, so
  torrents keep seeding and DC-hub share hashes stay valid — and `.cbr`
  downloads stay `.cbr` instead of being converted for tagging. Sidecars are
  read everywhere embedded tags are (scans, imports, the untagged filter),
  follow their file through renames and refiling, and are cleaned up with it
  on delete. When a file has both, the sidecar wins.

### Fixed

- **Auto-search now matches releases tagged with a volume marker.** A release
  named like `Stumptown v3 007` carries a `vN` volume marker before the issue
  number; the parser was leaving it glued to the series name (`Stumptown v3`),
  so the strict auto-download matcher rejected an otherwise perfect match — an
  issue would show as unfindable automatically even though a manual search
  surfaced and downloaded it fine. The marker is now stripped, so `vN` /
  `Vol N` releases match by series and issue number as expected.

## [0.7.65] — 2026-07-27

### Fixed
- **New volumes of long-running names no longer missing from Add search.**
  The Add-series and Match-to-ComicVine pickers capped results at 25/20, and
  ComicVine lists same-name volumes oldest-first — so for names like "Batman"
  the newest series (the ones people most often add) fell below the cutoff and
  never appeared. Both pickers now show the full result list. (#2)
- **Add-series search no longer stalls the whole app on big libraries.**
  Flagging search results already in the collection looked up each of the 100
  results by ComicVine id without an index — at hundreds of thousands of
  series that table-scanned for ~20 seconds per search, freezing every other
  request with it. The lookup is now indexed (instant, and the index applies
  on upgrade).

### Added
- **Search by ComicVine id.** The Add-series search accepts `cv:166619`, a
  pasted ComicVine URL, or a bare volume id and jumps straight to that volume —
  the sure route when a name search can't surface the right series. (#2)
- **Filter a library by facets.** A **Filters** button on book/audiobook
  libraries opens a modal that narrows the grid by author, decade, format, and
  reading status — each with live counts. It filters the real grid, so sorting,
  search, and paging keep working within the selection. (The facet data comes
  from a library plugin; libraries without one simply don't show the button.)
- **Collections.** A **Collections** entry in the sidebar lists multi-volume
  book/audiobook series — every series that groups 2+ volumes (box sets) — as a
  focused view of the Library grid.
- **Sort by publication year.** The Library sort gains newest- and oldest-first
  by publication year; books and audiobooks carry the year, and undated titles
  sort last. Plugins can drive it as the `year` / `year-asc` collection sort.

### Changed
- The paginated collection query can be narrowed to an arbitrary set of series
  ids by a plugin-registered `registerCollectionFilter`, which is what backs the
  Library Filters modal (and the mobile audiobook filters).

## [0.7.6] — 2026-07-25

### Added
- **One remote-media source hook for every media kind.** Plugins that back an
  on-demand library now register through a single `registerRemoteMediaSource`
  hook that carries a `mediaType` (books, audiobooks, …) and supplies either a
  whole-file download or a range-stream for large files. Adding a new on-demand
  media type no longer needs a new core hook. The original book-only hook stays
  as a compatibility alias, so existing source plugins keep working unchanged.

### Changed
- **The Library grid now loads a page at a time (server-side pagination).**
  Filtering, sorting, searching and the library selector all run in SQL, and the
  grid fetches ~200 rows at a time, loading more as you scroll (infinite scroll)
  instead of pulling the entire collection up front. On a 141k-entry library the
  first paint's response dropped from ~57 MB to ~85 KB (the browser no longer
  parses tens of megabytes to show the first screen), and each filter/sort/search
  change fetches just the first page. Comics and manga behave exactly as before.
- **Library grid loads a very large collection far faster.** The collection
  query is now a single scan that fuses the rows and the filter-chip counts
  (previously two full passes per load), and its per-series rollups are
  pre-aggregated in one grouped pass instead of a fistful of per-row subqueries.
  On a synthetic 150k-entry library this cut a Library load from ~3.9s to ~1.4s
  server-side. Added a `library_files(series_id, valid)` index for the ownership
  rollups.
- **The app is much snappier with a large on-demand book catalog.** Two fixes:
  the status poll (every ~2s) was running unindexed full scans of a 141k `series`
  table — added `series(library_id)`, `series(type)`, and a partial
  `series(followed)` index, cutting its work from ~390 ms to ~35 ms per poll. And
  opening or scrolling a library now scopes its per-series rollups to just that
  library (or page) instead of aggregating the whole catalog — opening a 1,600-
  series Comics library dropped from ~600 ms to ~80 ms; the huge Books library is
  unchanged.
- **Home is now your reading rails; libraries open from the sidebar.** The app's
  home (`/`) shows your reading shelves (Continue, Next up, and so on) instead of
  every book, comic and manga at once. Each library is a **Libraries** entry in
  the sidebar — selecting one opens its grid. Search still shows results across
  everything.

### Added
- **"Hide mature content" — a personal preference.** Each account can hide series
  marked mature from their own Library, search, reader and OPDS — even if their
  role is allowed to see them — from **Profile → Content**. Nothing is deleted;
  turning it off shows the content again. (Roles without the mature-content
  permission never saw it in the first place.)
- **On-demand books show in the Library as "available".** File-less catalog
  entries (books that download on first open) now appear in the Library grid
  alongside your owned books, in their own type lane, with a clear "available"
  badge — distinct from owned and from missing. An on-demand book is never
  counted as missing or incomplete: it is there to read, just not on disk yet.
  A series that mixes owned and on-demand books rolls up correctly (e.g. `2/5`
  with three available). Comics and manga are unchanged.
- **On-demand ebook libraries (plugin hook).** `registerRemoteBookSource` lets a
  plugin expose an entire remote book catalog as file-less library entries —
  metadata and covers only, no downloads. The ebooks plugin syncs the catalog
  into a Books library and fetches each book's file the first time someone opens
  it to read (cache-on-read), so a huge shelf can be browsed without downloading
  it up front. The hook is generic: `listPage(config, page)` paginates the
  catalog and `materialize(config, id, opts)` downloads one book on demand.
- **Pluggable ebook metadata sources (plugin hook).** `registerBookMetadataSource`
  lets a plugin supply a book-metadata source that the ebooks plugin tries
  BEFORE its built-in hosted fallback (by ascending priority). A metadata-source
  plugin can register as the preferred source, so its richer series/genre data
  and covers enrich your library when it has the book, with the hosted service
  filling in the rest.
- **Wanted "Following" filter and star badges are per-user.** The chip now
  filters by your ☆ Follow (matching the series-page star) instead of the
  global auto-download flag — so it no longer shows series you did not
  personally follow. The global flag still governs what the auto-grabber
  downloads; the two are now separate throughout.
- **"Remove ghost series" tool (System → Tools).** Finds leftover series from
  before ComicVine matching — no CV match, no files on disk — whose wanted
  issues clutter the Wanted tab but can never download (and which the normal
  untrack path deliberately keeps). Runs as a preview logging the full list;
  tick "Actually delete" to remove them (issues and follows included).
- **"Download all" on the Releases page.** One button queues every tracked,
  unowned release in the current view — the manual catch-up for weeks where
  auto-grab missed some issues. Skips releases already queued or owned, and
  reports one summary instead of a toast per issue.


### Changed
- The Wanted tab's "Monitored only" filter is now called **"Following"** — it
  filters by the ☆ Follow star on series pages, and nothing else in the app
  ever called that "monitoring" (users couldn't find the control).

### Fixed
- **Native mobile apps no longer choke on very large libraries.** The mobile
  apps request the whole library as one unpaginated list; on a library with a
  large on-demand book catalog that response held ~140k entries and the app ran
  out of memory rendering it. The unpaginated collection endpoint now returns
  only the native comic/manga libraries, so the apps stay fast (the web Library
  grid is unaffected — it pages, and still shows every library type). Book
  support in the mobile apps will restore those libraries with paging later.

## [0.7.5] — 2026-07-23

### Added
- **Plugin-owned series views (plugin hook).** A plugin that registers a
  library type can now take over the issue area of that type's series pages
  (`registerSeriesView({ type, render })` on the client bridge): the hero,
  byline, description, and ⋯ menu stay core, while the filter chips, issue
  grid/list, and selection toolbar are replaced by the plugin's own
  rendering — re-drawn whenever the series data refreshes or the plugin
  signals a state change. Comic and manga series are unaffected. Powers the
  ebooks plugin's book-shelf series pages.
- **Self-described library types (plugin hook).** `registerLibraryType` now
  accepts `selfDescribed: true`: series of such a type carry their own
  metadata on the series row (title, byline, year, cover, description — a new
  `series.description` column) and list their local issue rows. The Library
  grid and series pages render them like any matched series, the ComicVine
  machinery (match sweep, "unmatched" lane, download buttons) leaves them
  alone, and removing one deletes its rows cleanly. Powers the ebooks
  plugin's Books libraries.
- **Import handlers (plugin hook).** Plugins can register an Import-tool
  handler (`registerImportHandler`) for non-comic file types: the import scan
  asks each handler to propose candidates for the same review list (with the
  handler's own metadata match on the card), and confirmed candidates are
  imported by the handler — e.g. loose ebook files filing into a Books
  library.
- Per-issue plugin actions and covers now work on self-described series
  pages, so plugin types get Read/Download-style actions on the normal rows.
- **Library scanners (plugin hook).** A plugin can register a scanner for its
  library type (`registerLibraryScanner`); creating or editing a library of
  that type indexes it immediately, the same way comic libraries scan.
- Failed series adds now log a warning with the underlying network cause
  (previously the error only appeared as a client toast, leaving nothing in
  the server logs to diagnose).
- **Transmission and Deluge support.** The torrent source can now download
  through Transmission or Deluge as well as qBittorrent — pick the client under
  Settings → Sources → Torrents, with per-client connection fields and a Test
  button. The category maps to a label on both new clients (Transmission 4.x
  labels; Deluge's Label plugin when enabled), and the completed-folder path
  mapping is shared across all three.

### Fixed
- **The built-in metadata service ignores the old Service URL setting.** A
  stale or malformed `cvBaseUrl` value silently redirected (or broke)
  metadata and key registration — errors that read as auth failures ("HTTP
  401"). Hosted mode now always uses the official endpoint; registration
  errors name the exact URL they tried; and Settings → Metadata shows the
  install's registration status with a "Test service" button that provisions
  the key on demand.
- The Content-Security-Policy now permits same-origin `blob:` frames and
  blob/data images, fonts, and styles — in-browser book reading (the EPUB
  shell renders sections into sandboxed blob: iframes) showed a blank page
  under the previous policy. Scripts remain restricted to self + the inline
  bootstrap, and framing the app stays forbidden.
- Library-wide scans and boot reconciliation no longer prune `library_files`
  rows they didn't index: pruning is scoped to the comic file types the scan
  actually walks, and files of series that belong to an explicit library are
  kept — so plugin-indexed files (e.g. ebooks) survive "Scan entire library".
  The Verify tool likewise skips non-comic files instead of flagging them
  corrupt.
- The metadata-service instance key is persisted only by the live app
  configuration — test runs (or any code constructing its own config) can no
  longer overwrite the real key in `settings.json`, which previously caused
  metadata 401s and re-triggered onboarding.

### Changed
- **Onboarding no longer has a Metadata step.** New installs use the built-in
  metadata service automatically — nothing to configure. Switching to a
  personal ComicVine key lives in Settings → Metadata, which now shows a
  warning about ComicVine's API rate limits when that source is selected.
- The onboarding torrent step now offers all supported download clients
  (qBittorrent, Transmission, Deluge), matching the usenet step's selector.
- Indexer descriptors from indexer providers can now pin their own
  Newznab/Torznab category filter, which overrides the per-search default.

## [0.7.4] — 2026-07-20

### Changed
- **Metadata works out of the box.** BackIssue now defaults to the hosted
  BackIssue metadata service — cached series/issue data with enrichment and
  no rate-limit pauses — authenticating with a key each install provisions
  for itself on first use. No ComicVine API key is required anymore. Prefer
  querying ComicVine directly? Set Settings → Metadata → Source to ComicVine
  and add your own key (existing installs with a key keep working either
  way). Onboarding's ComicVine step is now optional accordingly.


## [0.7.3] — 2026-07-18

### Added
- **Indexer-provider plugins.** Plugins can now supply Newznab/Torznab indexers
  to the built-in Usenet and Torrent sources (`registerIndexerProvider`), so an
  external service can manage indexers on their behalf — when a provider is
  active it can take over, and the manually entered indexers are shown as
  managed and ignored. This powers the new **Prowlarr** plugin (point it at your
  Prowlarr instance and pick which of its indexers to use).
- **Settings has a Plugins tab.** Plugins that aren't download sources can now
  mount their settings panel in a dedicated **Settings → Plugins** section
  (`settings-plugin-panels`) with its own rail — instead of squatting in
  Sources. The tab appears only when an installed plugin uses it.

### Changed
- Plugin menu items registered under the **System** section now join the core
  System group in the sidebar (below Settings) instead of forming a second
  "System" header of their own.
- Removed the misleading **"no download source"** marker from the Library (the
  grid card icon and the list-view badge). It keyed off whether a series row
  carried a catalog/scan URL rather than a ComicVine one, which no longer says
  anything about downloadability — sources are resolved on demand — so it fired
  on ordinary ComicVine-matched series.
- Removed the **Manga** filter chip from the Library toolbar. Manga now lives in
  its own library (with its own sidebar entry), so filtering the combined view
  by type is redundant.

### Fixed
- The **Queue** badge (sidebar) and the header status pills now match the queue
  view. They were counting only *queued* and *downloading* items, so issues
  handed off to the download client or being tagged — plus active pack grabs —
  were left out, and the badge read lower than the number of rows actually on
  the Queue page. All in-flight work is now counted.

## [0.7.2] — 2026-07-17

### Added
- **The interface redesign now spans the whole app.** Building on the queue,
  plugins and System refresh, this release restyles the **Library** (filter chips
  with live counts, a unified status-badge vocabulary, progress that turns green
  at 100%), the **Series** page (a hero completion overview and per-filter issue
  counts), the **Add** and **Source-search** dialogs (a Comics/Manga switch,
  color-coded source badges and seeder counts, a guided "ComicVine key required"
  state), the **Stats** dashboard (completion ring, KPI tiles, and format/
  publisher/downloads panels with a 14-day sparkline), **History** (day-grouped,
  mode-aware rows with a stat strip), **Wanted** (collapsible per-series cards),
  **Reading lists** (a two-pane master–detail), the first-run **Onboarding**
  wizard, the **Profile** page, the **sidebar**, and **Users** (split into
  Accounts and Roles tabs). Same features, endpoints and data throughout.

### Changed
- **The CBR→CBZ conversion ceiling now scales up with your host's memory** instead
  of a fixed 400MB, so a big server converts (and tags) much larger collected
  editions. It never drops below the proven 400MB baseline and reads a container's
  memory limit (cgroup) rather than the host's total RAM. Roughly a 1GB ceiling on
  a 32GB box, ~400MB on 8GB or less. Override it with the `MAX_RAR_MB` environment
  variable.
- **First-run setup builds named libraries.** The Onboarding wizard's Library
  step now creates one or more named libraries (each with a type and folder)
  through the library model instead of a plain root-folders box.

### Fixed
- **Oversized CBR downloads no longer fail.** A collected edition delivered as
  a RAR too large to repack in memory used to error out with "too large to
  convert safely"; it's now filed as-is as a `.cbr` — readable natively —
  instead of being lost. Smaller CBRs still convert to tagged CBZ as before.
- **Installed plugins show available updates.** A plugin with a newer catalog
  version now surfaces an "Update → v…" button on its Installed card — the match
  keyed on the wrong field before, so updates never appeared.

## [0.7.1] — 2026-07-17

### Added
- **Download queue, redesigned as a full page.** A stat strip (active /
  queued / failed / down-speed) reads the pipeline at a glance, filter tabs
  (All · Active · Queued · Failed, with live counts) cut through big queues,
  rows carry a cover cell and the failure reason inline, and packs stand out
  with an amber pack badge. Same data, same actions — pause/resume, retry,
  clear, per-row cancel — same permissions.
- **Bulk read status** (with Comic Reader ≥ 1.5.1): **Mark read** / **Mark
  unread** buttons on the series page act on the checked issues — or the whole
  series when nothing is checked. Under the hood, plugin series actions can
  now read the issue selection (`BackIssue.selectedIssues()`).
- **Queue rows name their source.** The live progress line carries a source
  badge (and, for in-app downloads, the mirror the bytes come from — e.g.
  "via PixelDrain"), so you can see at a glance which source is serving each
  download while it runs. A slow pre-download step (connecting, or getting past
  a host's bot protection) shows a live "Connecting…" / "Solving challenge…"
  phase with a pulsing bar instead of a stuck "Downloading · 0 B".
- **Plugins, redesigned as a catalog page.** Category tabs (Notifications ·
  Sources · Metadata · Auth · Utility) with live counts and a search box, a
  two-column card grid split into Installed and Available, capability chips
  (what each plugin registers — download sources, API routes, jobs, UI,
  settings, startup tasks), a per-card enable/disable toggle and a Configure
  shortcut, and the restart banner. Same endpoints and restart flow.
- **System page unifies Jobs, Tools and Logs.** The three admin pages are now
  one tabbed **System** page. Jobs keeps the scheduled-task table and recent-run
  cards; Tools keeps the featured Reorganize-library flow and the maintenance
  grid; Logs gains **expandable detail rows**, **search-term highlighting**,
  **per-line copy**, a **live-tail toggle**, and **export to a text file**.
  Old `/jobs`, `/tools` and `/logs` links redirect to the matching tab.

### Fixed
- **Downloaded issues can be multi-selected.** The series-page checkboxes
  only rendered on missing issues (they were built for bulk downloading) —
  now every issue is selectable, so Mark read/unread and Add to list work on
  owned issues too. The Download button acts on the downloadable subset of
  the selection.
- **Corrupt downloads stop looping.** A usenet release whose archive turns out
  damaged at import (the client reported the download complete, but the file
  itself is broken) is now blacklisted like a failed download — retrying grabs
  the next-best release instead of re-fetching the same broken file forever.
  Transient import errors (permissions, unreachable paths) still never
  blacklist. The import log also says honestly when there was no alternative
  file to try.

## [0.7.0] — 2026-07-16

### Added
- **Manga catalogs.** The Add dialog gains a **Search manga** toggle — a
  dedicated manga catalog (served by the metadata server) instead of
  ComicVine. The first manga add creates the Manga library automatically
  (with a pointer to give it a folder); added series file into it typed
  manga — chapter-aware search, right-to-left reading (Comic Reader ≥ 1.5.0),
  chapter publication dates, and adult-rated titles arrive pre-flagged
  mature. Import scans of manga-library folders match against the same
  catalog. A **Manga content rating ceiling** (Settings → Metadata) controls
  how far search reaches — Safe only up to Everything. Manga metadata and
  covers are provided by [MangaDex](https://mangadex.org).
- **Settings, redesigned.** One page per tab instead of one long scroll:
  a new **Overview** tab lands first with health cards (sources, ComicVine,
  libraries, storage, downloading, notifications) and a "Needs attention"
  list that deep-links to the fix. Library and Sources are master–detail —
  a rail on the left (plugin sources included, each with a live enabled dot),
  one panel at a time on the right, sectioned into cards. Roomier stacked
  fields, a cross-tab search box, and an unsaved-changes bar with Discard.
  On phones the rail becomes a drill-in list. All settings keys, connection
  tests, and plugin-injected settings work exactly as before.
- **Bulk "Move to library".** Select series on the Library page and move them
  all into a library from the bulk bar — the library's type and visibility
  ride along, same as the single-series move.
- **Libraries own the storage locations.** The Root folders setting is gone —
  each library's folder is where its comics are filed and scanned. Existing
  root folders migrate automatically on first start: the default becomes a
  **Comics** library (adopting every existing series), and extra scan folders
  each become their own library. The sidebar's **Library** entry shows the
  whole collection; each library entry below it shows just that library.
- **New series land in a library immediately** — the first comic-type
  library by default; the manga lane and import auto-assign override it.
  (Previously an added series belonged to no library until the next restart.)
- **Explicit libraries.** Split the collection into named libraries (e.g.
  *Comics* and *Manga*), each with its own sidebar entry. A library has a
  behavior type and its own folders (the first is where new downloads file;
  the rest are extra scan locations) — Import auto-assigns anything found
  under any of them. Move series between libraries from the ⋯ menu; deleting
  a library moves its series to a surviving one, never off disk.
  Managed in Settings → Library → Libraries. With no libraries defined, the
  sidebar grows automatic per-type entries once a second type appears.
  Libraries can also carry their own **folder pattern** (e.g. `{series}` for a
  publisher-less manga tree) and a **Mature** flag that hides the whole
  library — entry, name, and members — from roles without the mature-content
  permission, riding the same enforcement as per-series restriction.
- **Library types — first cut, starting with manga.** Every series now has a
  library type (comic by default). Mark a series as manga from its ⋯ menu, or
  let import infer it from ComicInfo's `Manga` tag. Manga series get
  chapter-aware searching (releases named `c1044`, `Ch. 105.5`, `Vol. 37` now
  match), an extra chapter-form indexer query, and a **Manga** library filter.
  The type field is extensible groundwork — magazines are planned next.
- **Plugins can register library types** (`registerLibraryType({ id, label })`):
  a registered type becomes settable on series and gets its own library filter
  lane. Groundwork for type-defining plugins (e.g. a future magazines plugin
  that generates date-based issues).

## [0.6.7] — 2026-07-15

### Fixed
- **Image updates no longer re-download the whole image.** A per-commit build
  stamp sat above the dependency layer in the Dockerfile, changing every
  layer's identity on every build — so each `docker compose pull` fetched
  ~the full image even for a one-line change. Layers are now ordered by how
  often they change, with the build stamp last: after the first pull of a
  fixed image, routine updates download only a few MB.
- **Usenet imports survive extra or mislabeled files in the finished download.**
  A damaged leftover archive (e.g. a stray `.rar` part) sitting next to the real
  comic could be picked first and fail the whole import with "Archive header or
  data are damaged". Import candidates are now ranked (comic files before
  generic archives, larger first), each file's real format is detected from its
  bytes rather than its extension, and an unusable file falls through to the
  next candidate — or to loose page images — instead of failing the download.

### Added
- **Import reads embedded metadata.** The library import now sniffs
  `ComicInfo.xml` from tagged CBZ files (Mylar, ComicTagger, Kapowarr): the
  tagged series name drives the ComicVine search, and the tagged volume year
  and publisher sharpen match ranking — so a tagged library matches correctly
  even when folder names are ambiguous. Better yet, when the tagger left a
  ComicVine id behind (the `Web` link, or "[CVDB…]" / "Issue ID …" in Notes),
  the volume is matched **exactly** by id — no name search, no ambiguity —
  and auto-accepted. Folder names remain the fallback for untagged files.
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
