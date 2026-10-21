# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the Docker image of the same version).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

### Added

- **The paged library list can be limited to comics.** `GET /api/collection` with `limit`/`offset`
  accepts `native=1` to leave out books and audiobooks, and says so in its reply (`native: true`).
  The mobile apps use it to page through large comic libraries instead of loading every series
  at once.

## [0.9.4] — 2026-10-21

### Security

- **Built on Node.js 22.23.4, which fixes the October 21 Node.js security issues.** These include a
  Brotli decompression flaw that could let a malicious server run code (BackIssue fetches from
  indexers, download sites and the metadata service) and TLS hostname checks that could be
  bypassed. Every 0.9.3 and older image runs an affected Node.js. Update promptly.

### Added

- **Re-download corrupt files** (Tools). One run fixes nested archives in place,
  then queues a fresh download of every other corrupt comic, instead of
  re-downloading series by series. A corrupt file stays until a good copy
  replaces it, so an issue no source has loses nothing.

### Fixed

- **Tagging large files no longer runs out of memory.** Writing metadata into a `.cbz` used to
  load and rebuild the whole archive in memory, which failed with "not enough memory" on big
  collected editions. Now only the end of the file is rewritten: the pages are never read or
  re-compressed, so a 1 GB file tags in milliseconds.
- **CBR files are never marked corrupt because the background reader couldn't start.** If its
  threads fail to start on a system, BackIssue now reads archives the old way instead.
- **A queue row no longer shows the last source's page count while the next source searches.**
  When one source failed partway through an issue, its "page 31 / 32" stayed on the row
  while the next source searched; the row now shows the search instead.

## [0.9.3] — 2026-10-19

### Security

- **Sign-in and permission checks now apply to every spelling of a path.** The server matched
  routes without regard to letter case or a trailing slash, but its access checks did not, so
  some requests could skip them. Update promptly.
- **Issue descriptions keep only plain formatting.** Forms, embedded SVG and unknown attributes are
  removed before a description is shown, so description HTML can no longer run script when clicked.
- **Repeated failed sign-ins from one address are throttled across usernames.** After 30 failures
  from the same address within 15 minutes, further attempts wait, whichever username they try.

### Added

- **Update all plugins at once.** When installed plugins have updates, the Plugins page shows
  **Update all** beside the Installed heading. It updates each one in turn, keeps going past a
  failure, and the updates apply on the next restart, like a single update.
- **Library filters can match "everything except".** A plugin's collection filter may return
  `{ excludeIds }` when core passes `ctx.canExclude`, so "unread" in a large ebook or audiobook
  library sends the few books you've started instead of every other book.

### Changed

- **Large libraries stay responsive during scans and on the Library page.**
  - Scanned files match to their series without searching the whole catalog, so a scan no longer
    stalls the server for a fraction of a second per file.
  - Re-linking files to their issues after a scan or at startup now runs in short batches in the
    background instead of freezing the server for up to tens of seconds. After a scan, only the
    series whose files changed are re-linked.
  - The A–Z rail is computed in the background and cached, like the filter counts, instead of
    blocking every Library load and search for about a second.
  - Creator, character and team pages answer from an index instead of reading every issue's
    credits. Existing libraries build the index in the background after the update.
  - Sorting the Library by **Missing** is about 3.5× faster on a large catalog.
  - Looking up books by author (OPDS "by author") uses an index instead of reading every series.
  - The Wanted page, the Stats page and the mobile apps' library list run cheaper queries and reuse
    their last answer until the library changes.
  - Signing in no longer pauses the server while the password is checked, and the "last seen" time
    of a session or API key is recorded at most once a minute instead of on every request.
  - Reading CBR archives during scans, imports and conversions happens on background threads, and
    PDF page counts are read in pieces, so a large file no longer pauses the server. An archive
    that crashes the reader now fails on its own instead of taking the server down with it.
  - The live-update stream re-checks the queue, logs and import list only when something changed,
    starting the app skips two full scans of the metadata cache, "Download missing" on a large
    series records its issues in one step, and the database's write-ahead log no longer stays at
    its peak size after a big job.
- **Faster first load.** Wanted, Queue, Releases, History, Stats, Import, Plugins, Users, Lists and
  the setup wizard now load when first opened (and are fetched in the background once the app is
  idle), so the app downloads about a quarter less before it can show anything.
- **`GET /api/series` is paged.** It returns up to 100 series by default (`?limit=` up to 500, plus
  `?offset=`). It used to return the entire catalog in one response.

### Fixed

- **A finished download no longer deletes a different issue with the same number.** Replacing the old
  copy of an issue matched on the issue number alone, so downloading Batman #1 could delete
  Batman Annual #1 from the same folder. A download that fails its archive check no longer
  replaces anything either.
- **Removing a comic with its files deletes only folders it leaves empty.** It used to delete each
  folder that held one of its files with everything still inside, including other series sharing it.
- **An unreadable settings.json is kept, not silently replaced.** BackIssue starts on defaults, saves
  the original beside it as `settings.json.unreadable-<time>`, and logs where; settings are now
  written in one step so a crash mid-save can no longer leave a broken file.
- **Re-download keeps the current copy until the new one arrives.** The old file used to be deleted
  first, so a re-download that found nothing lost the copy you had. It is now replaced only once a
  readable new copy is in place, which takes the old file's name. Re-downloading an issue that is
  already downloading no longer starts a second download.
