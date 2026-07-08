// Torrent-client abstraction (currently qBittorrent) for the deferred torrent
// source. Same interface the usenet clients expose so the download monitor treats
// both uniformly:
//   add(link, { name, category }) -> infohash
//   status(hash) -> { state, progress, name, path }   (state: downloading|done|failed)
//   listByCategory(category) -> [{ id, name, state, progress, path }]
//   remove(hash, { deleteFiles })
// `path` is the content path as the CLIENT sees it; mapped to a locally-readable
// path via torrentCompleteDir/torrentCompleteDirRemote.
import { magnetInfohash, torrentInfohash } from './torrenthash.js';
import { remapClientPath } from './paths.js';

export function qbBaseUrl(config) {
  const raw = String(config.qbHost || '').trim();
  if (!raw) return '';
  const host = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const scheme = config.qbSsl ? 'https' : 'http';
  const hasPort = /:\d+$/.test(host);
  return `${scheme}://${host}${hasPort || !config.qbPort ? '' : ':' + config.qbPort}`;
}

// Map a client-side content path onto the path this app can read over the network.
function mapPath(p, config) {
  return remapClientPath(p, config.torrentCompleteDirRemote, config.torrentCompleteDir);
}

// qB progress is 0..1; content is complete at 1 regardless of seeding state.
// num_complete = seeders in the swarm (fall back to connected seeds).
function mapState(t, config) {
  const s = Number(t.num_complete ?? t.num_seeds ?? -1);
  const base = { name: t.name, seeders: Number.isFinite(s) ? s : -1 };
  const state = String(t.state || '');
  if (/^(error|missingFiles)$/.test(state)) return { ...base, state: 'failed', progress: 0, path: null, error: state };
  if ((Number(t.progress) || 0) >= 1) return { ...base, state: 'done', progress: 100, path: mapPath(t.content_path || t.save_path, config) };
  return { ...base, state: 'downloading', progress: Math.round((Number(t.progress) || 0) * 100), path: null };
}

// Pull qBittorrent's session cookie out of a login response as a full
// "name=value" pair. qB 5.x names it QBT_SID_<port>; older versions use SID.
// Returns the exact pair to echo back in the Cookie header, or null.
function qbSessionCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  for (const c of raw) {
    if (!c) continue;
    const pair = c.split(';')[0].trim(); // "QBT_SID_8080=WGtx…"
    if (/^(QBT_SID_\d+|SID)=/i.test(pair)) return pair;
  }
  for (const c of raw) if (c) return c.split(';')[0].trim(); // fallback: first cookie
  return null;
}

