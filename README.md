# BackIssue

**A self-hosted library manager for your comic collection — track the series you
want, download new issues automatically as they release, tag them with
metadata, read them anywhere, and keep everything organized on disk.**

ComicVine is the source of truth for every comic's identity (name, publisher,
year, issue list, covers). Download **sources** are pluggable and
interchangeable — Usenet and torrents ship built in, and more install with one
click from the in-app plugin catalog.

**Documentation: [backissue.app](https://backissue.app)** · **Support & community: [Discord](https://discord.gg/T6GTgzz8t2)**

---

## Features

- **ComicVine-first collection** — add a volume from a ComicVine search; issues,
  covers, and metadata come straight from ComicVine. Import an existing on-disk
  library and it's matched up the same way.
- **Automatic downloads, four layers deep** — indexer **RSS watching** reacts to
  new uploads in minutes; a **new-releases search** hunts the current week and
  retries; a **wanted backfill** chews through back-catalog gaps nightly; and a
  weekly **release calendar** shows what shipped for the series you follow.
- **Sources in priority order** — Usenet (Newznab → SABnzbd/NZBGet), torrents
  (Torznab → qBittorrent), and plugin sources; every search tries them
  top-to-bottom and the first confident match wins. Multi-issue **packs** are
  matched issue-by-issue against your gaps — nothing you own is touched.
- **Metadata done right** — ComicVine data embedded into every file as
  `ComicInfo.xml`, CBR→CBZ conversion, and **configurable folder & file naming
  patterns** with tools to reorganize an existing library to match.
- **A full in-browser reader** (plugin) — paged, double-page, and webtoon modes,
  per-user progress and resume, bookmarks, reading shelves, reading lists,
  offline reading, and OPDS for native reader apps.
- **Multi-user** — accounts, roles, and fine-grained permissions; per-user
  reading history; requests with approval; optional SSO (OpenID Connect);
  mature-content restrictions enforced everywhere.
- **Self-maintaining** — scheduled jobs, library tools (verify, convert, tag,
  de-duplicate, reorganize), persistent logs, notifications (in-app bell +
  webhook), and live progress for everything.

## Install

All setup guides live on the docs site:

- **[Getting started](https://backissue.app/getting-started)** — Docker Compose
  (recommended), plain `docker run`, the Unraid template, or running from
  source, plus the first-run walkthrough.
- **[Download sources](https://backissue.app/sources)** — Usenet, torrents, and
  source priority.
- **[Automation](https://backissue.app/automation)** — schedules, RSS watching,
  and notifications.

The short version: the published image is
[`ghcr.io/backissueapp/backissue`](https://ghcr.io/backissueapp/backissue), and
[`docker-compose.yml`](docker-compose.yml) in this repo is a commented example —
`docker compose up -d`, open `http://localhost:8787`, and the first run walks
you through the rest.

## Plugins

The core stays lean; whole features ship as plugins installed from the in-app
catalog — the reader, OPDS, requests, discovery, SSO, and extra download
sources. See **[Plugins](https://backissue.app/plugins)** for the catalog and
the **[Plugin API reference](https://backissue.app/plugin-api)** if you want to
write one: a plugin is a folder with an `index.js` that default-exports
`register(api)`; core never imports from `plugins/`.

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
`settings.json`, data to `catalog.db` (SQLite) — both gitignored, with defaults
in `src/config.js`.

To build the image locally: `docker build -t backissue .`. A second image,
`Dockerfile.browser`, additionally runs a real (headed) Chromium under a
virtual display (Xvfb) — only needed by browser-based source plugins.

## AI disclosure

AI was used in the creation of this app, managed end-to-end by an experienced
engineer. Every feature is designed, reviewed, and tested under human
direction — AI is what lets a single engineer lead the charge and iterate at
the speed of a full team.

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