- **Downloads are written under a temporary name and renamed when complete.** A crash mid-write no
  longer leaves a truncated comic under the real name, and recovery after a restart now looks in the
  comic's own folder and only counts a file that opens as finished.
- **A library scan that can't read a folder keeps that folder's comics.** A brief share or disk error
  on one subfolder used to drop all of its files from the library, so they showed as missing and
  could be downloaded again.
- **Reorganize library no longer re-downloads what it moved, and keeps the app responsive.** Moved
  issues kept pointing at their old location, so asking for one again downloaded it again. Series in
  a library with its own folder pattern are now laid out by that pattern, and a file that differs
  only in letter case from the new name is no longer overwritten. Moves between drives copy to a
  temporary file first, so an interrupted move can't leave a half-copied comic, and planning or
  running a reorganize on network storage no longer freezes the app.
- **Settings can't be saved over with blanks.** If Settings fail to load, the page says so and Save
  stays off until a good load, so a save can no longer wipe your indexers and metadata sources.
- **One failing download no longer stalls the queue.** An unexpected error while preparing or
  recording a download now fails just that issue; before, it could leave the issue stuck as
  downloading and stop the queue from starting again until a restart, or start the same issue twice.
- **A download that fails after its file is saved is not downloaded again.** Retrying used to save a
  second copy beside the first.
- **BackIssue no longer stops itself after the computer wakes from sleep.** The freeze watchdog took
  the time spent asleep for a hung server and shut the app down.
- **An indexer, download client or metadata request that stops answering no longer stalls
  downloads.** Requests now give up after 30 seconds (60 for metadata) instead of waiting up to five
  minutes, so one unresponsive indexer or client can't hold up searches, the queue or imports.
- **A server hiccup no longer breaks or empties pages.** When the server restarts or a proxy answers
  with an error, Wanted, System, Stats, Queue, History, Plugins, Users, Lists and the Library keep
  what they last showed and say the load failed, with a Retry, instead of crashing or showing an
  empty library. Header counts and sidebar libraries no longer drop to zero on a failed poll.
- **Plugin dependency installs can no longer hang startup or break a plugin for good.** The install
  at startup gives up after five minutes, an install that was cut short is retried on the next
  start, and a plugin update whose dependencies fail to install keeps the version you had.
- **A pack download cut off by a restart no longer shows as in progress forever.** Packs a download
  site was fetching inside BackIssue are marked failed at startup, so you can grab them again.
- **qBittorrent downloads are imported only once they have finished moving.** A torrent still being
  moved out of an incomplete-downloads folder, or re-checked, counted as done and the import failed.
- **Half issues are found on usenet, torrents and RSS.** A release named like "Wizard 1/2" was read
  as issue 2, so ½ issues never matched.
- **The download-client folder mapping matches whole folders only.** A mapping for /data/torrents no
  longer also rewrites paths under /data/torrents-old.
- **A scheduled task that hits an error no longer stops the app,** and a search that fails is shown as
  failed on the Jobs page instead of running forever.
- **The library scan's temp-file cleanup only removes BackIssue's own files.** It used to delete any
  .part file older than a day, including other programs' partial downloads in a shared folder.
- **Converting CBR to CBZ keeps the .cbr unless every page made it across.**
- **Two downloads of the same book or audiobook at once no longer overwrite each other.**
- **Setup reports what failed.** The first-run wizard stays open and lists any library or plugin it
  could not create, instead of saying you're all set.
- **Restart app waits for the app to really come back**, even behind a reverse proxy.
- **Scan, tag and match buttons no longer stick on "running"** when the server refuses to start one;
  the button resets and the reason is shown.
- **Downloads report what actually queued.** Downloading from Wanted and "download missing" on a
  reading list only mark and count the issues the server accepted, and say when it refused.
- **Fast clicking shows the right thing.** Switching series, stepping through issues, changing a
  search or filter, or switching reading lists while an earlier request is still loading can no
  longer show the older result.
- **Metadata errors and links speak for BackIssue.** Error messages about the metadata service no
  longer name an outside catalog, and the link to a record's page at its source shows only to people
  who manage settings (and only for a safe web address).
- **"None of the enabled metadata sources can look this up" no longer names a source.** The server
  log still records which source a failed lookup went to.
- Status, series type and age rating tags, log levels and cover prices now appear in your language;
  a series with no title reads "Untitled series".
- Icons replace the remaining text symbols (the series menu, help button, seeders, warnings), row
  actions in History and Lists are always visible on touch screens, and dialogs, issue checkboxes
  and the search box are better labelled for screen readers.
- Searching the logs for "amp" or "lt" no longer garbles lines.

## [0.9.2] — 2026-10-18

### Security

- **A new server is locked until its admin account exists.** Before the first
  account was created, every API request ran as an admin with no sign-in;
  only the web UI insisted on the setup screen, so a server exposed before
  setup could be driven through the API. Now only sign-up answers: the rest of
  the API and plugin assets return `401` with `setupRequired: true` until the
  admin account is created.

### Added

- **Wanted books and audiobooks on the Wanted page.** Plugins can add their
  own tab beside Comics (`registerWantedTab`); the Books and Audiobooks
  plugins use it to list what's wanted, search again, and cancel.