export function makeQbClient(config, { fetchImpl = fetch } = {}) {
  const base = qbBaseUrl(config);
  if (!base) throw new Error('qBittorrent host is not configured');
  let cookie = null;   // full "name=value" session cookie
  let loggedIn = false;

  async function login() {
    const body = new URLSearchParams({ username: config.qbUser || '', password: config.qbPass || '' });
    // No Referer/Origin: qBittorrent's CSRF check only fires when they're present,
    // and behind a reverse proxy it compares against qB's internal host (not the
    // external domain), so sending them causes a 403. A server client sends neither.
    const res = await fetchImpl(`${base}/api/v2/auth/login`, {
      method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const text = await res.text().catch(() => '');
    if (!res.ok || text.trim() === 'Fails.') throw new Error('qBittorrent login failed — check host/username/password');
    cookie = qbSessionCookie(res) || cookie; // may stay null if auth is bypassed
    loggedIn = true;
  }

  // One request, logging in on first use and retrying once on a 403 (expired session).
  async function req(path, { method = 'GET', body, headers = {}, raw = false, retry = true } = {}) {
    if (!loggedIn) await login();
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    const res = await fetchImpl(`${base}${path}`, { method, body, headers: h });
    if (res.status === 403 && retry) { loggedIn = false; cookie = null; await login(); return req(path, { method, body, headers, raw, retry: false }); }
    if (res.status === 403) throw new Error('qBittorrent rejected the session (403) — disable "Enable Host header validation" in the Web UI (or whitelist this domain)');
    if (!res.ok) throw new Error(`qBittorrent HTTP ${res.status}`);
    return raw ? res : res.json();
  }

  const infoByHashes = (hashes) => req(`/api/v2/torrents/info?hashes=${hashes}`);

  return {
    async add(link, { name, category } = {}) {
      let hash;
      const form = new FormData();
      if (category) form.set('category', category);
      if (name) form.set('rename', name);
      let url = String(link);
      let tres = null;
      // Indexer proxy links (Jackett/Prowlarr "download" URLs, common on private
      // trackers) often REDIRECT — sometimes to a magnet:, which fetch cannot
      // follow. Walk redirects manually so a magnet target takes the magnet path,
      // and reuse the final response's bytes (never fetch a hit-counted private-
      // tracker download link twice).
      if (!url.startsWith('magnet:')) {
        for (let hop = 0; hop < 5; hop++) {
          tres = await fetchImpl(url, { redirect: 'manual', headers: { 'User-Agent': 'comic-metadata-client/1.0' } });
          if (tres.status < 300 || tres.status >= 400) break; // final response — use it
          const loc = tres.headers.get('location');
          if (!loc) break;
          if (loc.startsWith('magnet:')) { url = loc; tres = null; break; }
          url = new URL(loc, url).toString(); // relative Location resolves against the hop
          tres = null;
        }
      }
      if (url.startsWith('magnet:')) {
        hash = magnetInfohash(url);
        if (!hash) throw new Error('could not read infohash from magnet');
        form.set('urls', url);
      } else {
        // .torrent bytes: hash them ourselves so the id we track matches exactly
        // what we hand qBittorrent.
        if (!tres) tres = await fetchImpl(url, { headers: { 'User-Agent': 'comic-metadata-client/1.0' } });
        if (!tres.ok) throw new Error(`fetching .torrent failed: HTTP ${tres.status}`);
        const buf = Buffer.from(await tres.arrayBuffer());
        hash = torrentInfohash(buf);
        if (!hash) throw new Error('could not compute infohash from .torrent');
        form.set('torrents', new Blob([buf], { type: 'application/x-bittorrent' }), (name || hash) + '.torrent');
      }
      const res = await req('/api/v2/torrents/add', { method: 'POST', body: form, raw: true });
      const text = await res.text().catch(() => '');
      if (text.trim() === 'Fails.') throw new Error('qBittorrent rejected the torrent');
      return hash.toLowerCase();
    },

    async status(hash) {
      const list = await infoByHashes(hash);
      const t = Array.isArray(list) ? list[0] : null;
      if (!t) return { state: 'queued', progress: 0, name: null, path: null };
      return mapState(t, config);
    },

    async listByCategory(category) {
      const q = category ? `?category=${encodeURIComponent(category)}` : '';
      const list = await req(`/api/v2/torrents/info${q}`);
      return (Array.isArray(list) ? list : []).map((t) => ({ id: String(t.hash).toLowerCase(), ...mapState(t, config) }));
    },

    async remove(hash, { deleteFiles = false } = {}) {
      const body = new URLSearchParams({ hashes: hash, deleteFiles: deleteFiles ? 'true' : 'false' });
      await req('/api/v2/torrents/delete', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, raw: true }).catch(() => {});
    },
  };
}

// Ping qBittorrent without adding anything (the "Test connection" button). Walks
// the auth steps explicitly so a 403 says WHERE it failed and what to change.
export async function testTorrentClient(config, { fetchImpl = fetch } = {}) {
  const base = qbBaseUrl(config);
  if (!base) return { ok: false, message: 'A qBittorrent host is required.' };
  try {
    // 1. Log in.
    const body = new URLSearchParams({ username: config.qbUser || '', password: config.qbPass || '' });
    let lres;
    try { lres = await fetchImpl(`${base}/api/v2/auth/login`, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); }
    catch (e) { return { ok: false, message: `Connection failed: ${e.message}` }; }
    if (lres.status === 403) return { ok: false, message: '403 on login — the Web UI blocked the request. In qBittorrent → Web UI, disable "Enable Host header validation" (or add this domain to the whitelist).' };
    if (!lres.ok) return { ok: false, message: `Login HTTP ${lres.status} — check the host/port and HTTPS setting.` };
    const ltext = await lres.text().catch(() => '');
    if (ltext.trim() === 'Fails.') return { ok: false, message: 'Login failed — check the username and password.' };
    const cookie = qbSessionCookie(lres);
    // A redirect (http→https, added trailing slash) drops the Set-Cookie from the
    // pre-redirect response — the usual reason "no cookie came back".
    const redirected = !!lres.redirected || (lres.url && lres.url.replace(/\/$/, '') !== `${base}/api/v2/auth/login`.replace(/\/$/, ''));
    if (!cookie && redirected) {
      return { ok: false, message: `Login was redirected to ${lres.url || 'another URL'}, which drops the session cookie. Set the host to that final URL — usually it means enabling "Use HTTPS" (or fixing the port/host).` };
    }

    // 2. Hit an authed endpoint with the session cookie.
    const vres = await fetchImpl(`${base}/api/v2/app/version`, cookie ? { headers: { Cookie: cookie } } : {});
    if (vres.status === 403) {
      return {
        ok: false,
        message: cookie
          ? 'Logged in, but qBittorrent rejected the session (403). This is almost always "Enable Host header validation" in Web UI options — turn it off, or add this domain to the whitelist.'
          : 'Logged in, but no session cookie came back — either a reverse proxy is stripping the Set-Cookie header, or the login was redirected. Check the host URL (HTTPS?) and proxy config.',
      };
    }
    if (!vres.ok) return { ok: false, message: `HTTP ${vres.status} after login.` };
    const version = (await vres.text().catch(() => '')).trim();
    return { ok: true, message: version ? `Connected to qBittorrent ${version}.` : 'Connected to qBittorrent.' };
  } catch (e) {
    return { ok: false, message: `Connection failed: ${e.message}` };
  }
}

// Parity with makeNzbClient: pick a torrent client by kind (only qBittorrent today).
export function makeTorrentClient(config, deps = {}) {
  const kind = (config.torrentClient || 'qbittorrent').toLowerCase();
  if (kind === 'qbittorrent') return makeQbClient(config, deps);
  throw new Error(`unknown torrentClient: ${config.torrentClient}`);
}
