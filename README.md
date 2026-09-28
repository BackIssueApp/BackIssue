# BackIssue

**A self-hosted library manager for your comics. Track the series you want,
download new issues automatically as they release, tag them with metadata, read
them anywhere, and keep everything organized on disk. Manga, books and
audiobooks shelve alongside them, each with a reader or player of its own.**

Metadata works out of the box: a new install registers itself with the built-in
metadata service on first use, so there is no API key to obtain before you can
add anything. Point it at ComicVine directly with your own key instead if you
prefer. Either way ComicVine owns every comic's identity: name, publisher, year,
issue list, covers.

Download **sources** are pluggable and interchangeable. Usenet and torrents ship
built in, and individual download sites install with one click from the in-app
catalog.

**Documentation: [backissue.app](https://backissue.app)** · **Support & community: [Discord](https://discord.gg/T6GTgzz8t2)**

---

## Features

- **Matched collection, no setup.** Add a volume from a search and its issues,
  covers and metadata arrive with it. Import an existing on-disk library and it
  is matched the same way, with tools to fix anything that lands wrong, down to
  pinning a single stubborn file to the issue it belongs to.
- **Libraries by type.** Comics, manga, books and audiobooks each get their own
  root folders, naming patterns and tagging rules, so one server can hold very
  different collections without them interfering.
- **Automatic downloads, four layers deep.** Indexer **RSS watching** reacts to
  new uploads in minutes; a **new-releases search** hunts the current week and
  retries while an issue is still fresh; a **wanted backfill** chews through
  back-catalog gaps on a schedule; and a weekly **release calendar** shows what
  shipped for the series you follow.
- **Sources in priority order.** Usenet (Newznab, then SABnzbd or NZBGet),
  torrents (Torznab, then qBittorrent, Transmission or Deluge), Direct Connect,
  and the download sites you install. Every search tries them top to bottom and
  the first confident match wins. Series name and issue number are a gate rather
  than a score, so a near miss is never quietly accepted. Multi-issue **packs**
  are matched issue by issue against your gaps, and nothing you own is touched.
- **Monitoring that stays out of your way.** Follow a whole run, only issues
  from here on, or nothing at all, then cherry-pick or skip individual issues.
  The exceptions are stored as exceptions, so changing the policy later does
  what you expect.
- **Metadata done right.** Data embedded into every file as `ComicInfo.xml`, or
  written beside it as a sidecar to keep files byte-identical, CBR to CBZ
  conversion, and **configurable folder and file naming patterns** with tools to
  reorganize an existing library to match.
- **A full in-browser reader** (plugin). Paged, double-page and webtoon modes,
  guided panel-by-panel reading, per-user progress and resume, bookmarks,
  reading shelves, reading lists, and OPDS for native reader apps. It works
  offline for issues you have opened, and installs to a home screen.
- **Books and audiobooks** (plugins). Shelve EPUBs and audiobooks beside the
  comics, enriched from their own metadata sources, with an ebook reader that
  keeps highlights and notes and a player with chapters, speed and a sleep
  timer. Both can be filled from the same download sources the comics use.
- **Native apps for phone and tablet.** Companion apps for
  [Android](https://backissue.app/android) and
  [iPhone and iPad](https://backissue.app/ios) share the same account, download
  issues for offline reading, and sync progress with the web reader.
- **Multi-user.** Accounts, roles, and fine-grained permissions; per-user
  reading history; requests with approval and voting; optional SSO (OpenID
  Connect); mature-content restrictions enforced on every surface, including
  OPDS.
- **Self-maintaining.** Scheduled jobs, library tools (verify, convert, tag,
  de-duplicate, reorganize), a release blocklist that stops a broken upload
  being grabbed twice, persistent logs, statistics, notifications (an in-app
  bell, plus Discord, Telegram, Pushover, ntfy or a webhook via a plugin), and
  live progress for everything.

## Install

All setup guides live on the docs site:

- **[Getting started](https://backissue.app/getting-started)**: Docker Compose
  (recommended), plain `docker run`, the Unraid template, or running from
  source, plus the first-run walkthrough.
- **[Download sources](https://backissue.app/sources)**: Usenet, torrents, and
  source priority.
- **[Automation](https://backissue.app/automation)**: schedules, RSS watching,
  and notifications.
- **[Settings reference](https://backissue.app/settings-reference)**: every
  setting, plus the environment variables set where the app runs.

The short version: the published image is
[`ghcr.io/backissueapp/backissue`](https://ghcr.io/backissueapp/backissue), and
[`docker-compose.yml`](docker-compose.yml) in this repo is a commented example.
Run `docker compose up -d`, open `http://localhost:8787`, and the first run
walks you through the rest.

## Plugins

The core stays lean; whole features ship as plugins installed from the in-app
catalog: the reader, books, audiobooks, faceted shelves, OPDS, requests,
discovery, reading gamification, notification channels, a migration assistant
for an existing Mylar3 or Kapowarr collection, Prowlarr indexer import, and SSO.

Download **sites** are separate from plugins and install individually from their
own catalog, because a site is mostly a description of where to search and where
the file is rather than a feature.

See **[Plugins](https://backissue.app/plugins)** for the catalog and the
**[Plugin API reference](https://backissue.app/plugin-api)** if you want to
write one: a plugin is a folder with an `index.js` that default-exports
`register(api)`, and core never imports from `plugins/`.

## Development

```bash
npm install
npm test               # run the core test suite (node --test)
npm run test:ui        # run the frontend suite (Vitest, in frontend/)
npm run dev            # start the server with --watch
npm run dev:ui         # Vite dev server for the UI (HMR, proxies /api to :8787)
npm run up             # build the web UI, then start (http://localhost:8787)
```

The web UI is a Svelte 5 single-page app in `frontend/` (Vite). In production
the server serves the built `frontend/dist`; during UI development run both
`npm run dev` and `npm run dev:ui` and open the Vite URL. Settings persist to
`settings.json`, data to `catalog.db` (SQLite), both gitignored, with defaults
in `src/config.js`. `DATA_DIR` relocates all of it onto a mounted volume, which
is what the image does.

To build the image locally: `docker build -t backissue .`. A second image,
`Dockerfile.browser`, additionally runs a real (headed) Chromium under a
virtual display (Xvfb). Only the handful of sources that ask for it need that,
so the lean image is the one to run unless something says otherwise.

## AI disclosure

AI was used in the creation of this app, managed end-to-end by an experienced
engineer. Every feature is designed, reviewed, and tested under human direction.
AI is what lets a single engineer lead the charge and iterate at the speed of a
full team.

## License

BackIssue is free software, licensed under the
[GNU General Public License v3.0 or later](LICENSE). You may use, study, share,
and modify it; if you distribute it or a modified version, you must do so under
the same license and make the corresponding source available.

BackIssue is distributed WITHOUT ANY WARRANTY, to the extent permitted by law.

### Disclaimer

BackIssue is a tool for organizing and managing a comic library you are entitled
to. You alone are responsible for the sources you choose to configure and for
complying with the laws of your jurisdiction. The maintainers do not endorse or
facilitate copyright infringement.