- **Order your libraries and choose the default.** Arrows on each library
  under Settings → Library → Libraries set the order the sidebar lists them
  in, and **Make default** picks the comic or manga library that new series
  go to when you don't choose one. Before, the order was fixed by when each
  library was created, and new series always went to the first comic library.
- **API keys work as a password for reader apps.** Apps that only send a
  username and password, such as OPDS readers, accept your Profile API key
  in the password box, with your username or a blank one.
- **Set a user's password from the Users page.** Admins can give a locked-out
  user a new password. The box comes filled with a generated one to copy or
  replace, and the user is signed out everywhere. Accounts linked to an
  external sign-in are left out, since they have no local password.
- **Sign-in buttons appear only once their provider is set up.** A plugin's
  SSO button can stay hidden until it's configured, and a renamed button shows
  without a restart.
- **`GET /api/auth/providers` reports `apiKeyBasic: true`**, so clients know
  a personal API key works as the HTTP Basic password, the way in for reader
  apps when password login is off.

### Removed

- **Legacy API routes.** `POST /api/download` (use
  `/api/collection/{id}/download`), `/api/usenet/search` and `/api/usenet/grab`
  (use `/api/search` and `/api/search/grab`), `/api/torrent/search` and
  `/api/torrent/grab-pack` (use `/api/packs/search` and `/api/packs/grab`), and
  `/api/cv/test` (use `/api/metadata/providers/test`). The app stopped calling
  them long ago.
- **Leftovers of an old folder-scan report.** Its saved per-folder matches
  were never written by any release, so the empty table is dropped and the
  library scan no longer looks it up. The unused webhook helper the
  Notifications Hub replaced is gone too.

### Fixed

- **The RSS watch and the 0-Day pack job use Prowlarr's indexers.** Both
  read only the manually entered indexer lists, so with Prowlarr managing
  your indexers they had nothing to poll or search. They now use the same
  indexers as searches.
- **Error messages in your language.** About 160 messages the server can
  show, from download-client and indexer failures to account and library
  rules, were English whatever language you picked. They are now translated,
  including the failure reasons on the Queue and History pages and on an
  issue's files. Messages from the metadata service no longer name a
  particular provider.
- **Hide mature content reaches reader apps.** An account that switched it on
  still saw flagged series when an OPDS or other reader app signed in with its
  username and password, or through an external sign-in such as billing. The
  switch now applies to every way an account signs in, and a change takes
  effect on the app's next request.
- **Turning off password login covers reader apps too.** With password login
  off, apps that send a username and password directly no longer let
  non-admin users in with their password. Admins keep their password
  fallback, accounts from an external login backend are unaffected, and
  everyone else uses their API key.
- **Only admins can create, edit or delete libraries.** A library decides which
  folders on disk the app scans and files into. Before, anyone allowed to
  manage the library could point one at any folder on the server. Moving
  series between libraries still only needs library management.
- **Download all respects mature-content restrictions.** On the Wanted page,
  Download all queued issues from restricted series even for people who
  can't see them. It now queues only what that person's Wanted list shows.
- **Plugin task schedules save.** Changing the pattern or switching a plugin's
  task on or off under Jobs (Rebuild the browse index, Fill approved book
  requests, Sync remote audiobook catalog and others) now sticks. Before, the
  change was silently dropped and the task kept its old schedule.
- **Tag on download works without a ComicVine key.** With the switch on,
  downloads are tagged from the hosted metadata service too. Before, nothing
  was tagged unless a ComicVine key was set.
- **Search and add use the library's own metadata sources.** Adding a series
  searches with the sources of the library it lands in, and matching an
  existing series searches with the sources of its library. Before, both used
  the app-wide list whenever a library had its own.
- **Stats shows the metadata sources in use.** Its Metadata badge read the old
  single-source setting, so with several sources it could say "No key" for a
  working setup. It now reflects the ordered list and shows how many sources
  are in use.

## [0.9.1] — 2026-10-17

### Added

- **Translations.** BackIssue can now show its interface in other languages.
  It ships in Chinese (Simplified), Dutch, French, German, Italian, Japanese,
  Polish, Portuguese (Portugal and Brazil) and Spanish, and so do the public
  plugins; the Android and iOS apps follow in their own releases. Pick one
  under Profile → Language, or leave it on "match the browser"; a signed-in
  account keeps the choice on every device, and the page arrives
  already translated rather than flashing English first. English is the
  source of truth, every string a person reads comes from a catalog under
  frontend/src/locales, and a test fails the build when a converted screen
  still carries hardcoded text. Plugins get api.t / api.th / api.lang and
  api.registerMessages for their own strings. Series and issue data stay in
  the language the metadata source provides.
  Labels the server defines (job, schedule and tool names, permission names,
  source-card fields, plugin descriptions) are translated too, and plugins
  can ship translations for the ones they register.
- **Several metadata sources at once.** Settings → Metadata is now an ordered
  list, like download sources: turn on every source you want data from and
  move the one you trust most to the top. A search asks all of them and shows
  the answers together, best first, dropping a series a higher source already
  listed (same id, or same title and start year). A series keeps coming from
  the source that found it, so refreshing it, opening its issues, matching
  files and tagging go back there, and turning that source off leaves the
  series as it is until it is on again. A source that is on but not set up yet
  is skipped rather than failing lookups. Saved settings carry over: the single
  source you had becomes a one-entry list. Plugin providers declare the id
  range they mint (`idRange` or `owns`) so lookups route to them; one that
  declares nothing is handed whatever id no other source claims.
