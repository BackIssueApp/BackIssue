# BackIssue

**A self-hosted library manager for your comic collection — track the comics you
want, download new issues automatically as they release, tag them with metadata,
and keep everything organized on disk.**

ComicVine is the source of truth for every comic's identity (name, publisher,
year, issue list, cover). Download **sources** are pluggable and interchangeable —
BackIssue ships with **Usenet** (Newznab indexers → SABnzbd/NZBGet), and more
can be added as plugins.

---

## Features

- **ComicVine-first collection** — add a volume by its ComicVine id/URL; issues,
  covers, and metadata come straight from ComicVine.
- **Automatic downloads** — queue missing issues; the download queue tries each
  enabled source in priority order and takes the first that can serve the issue.
- **Usenet source (built in)** — search multiple Newznab indexers, hand the NZB
  to SABnzbd or NZBGet, and import the finished file automatically as it lands
  (category monitoring).
- **Metadata tagging** — writes `ComicInfo.xml` into each CBZ from ComicVine data.
- **Library management** — import an existing on-disk library, match folders to
  ComicVine, detect owned/missing/corrupt/untagged issues per volume.
- **Library tools** — convert CBR→CBZ, verify archives, tag untagged files,
  remove duplicates, re-link to ComicVine, full-library scan.
- **Scheduled jobs** — release checks, ComicVine match sweeps, and any
  plugin-provided jobs (e.g. catalog crawls) on configurable intervals.
- **Persistent logs**, a background **Jobs** page, and a weekly **releases** feed.

## Requirements

- **Node.js 22+**
- A **ComicVine API key** (free — https://comicvine.gamespot.com/api/)
- Optional: **SABnzbd** or **NZBGet** + one or more **Newznab** indexers for the
  Usenet source.

## Quick start

```bash
npm install
npm run build          # build the web UI (Svelte → frontend/dist)
npm start              # serves the UI on http://localhost:8787
```

Then open http://localhost:8787 → **Settings**:

1. Paste your **ComicVine key(s)** (Metadata section).
2. Set your **Root folders** (where comics live on disk).
3. Enable and configure a **download source** (Usenet: add indexers + your
   SABnzbd/NZBGet host).

Add a comic with **+ Add** (search ComicVine), then queue issues to download.

## Configuration

Settings are edited in the UI and persisted to `settings.json` (gitignored).
Everything also has a default in `src/config.js`. Data lives in `catalog.db`
(SQLite, gitignored).

## Docker

The published image is `ghcr.io/backissueapp/backissue` — `latest` tracks
releases and the nightly build of main; version tags (e.g. `0.3.0`) pin a
release; `nightly` is last night's main. The easiest deployment is Docker
Compose — see
[`docker-compose.yml`](docker-compose.yml) for a commented example:

```bash
docker compose up -d
```

Or plain `docker run`:

```bash
docker run -d -p 8787:8787 \
  -e PUID=99 -e PGID=100 -e TZ=Europe/Dublin \
  -v /path/to/data:/data \
  -v /path/to/comics:/comics \
  ghcr.io/backissueapp/backissue:latest
```

`/data` holds the database, settings, and installed plugins; mount your comic
library at `/comics` (and point Settings → Library → Root folders at it).
`PUID`/`PGID`/`UMASK` control file ownership (defaults suit Unraid).

To build locally: `docker build -t backissue .`. A second image,
`Dockerfile.browser`, additionally runs a real (headed) Chromium under a
virtual display (Xvfb) — only needed by browser-based source plugins.

## Plugins

Additional download sources and their UI can be dropped in as plugins under
`plugins/<name>/` — the directory is optional and the app runs fully without it.
This is how private, non-distributable sources are kept separate from the core.
A plugin's `index.js` default-exports `register(api)` and wires itself through
the hook API (`registerSource`, `registerSettings`, `registerStartup`,
`registerRoute`, `registerJob`, `registerClientAsset`); core never imports from
`plugins/`.

## Development

```bash
npm test               # run the core test suite (node --test)
npm run test:ui        # run the frontend suite (Vitest, in frontend/)
npm run dev            # start the server with --watch
npm run dev:ui         # Vite dev server for the UI (HMR, proxies /api to :8787)
```

The web UI is a Svelte 5 single-page app in `frontend/` (Vite). In production
the server serves the built `frontend/dist`; during UI development run both
`npm run dev` and `npm run dev:ui` and open the Vite URL. After changing the UI,
`npm run build` refreshes what `npm start` serves.

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
