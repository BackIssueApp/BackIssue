# Lean BackIssue image for distribution — no browser stack. A normal install
# (reader, opds, usenet/torrent sources, …) never needs Chromium/Xvfb; only a
# plugin that drives a real browser does, and none ship in the public catalog.
# For a browser-enabled deployment, build Dockerfile.browser (adds Chromium +
# Xvfb, ~1GB).
#
# Multi-stage: the build stage (full node image, has the toolchain) resolves
# production dependencies and builds the web UI; the runtime stage is a slim
# image carrying only node_modules, the server, and the built UI. This keeps
# the published image small (~150MB vs ~490MB for a single-stage full-image
# build) so pulls and updates are cheap.

# ---- build: production deps + web UI (needs the full image's compilers) ----
FROM node:22-bookworm AS build
WORKDIR /app

# Runtime deps only. --omit=optional drops patchright (browser automation) —
# the lean image has no Chromium, so it's dead weight here; the browser image
# and local dev keep it. better-sqlite3 compiles here if no prebuilt binary
# matches, then its native binding is copied into the slim runtime below (same
# Debian/glibc + arch, so the .node file is compatible).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --omit=optional

# Build the Svelte UI (→ frontend/dist, which the server serves). Drop the
# committed lockfile first: it may have been generated on another OS (e.g.
# Windows), and npm's optional-deps bug then skips this platform's native
# bundler binding (@rolldown/binding-*). See npm/cli#4828.
COPY frontend/package.json ./frontend/
RUN rm -f frontend/package-lock.json && npm --prefix frontend install
COPY frontend ./frontend
RUN npm --prefix frontend run build

# ---- runtime: slim image, only what the server needs at run time ----
FROM node:22-bookworm-slim AS runtime

# gosu lets the entrypoint drop from root to PUID:PGID (Unraid/LinuxServer).
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && gosu --version

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PLUGINS_DIR=/data/plugins

# Everything the server reads at runtime: prod deps, the server, its version
# (from package.json), the built UI, and the entrypoint. Plugins live on the
# mounted /data volume (PLUGINS_DIR), so none are baked in.
#
# Layers are ordered by how often they change, least-often first, so a routine
# code push republishes only the small tail layers and `docker pull` reports
# the fat ones as "Already exists": node_modules (changes only with the
# lockfile) → entrypoint → package.json (per release) → src (per commit) →
# dist (per build). The per-build ARG/ENV stamps live at the BOTTOM of this
# file: an ARG that changes every commit placed above these COPYs busts their
# cache and forces users to re-download the whole image on every update.
COPY --from=build /app/node_modules ./node_modules
# Normalize entrypoint line endings (repo may be checked out CRLF) + executable.
COPY docker ./docker
RUN sed -i 's/\r$//' docker/entrypoint.sh && chmod +x docker/entrypoint.sh
COPY package.json ./
COPY src ./src
COPY --from=build /app/frontend/dist ./frontend/dist

# Build provenance: release builds leave the defaults; dev/nightly builds pass
# BUILD_CHANNEL (+ commit sha) so the app reports e.g. "0.5.0-dev.a1b2c3d".
# Zero-byte config layers — declared last, see the layer-order note above.
ARG BUILD_CHANNEL=release
ARG BUILD_SHA=""
ENV BUILD_CHANNEL=$BUILD_CHANNEL
ENV BUILD_SHA=$BUILD_SHA

# Persisted data on the mounted volume: db, settings, downloads, tag staging,
# AND installed plugins — so catalog plugins survive image updates and are
# writable by the dropped-privilege user.
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "src/index.js"]
