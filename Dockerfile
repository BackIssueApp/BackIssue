# Lean BackIssue image for distribution — no browser stack. A normal install
# (reader, opds, usenet/torrent sources, …) never needs Chromium/Xvfb; only a
# plugin that drives a real browser does, and none ship in the public catalog.
# For a browser-enabled deployment, build Dockerfile.browser (adds Chromium +
# Xvfb, ~1GB).
FROM node:22-bookworm

# gosu lets the entrypoint drop from root to PUID:PGID (Unraid/LinuxServer).
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && gosu --version

WORKDIR /app

# Runtime deps only (layer caching: this only re-runs when the lockfile changes).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .
# Build the web UI (Svelte → frontend/dist, which the server serves), then prune
# the dev deps. Drop the committed lockfile first: it may have been generated on
# another OS (e.g. Windows), and npm's optional-deps bug then skips this
# platform's native bundler binding (@rolldown/binding-*). See npm/cli#4828.
RUN rm -f frontend/package-lock.json \
    && npm --prefix frontend install \
    && npm --prefix frontend run build \
    && rm -rf frontend/node_modules

# Normalize entrypoint line endings (repo may be checked out CRLF) + executable.
RUN sed -i 's/\r$//' /app/docker/entrypoint.sh && chmod +x /app/docker/entrypoint.sh

# Persisted data on the mounted volume: db, settings, downloads, browser
# profile, tag staging, AND installed plugins — so catalog plugins survive
# image updates and are writable by the dropped-privilege user.
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PLUGINS_DIR=/data/plugins
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "src/index.js"]