- **Metadata sources per library.** Each library can keep the default source
  list or choose its own under Settings → Library: a manga library on the
  built-in service alone, a library of French albums with the French editions
  source first. A series always refreshes through its own library's list, and
  searching for or adding a series to a library uses that library's list too;
  automatic matching and imports follow the library each series or folder
  belongs to. Book and audiobook libraries keep getting their data from their
  plugins.
- **Bring your own metadata provider.** Settings → Metadata now offers
  **Metron directly**, signed in with your own Metron account, alongside the
  built-in service and ComicVine. Series and issue data, covers, credits,
  characters, story arcs and the issue extras then come straight from Metron,
  under its own rate limits, and comic lookups no longer go to the built-in
  service. The
  source list is now a set of providers that plugins can extend
  (`api.registerMetadataProvider`), each with its own fields and Test button on
  the Metadata tab. Your existing library carries over: a series first added
  through the built-in service or ComicVine refreshes through Metron as well,
  keeping every issue row and file link, because Metron records the matching
  ComicVine ids. Series added while Metron is the source keep ids of their own
  that never collide with ComicVine's; those refresh while Metron is on.
  Discover still needs the built-in service or ComicVine.
- **Jump to a letter in the Library** (#10). When the Library is sorted A-Z, a
  letter rail runs down the right edge: click a letter and the grid scrolls
  straight to the series starting with it, loading whatever it needs to get
  there on the way. The current letter is highlighted as you scroll. The rail
  appears only under the A-Z sort and only once a library has more than a
  handful of series, and it works the same in the poster grid and the list, and
  across comic, book and audiobook libraries.

### Fixed

- **Comics with no pages no longer count as owned.** Archives indexed before
  page-less files were flagged (for example a `.cbz` holding only a
  ComicInfo.xml, left behind by a broken post-processing step) stayed marked
  as good copies, so their issues showed as owned but could not be read or
  re-downloaded. They are flagged on the first start, and a library scan now
  re-checks any such file instead of trusting it. The issues show as missing
  again; nothing is downloaded automatically.
- **Each series remembers where its data comes from.** Every cached series and
  issue now records its catalog (ComicVine, MangaDex, Metron or a plugin's) and
  that catalog's own id, and lookups go by that record instead of guessing from
  the number. Manga is no longer sent to ComicVine or Metron when the built-in
  service is off; it now says it needs the built-in service. Tags written into
  manga files no longer claim a ComicVine issue number, and a series page only
  links to ComicVine for a ComicVine record. Existing libraries are filled in
  automatically on the first start. Plugin metadata sources can declare
  `catalog`, `serves`, `alsoServes` and `refOf`; one that declares only
  `idRange` keeps working unchanged.
- **A download host's challenge page is no longer saved as the comic.** Some
  file hosts answer a download with a normal-looking web page — a challenge or
  rate-limit notice — rather than an error, and that page was being written to
  disk as the archive and only caught at import. It is now recognised on the
  way in: the host is cleared through FlareSolverr where one is configured, or
  through the browser as a last resort, and the file is fetched again; failing
  both, the error names the page so it is clear what happened.
- **Metron's Test sign-in no longer spins forever** when metron.cloud cannot
  be reached. Every Metron request now gives up after 15 seconds and is
  retried once, and the message says the host timed out and may be blocking
  the server, so a blocked address is told apart from a wrong password.
- **A cover price in another currency is shown as sent.** The issue panel used
  to put a dollar sign in front of every price; a source that prices in euros
  or francs now has its own sign or code kept.
- **Warning toasts have their own look.** A partly failed action (such as a
  reading-list import with some misses) shows an amber toast instead of an
  unstyled one, and a few places that passed the wrong toast type show the
  right one.

## [0.9.0] — 2026-10-09

### Added

- **Right-click menus on series and issues.** A series card in the Library, and
  an issue in either the grid or the list on a series page, now open a menu on
  right-click (press and hold on a touch screen). A series offers open, follow,
  download missing, its monitoring policy, and remove; an issue offers whatever
  the installed plugins contribute first (with the reader, that is Read, Mark as
  read/unread and Read later), then issue details, download or re-download, and
  want or skip. The menu is built when it opens, so it always reflects that row
  as it stands, it only lists what your role can do, and right-clicking never
  disturbs a selection you are part-way through building.

  On a touch screen the same menu opens on a **long press**, with a short
  buzz where the device supports one. Lifting your finger afterwards does not
  also open the row, a quick tap still opens it as before, and starting to
  scroll cancels the press rather than opening a menu you did not ask for.

- **Quick actions on Library cards** (#5). Every series card and row has an
  actions menu, reached from the **⋯ button** that appears on hover, a
  right-click, or a long press. Issues carry the same button, on the poster
  card and at the end of a list row. It carries the library-management actions that
  previously meant opening the series first: **Scan folder**, **Edit
  metadata**, **Rename files** and **Fix match** (or **Match to ComicVine** for
  a series that has none yet).

- **Characters and credited names are links.** Click a character, team or
  creator in the issue modal for every other issue in your collection that
  features or credits them, owned copies first, each row carrying the role it
  was credited for. Both sources are searched — ComicVine's arrays and
  Metron's — so an issue found only through enrichment still turns up.
  Restricted series stay hidden unless you can see them. Credits are good
  coverage for anything whose metadata has been downloaded; character listings
  are thin, because the sources record them for a minority of issues and mostly
  recent ones, so an empty result says which of the two you are looking at
  rather than implying your collection has none. The list is complete, not
  capped — the busiest creator here has 843 credits — and only the rows near
  the viewport are rendered, so a long one stays quick.

  Those results group by series. Each heading sticks as you scroll and carries
  the years it spans and how much of it you own — green when the run is
  complete, amber when it is partial. A series with more than two dozen hits
  stays collapsed behind a summary of its consecutive runs ("130 issues ·
  #208-250, #400-443"), so coverage reads without opening it, and expands into
  a grid of issue numbers — one cell each, filled where you own the issue —
  with a switch to rows or covers that pages thirty at a time. Above the
  groups: totals for issues, series, owned and years; a chip per credited role
  for a creator; and a filter, an owned-only toggle, a sort (biggest series or
  most recent) and a list/cover switch that all work on what is already
  loaded.

- **Add whole series to a reading list from the Library** (#9). Select mode's
  bulk bar gains **Add to list**, which puts every issue of every selected
  series on a list in one step, in the order the Library is showing them and by
  issue number within each series. A run that ComicVine splits across several
  volumes is now a few picks rather than a trip through each series page, and
  the list's own reordering handles the rest. The dialog says how many issues
  that will be before you commit, and a selected series with no ComicVine
  issues to contribute is reported rather than silently skipped.

- **Find and clear failed adds** (#8). A **Nothing downloaded** filter lists
  every series with no file to its name, which is what a mass-add leaves behind
  when the downloads fail. The bulk bar also gains **Select all**, so clearing
  them is filter, select, Remove. On a list longer than one page the button
  says how many are loaded rather than pretending to select the rest.

- **Assign a file to an issue by hand.** On a series page, each file the app
  could not match to an issue now has an *Assign to issue* picker: choose
  the issue and the file links to it at once. The choice is remembered per
  file, so rescans, re-matches and metadata refreshes keep it (a re-match to
  a different volume drops it). For files whose number the app cannot read,
  or reads wrongly, without renaming or retagging anything. A file that
  linked to the wrong issue can be moved from that issue's own file list
  (open the issue, *Move to another issue…*), and a hand assignment undone
  there too.

- **Date formats for file naming.** The `{date}` token in a file pattern still
  writes "November 2011", but it now takes a modifier for the parts on their
  own: `{date:m}` the two-digit month, `{date:y}` the year, `{date:mon}` the
  short month name. So `{series} V{year} #{issue} ({date:m}-{date:y})` files as
  `Batman V2011 #001 (11-2011).cbz`. The month keeps its leading zero, so March
  is `03` and sorts with the rest of the year. Existing patterns are unchanged,
  an unrecognised modifier falls back to the full form, and an issue with no
  cover date drops the whole bracket rather than leaving `(-)` behind.

- **Characters, teams, locations and story arcs are written into your files.**
  They are standard `ComicInfo.xml` elements that every other reader and
  library server reads, and they were never written — even though the data
  was already cached. They are there now, along with page count. ComicVine
  supplies them where it has them, which is about 6% of issues and almost
  nothing before 1980 because they are hand-tagged there; Metron fills the
  rest. Existing files need a re-tag to pick them up.

- **Everything Metron publishes is kept.** Alongside the prices, barcodes and
  ratings already stored, an issue now carries its characters, teams, arcs,
  universes, per-role credits, description, title, page count, imprint,
  publisher and Metron and Grand Comics Database ids.

- **Unwrap nested archives** (Tools). Repairs the files the check above finds:
  the inner archive's pages are lifted to the top level, in place, with the
  wrapper's ComicInfo carried across when the inner one has none. It refuses
  anything it cannot prove — more than one archive inside, or an unwrapped
  result with no pages — and never replaces a file until the replacement has
  been read back and found to contain pages.


### Changed

- **Reading lists are runs now.** A list's page is built around where you are
  in it rather than what share of it you own. Its issues sit on one spine with
  a node each: the rail is filled to the point you have reached and grey after
  it, read issues are ticked and dimmed, and exactly one issue is promoted as
  **Read next** with its own cover and button. **Continue** at the top opens
  that issue. An issue you do not own is drawn as a gap, labelled with its
  position in the run, and the spine stops at it instead of filling through it,
  though Continue still skips ahead to the next issue you can actually read.
  The header counts reads, in-progress issues and missing ones, keeping
  ownership as a separate, separately labelled number. The index gives every
  list a tick per issue and a status (New, a read count, or Done), and pins a
  **Continue** card for the run you read most recently that still has somewhere
  to go. Without the reader installed a list shows ownership and order exactly
  as before, and makes no claim about what has been read.

- **The issue details modal is two columns.** It was one long scroll: cover,
  dates, two rows of buttons, then five stacked sections of dot-joined text.
  Now the cover carries a status chip and every action stacks beneath it, so
  the actions never scroll away, and the content is four tabs with counts —
  Overview, Credits, Appearing, Files — where the count tells you whether a
  tab is worth opening. The primary action follows the state: Read for an
  owned issue, **Replace corrupt file** in red for a damaged one, Download
  when there is nothing on disk. Credits group by role rather than listing a
  row per person, characters and teams and arcs are chips with a working
  "+N more" instead of a dead-end count, and each file gets a card with its
  folder, one state flag and the move-to-issue control inside it. Previous
  and next issue buttons in the header step through the run without going
  back to the series page, keeping the tab you were reading. Editing keeps
  the same layout, and every edited field now shows the amber "edited" mark,
  not just the three that used to.

- **Enrichment is on by default.** It was an opt-in toggle, so most libraries
  were getting no Metron data at all — and since characters and story arcs
  now go into `ComicInfo.xml`, that meant files written without fields every
  other reader expects. Existing installs are switched on once; turn it off
  again and it stays off. The hosted service caches the enrichment, so it
  costs no extra upstream call, and the official ComicVine API ignores the
  request.


### Fixed

- **A very long reading list no longer bogs the page down.** Lists can now be
  built in a couple of clicks, and a single series can carry thousands of
  issues, so the list page renders only the rows near the viewport past 200
  items, the way a long series page already did. A 4,239-issue list went from
  134,000 elements on the page to 3,000, first paint from 2.5s to 1s, and
  scrolling about five times quicker.

- **A comic with nothing in it to read is a problem now.** Some releases ship a
  `.cbz` that holds a `.cbr` instead of pages. It is a perfectly good zip, its
  ComicInfo reads, and it counted as owned, tagged and healthy — because
  nothing ever asked whether there was anything to read. Any comic archive with
  no pages is now flagged, naming what is inside when the cause is a nested
  archive, so it turns up under Problems instead of sitting in the library
  looking fine. Empty and truncated archives are caught by the same check.
  Books are unaffected: an EPUB with no image in it is still a good EPUB.

- **A download that is a wrapper is straightened out on the way in.** The import
  step sniffed the magic bytes, saw a zip and filed it — so a release packaged
  as a `.cbz` around a `.cbr` was written to the library exactly as the source
  shipped it. It is now unwrapped before anything reaches disk, and a zip with
  no pages that cannot be unwrapped is refused outright, the way an
  unrecognisable container already was.

- **AVIF pages count as pages.** The reader renders them; core's page test did
  not list them, so an AVIF comic would have been called pageless by the check
  above. The two tests now agree. macOS resource forks (`__MACOSX`, `._*`) no
  longer count as pages either, so an archive of nothing but junk reads as
  empty rather than full.

- Files named "Series (Year) Volume 01 Issue 002" read the volume number as
  the issue number, so every file in the folder landed as issue 1 and the
  rest showed as missing. An explicit issue marker ("Issue 002", "No. 12",
  "Issue #3") now names the issue outright, and a volume marker ("Volume
  01", "Vol. 3", "v2") is never mistaken for one — unless it is the only
  number in the name, as on a trade.

- **Adding a series now takes you to it** (#4). After a successful add the
  button showed the outcome ("Added — 12 queued") but was dead, leaving no way
  to reach the new series without closing the dialog and hunting for it. It now
  opens the series, keeping the outcome as its label. The neighbouring **"In
  library" button was broken too**, in a worse way: it pointed at a path that
  has never been a route, so the one button meant to work landed on Page not
  found. Both now go to the same place.

- The Library's **sort is remembered** (#6). It was carried in the URL, so it
  survived Back, a reload and the series page's Library button, but any trip
  through the sidebar built a fresh URL and dropped it, putting you back at
  A–Z. The choice is now kept as a preference and reapplied whenever you arrive
  without one, including from a sidebar library and in a new session. A sort
  named in the URL still wins, so a shared or bookmarked link is unchanged.

- **Add to reading list was unusable with more than a few lists.** The choices
  were laid out as one unwrapping row of footer buttons inside a 440px dialog,
  so with a dozen lists most of them sat off the side of the screen, with
  nothing to scroll and no way to reach them. A long set of choices now stacks
  into a scrollable list. Dialogs are also capped at the height of the screen
  and scroll their body, so no dialog can run off the edge again.

- **A metadata server without enrichment is no longer asked on every access.**
  Enrichment was re-requested whenever an issue had detail but no recorded
  answer — and a server that does not support it (the official ComicVine API
  ignores the parameter) never sends one, so the issue's detail was re-fetched
  on every single access, forever, against the user's own rate limit. Asking
  and getting nothing is now recorded as the miss it is.

- An issue poster card with several plugin actions pushed the last of its hover
  buttons outside the card, where they could not be clicked. The row of buttons
  now wraps.

- A matched series' row carried no file count internally, unlike every other
  kind of row. Nothing user-visible depended on it until now, but any check for
  "does this series have files" read it as none.

## [0.8.4] - 2026-09-14

### Added

- **Books and audiobooks from your download sources.** A plugin can now ask
  the app to download a book or audiobook (`api.downloadMedia`) and the same
  sources that serve comics go looking: usenet and torrent search the book
  and audiobook categories with a matcher built for how book releases are
  named (author and title, no issue number; the right kind of file), and a
  site source takes part when its definition declares `types: ['ebook']` or
  `['audiobook']`. The plugin that owns the library type files the result
  (`api.registerMediaHandler`) and whoever asked is told when it lands
  (`api.onMediaDownload`). The Requests plugin uses this to fill approved
  book requests. A book with an ISBN is asked for by ISBN first on catalog
  sites, so the exact edition wins over a look-alike. A site source may
  `verify` what it downloaded and refuse it (an EPUB whose own metadata
  says it is a translation, say); the next-best candidate is tried.
- **Sites behind DDoS-Guard.** Its interstitial is recognised as a challenge,
  a FlareSolverr "solve" that hands back the interstitial (the manual captcha
  it escalates headless browsers to) is reported as one rather than parsed
  as a page, and once the app's own browser clears a site, its cookies are
  reused for plain requests to it. A site source can mark a setting
  `secret: true` to have it masked on its card.

- **Books and audiobooks show in the queue.** A book being searched for,
  downloaded by a site source, or fetched by a download client is a row on
  the Queue page with its source and progress, counts toward the sidebar
  badge, and can be cancelled while a client has it. The log says which
  source was searched, what release was picked, and what was filed.
- **Add finds books and audiobooks.** With a Books or Audiobooks library
  (and its plugin), the Add button gains a tab for it: search the catalog,
  see what is already on the shelf, add one and the download sources are
  asked for it.

### Fixed

- One browser per process: a site source that needs the browser now shares
  the one a plugin already launched instead of starting a second Chromium
  on the same profile, which Chromium refuses ("Opening in existing browser
  session").

## [0.8.3] - 2026-09-09

### Added

- Reading lists now report how many volumes they span and the first few covers,
  so a list is recognisable before you open it.
- Filling a reading list's gaps can target specific issues instead of every
  unowned one in the list.

## [0.8.2] - 2026-09-08

### Fixed

- **A collected edition no longer arrives in place of a single issue.** A trade
  or omnibus numbers its volume where an issue numbers itself, so a request for
  issue 12 could be answered with volume 12 of a collection — a much larger
  file, filed under that issue and marked done, so the real issue was never
  fetched again. A release that announces itself as a collection is now refused
  when the series being downloaded is not itself a collected run. Collections
  still match their own releases, a series whose name carries an edition word
  is unaffected, and a manual search still lists everything so you can choose.

### Changed

- **Download sites are managed together, apart from plugins.** A site the app
  can download from is no longer a plugin of its own: sites live in a
  `sources/` folder, all of them maintained in one place, and appear under
  **Download sites** on the Plugins page with a link to their settings. The
  plugin list stays about plugins as the number of sites grows. A site whose
  code has to live elsewhere can still be a plugin, and when a plugin offers a
  site that is already installed, the installed one is used and the log says
  which plugin was ignored.

- **A source is only searched for the library types it serves.** A comics site
  is no longer asked for a manga chapter, and a manga site is no longer asked
  for a western comic, so a manual search stops waiting on requests that could
  never match. Sources that carry anything, such as the indexer-backed ones,
  are unaffected.

### Added

- **One FlareSolverr setting for every source.** The service that gets past
  Cloudflare is something you run, not a property of any one site, so it now
  lives once in **Settings → Downloading** instead of being asked for by each
  source. An address already set on a source is carried over automatically,
  and still wins for that source if you keep it.
- **Sources say whether they need the browser build.** The app ships in two
  builds, and the lean one has no browser at all. A source now declares what
  it needs, and the app always takes the cheapest route that works: plain
  HTTP, then FlareSolverr, and the built-in browser only as a last resort. A
  source that genuinely cannot work without a browser stays switched off on
  the lean build and says so on its settings card, instead of failing every
  download it is handed.
- **A toolkit for download-site sources.** A plugin now describes a site in a
  few dozen lines — how to search it and where a result's file or page images
  are — and the app supplies the rest: browser-like HTTP with Cloudflare
  handling (FlareSolverr when configured), per-site request pacing, the
  shared release matcher, archive checking and CBR-to-CBZ conversion, page
  image assembly into a CBZ or PDF, and a settings card with a Test button
  that the Settings page renders by itself. Manga and manhwa sites, whose
  chapters are lists of page images, are a first-class shape.

### Fixed

- **The event-loop watchdog now actually restarts a wedged server in Docker.**
  The app ran as the container's first process, and the kernel ignores a
  process's own kill signal in that position, so the watchdog's restart was
  silently a no-op (a stalled production server survived it for an hour).
  The official images now start under `tini`, which also reaps the
  health-check probes that piled up as zombie processes during a stall. A
  server that still finds itself as PID 1 logs a warning saying how to fix it.

## [0.8.1] — 2026-09-08

### Added

- **Diagnostics from the mobile apps.** A phone signed in to the server can
  send its own diagnostics report (device, app build, connection and
  playback failures) through the server, which wraps it into a support
  package and returns a code. An admin's phone sends the full package; any
  other user's phone sends a lite one with no settings, folders, indexers or
  server log.
- **Send to support.** Next to the download, "Send to BackIssue support"
  uploads the same package to the hosted service, authenticated with the
  install's own metadata key, and shows a short code to quote in the
  report. The package is kept for 60 days and only the BackIssue team can
  open it. An optional note travels with it.
- **Support package.** System → Tools → Getting help downloads one zip to
  attach to a bug report: version and build, runtime and host, disk and
  database size, settings with every key, password and token redacted,
  installed plugins, libraries, jobs and schedules, queued and failed
  downloads, recent history and the last two thousand log entries with
  secrets blanked. No comics, user names or e-mail addresses are included.

### Fixed

- **Memory no longer climbs after cover and page resizing.** Freed image
  buffers stayed resident in glibc's allocator; on a large library the
  server sat at 4 GB after a few bursts of cover renders. The Docker images
  now run the app with jemalloc, which returns that memory, and fall back
  to a two-arena malloc where it is missing. Child processes are not
  preloaded.

### Fixed

- **One collection load on reload, not two.** The web app requested the
  first library page and the chip counts twice at boot.

### Fixed

- **Mobile library filters answer in milliseconds, not seconds.** The
  unpaginated collection list the mobile apps use mapped every series row,
  including the whole on-demand ebook and audiobook catalogs, before
  dropping the non-comic rows. On a large library that cost about four
  seconds per filter change. The exclusion now happens in the query.

### Fixed

- **A frozen server restarts itself.** If the main thread stops responding
  for two minutes, or the heap sits at V8's limit for a minute and a half,
  a watchdog thread kills the process so Docker's restart policy brings up
  a fresh one, instead of the site silently timing out for hours. Memory
  use is logged every ten minutes so a leak leaves a trend in the log.
  `BACKISSUE_WATCHDOG=0` turns it off. The browser image now carries the
  same health check as the standard one.

## [0.8.0] — 2026-09-05

### Fixed

- **The Add button is always on screen.** The library toolbar scrolled
  sideways with a hidden scrollbar, and Add sat at its far end — off-screen at
  every desktop width, 1920 included. The filter chips now scroll on their
  own, with the clipped edge fading out (and a mouse wheel scrolls them), while
  sort, view, Select, Match and Add stay put. On phones the actions get their
  own row.
- **Every sideways strip says when there is more.** Wanted stats and chips,
  plugin categories, settings tabs, queue bands and release filters fade at
  the edge that has more content instead of cutting a word in half.
- **Adding a series finds the run you mean.** Search results are ranked:
  closest name first, then the familiar publishers and the ones already in
  your library, newer and longer runs ahead of older and shorter ones.
  "Batman" now leads with the current DC runs instead of translated reprints.
- **The weekly release notice no longer repeats after a restart.** It is
  deduped against the notification already stored for that week.
- **A missing series says so.** A deleted or mistyped series link shows
  "This series isn't in your library" with a way back, instead of a header of
  placeholders and "is the app running?". Unknown URLs get a proper
  not-found page, and a page your account can't open explains that rather
  than silently showing Home.
- **The browser tab names the page** ("Wanted · BackIssue", the series
  title on a series page), so history and tabs make sense.
- Phones: release rows keep their download button on screen; settings source
  cards wrap their descriptions; the Wanted skip button and checkboxes are
  finger-sized; the home page no longer tells you to use a sidebar you
  can't see.
- Dates on the Releases page read as local short dates ("ships Sep 9") and
  the last check as "checked 5m ago". Stats names the built-in metadata
  service instead of claiming a ComicVine key.
- The sign-in error is a sentence. A failed library load in Settings is
  reported instead of swallowed. Viewers no longer trigger forbidden
  admin-only requests at start-up.

### Changed

- **No more web fonts.** The app linked Google Fonts that its own Content
  Security Policy blocked, so every install rendered the fallback fonts
  anyway and logged an error on each page. The link is gone and the system
  font stacks are now the design.

- **Installing, updating or removing a plugin now says it needs a restart.**
  The Plugins page only showed a passing toast, and its restart banner never
  appeared for those actions (it only tracked enable/disable), so on Docker,
  with no console to watch, the new or updated plugin silently stayed
  inactive. The banner now names what is waiting ("Updated Reader to
  1.4.0 — restart to apply") with the Restart now button, survives leaving
  the page, and the catalog reflects what is on disk rather than what the
  running process loaded.
- **Collected editions never auto-downloaded.** Automatic search for a trade,
  hardcover or omnibus appended an issue-style number ("Series TPB 001") that
  no release carries, so it always came up empty while a manual search found it.
  Collections are now searched by name (plus "v02"-style for later volumes) and
  a numberless release is accepted for the first volume. Regular runs are
  unchanged. Manual search, and download sources that build on the shared
  search helpers, follow the same rules.

- Official images now carry a signed release attestation that the hosted
  metadata service uses to recognise genuine BackIssue builds. Nothing to
  configure and nothing changes for users; builds from source keep working
  on the service's standard tier.

## [0.7.95] — 2026-09-05

### Added

- **Releases, richer.** Collected editions (trades, hardcovers, omnibuses) are
  hidden by default behind a **Collections** chip; rows show the ship date,
  cover date, series start year and volume; a release the feed couldn't place
  on ComicVine gets a **Find** button that opens Add pre-filled with its name
  and year; downloading a brand-new issue refreshes the series on its own
  first. The weekly release notice names the first few issues, and a series
  page shows **Next: #N · date** from this week's and next week's lists.

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
