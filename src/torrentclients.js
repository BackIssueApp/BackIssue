// Torrent-client abstraction (qBittorrent, Transmission, Deluge) for the
// deferred torrent source. Same interface the usenet clients expose so the
// download monitor treats both uniformly:
//   add(link, { name, category }) -> infohash
//   status(hash) -> { state, progress, name, path }   (state: downloading|done|failed)
//   listByCategory(category) -> [{ id, name, state, progress, path }]
//   remove(hash, { deleteFiles })
// `path` is the content path as the CLIENT sees it; mapped to a locally-readable
// path via torrentCompleteDir/torrentCompleteDirRemote (shared by all clients).
import { magnetInfohash, torrentInfohash } from './torrenthash.js';
import { remapClientPath } from './paths.js';

function baseUrl(host, port, ssl) {
  const raw = String(host || '').trim();
  if (!raw) return '';
  const h = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const scheme = ssl ? 'https' : 'http';
  const hasPort = /:\d+$/.test(h);
  return `${scheme}://${h}${hasPort || !port ? '' : ':' + port}`;
}

export function qbBaseUrl(config) {
  return baseUrl(config.qbHost, config.qbPort, config.qbSsl);
}
export function trBaseUrl(config) {
  return baseUrl(config.trHost, config.trPort, config.trSsl);
}
export function delugeBaseUrl(config) {
  return baseUrl(config.delugeHost, config.delugePort, config.delugeSsl);
}

// The host field that gates the torrent source, per selected client — "is a
// download client configured at all?".
export function torrentClientHost(config) {
  const kind = (config.torrentClient || 'qbittorrent').toLowerCase();
  if (kind === 'transmission') return config.trHost;
  if (kind === 'deluge') return config.delugeHost;
  return config.qbHost;
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

// Follow an indexer link to its final form: a magnet URI or the .torrent bytes.
// Indexer proxy links (Jackett/Prowlarr "download" URLs, common on private
// trackers) often REDIRECT — sometimes to a magnet:, which fetch cannot
// follow. Walk redirects manually so a magnet target takes the magnet path,
// and reuse the final response's bytes (never fetch a hit-counted private-
// tracker download link twice). Returns { magnet } or { buf }.
async function fetchTorrentLink(link, fetchImpl) {
  let url = String(link);
  let tres = null;
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
  if (url.startsWith('magnet:')) return { magnet: url };
  if (!tres) tres = await fetchImpl(url, { headers: { 'User-Agent': 'comic-metadata-client/1.0' } });
  if (!tres.ok) throw new Error(`fetching .torrent failed: HTTP ${tres.status}`);
  return { buf: Buffer.from(await tres.arrayBuffer()) };
}

// Last-resort infohash when a client's add response doesn't include one
// (Transmission without hashString, Deluge returning null on a duplicate):
// derive it from the link the same way the qBittorrent path does. Costs an
// extra fetch for .torrent URLs, so it only runs when the client kept the
// hash to itself.
async function infohashFromLink(link, fetchImpl) {
  const t = await fetchTorrentLink(link, fetchImpl);
  const hash = t.magnet ? magnetInfohash(t.magnet) : torrentInfohash(t.buf);
  if (!hash) throw new Error('could not derive an infohash from the link');
  return hash.toLowerCase();
}

// Pull a session cookie out of a login response as a full "name=value" pair.
// qB 5.x names it QBT_SID_<port>, older versions SID (preferred when present);
// Deluge's web UI uses _session_id (caught by the first-cookie fallback).
// Returns the exact pair to echo back in the Cookie header, or null.
function sessionCookie(res) {
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
    cookie = sessionCookie(res) || cookie; // may stay null if auth is bypassed
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
      const t = await fetchTorrentLink(link, fetchImpl);
      if (t.magnet) {
        hash = magnetInfohash(t.magnet);
        if (!hash) throw new Error('could not read infohash from magnet');
        form.set('urls', t.magnet);
      } else {
        // .torrent bytes: hash them ourselves so the id we track matches exactly
        // what we hand qBittorrent.
        hash = torrentInfohash(t.buf);
        if (!hash) throw new Error('could not compute infohash from .torrent');
        form.set('torrents', new Blob([t.buf], { type: 'application/x-bittorrent' }), (name || hash) + '.torrent');
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

// ---- Transmission ----------------------------------------------------------
// One RPC endpoint over HTTP; auth is HTTP Basic, CSRF is the
// X-Transmission-Session-Id handshake: any request may come back 409 with a
// fresh id to echo on the retry.

const TR_FIELDS = ['id', 'hashString', 'name', 'percentDone', 'status', 'downloadDir', 'errorString', 'error', 'labels', 'trackerStats'];

// Best seeder count any tracker reports for the torrent (parity with qB's
// swarm seeders), -1 when unknown.
function trSeeders(t) {
  let max = -1;
  for (const ts of t.trackerStats || []) {
    const n = Number(ts.seederCount);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

// percentDone is 0..1; content is complete at 1 even while seeding. Unlike
// qBittorrent, downloadDir does NOT include the torrent itself — append name.
function mapTrState(t, config) {
  const base = { name: t.name, seeders: trSeeders(t) };
  if (Number(t.error) !== 0) return { ...base, state: 'failed', progress: 0, path: null, error: t.errorString || 'error' };
  if ((Number(t.percentDone) || 0) >= 1) return { ...base, state: 'done', progress: 100, path: mapPath(`${t.downloadDir}/${t.name}`, config) };
  return { ...base, state: 'downloading', progress: Math.round((Number(t.percentDone) || 0) * 100), path: null };
}

export function makeTransmissionClient(config, { fetchImpl = fetch } = {}) {
  const base = trBaseUrl(config);
  if (!base) throw new Error('Transmission host is not configured');
  const url = `${base}/transmission/rpc`;
  let sessionId = null; // CSRF token from the 409 handshake, cached across calls

  // One RPC call, handshaking on the first use and re-handshaking on any later
  // 409 (Transmission rotates the session id whenever it restarts).
  async function rpc(method, args = {}, { retry = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (sessionId) headers['X-Transmission-Session-Id'] = sessionId;
    if (config.trUser) headers.Authorization = 'Basic ' + Buffer.from(`${config.trUser}:${config.trPass || ''}`).toString('base64');
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ method, arguments: args }) });
    if (res.status === 409 && retry) { sessionId = res.headers.get('x-transmission-session-id'); return rpc(method, args, { retry: false }); }
    if (res.status === 401) throw new Error('Transmission authentication failed — check the username/password');
    if (!res.ok) throw new Error(`Transmission HTTP ${res.status}`);
    const j = await res.json();
    if (j.result !== 'success') throw new Error(`Transmission: ${j.result}`);
    return j.arguments || {};
  }

  return {
    async add(link, { name, category } = {}) {
      // Transmission fetches magnet/http links itself — no need to resolve
      // the link locally like the qBittorrent path does.
      const a = await rpc('torrent-add', { filename: String(link) });
      const t = a['torrent-added'] || a['torrent-duplicate'];
      if (!t) throw new Error('Transmission rejected the torrent');
      // Category = a label (Transmission 4.x / RPC 16+). Older RPCs reject the
      // field, and labels are only used to scope listByCategory — so a failure
      // just skips them.
      if (category && t.id != null) await rpc('torrent-set', { ids: [t.id], labels: [category] }).catch(() => {});
      return t.hashString ? String(t.hashString).toLowerCase() : infohashFromLink(link, fetchImpl);
    },

    async status(hash) {
      const { torrents = [] } = await rpc('torrent-get', { ids: [hash], fields: TR_FIELDS });
      const t = torrents[0];
      if (!t) return { state: 'queued', progress: 0, name: null, path: null };
      return mapTrState(t, config);
    },

    // Labels only exist on RPC 16+ — a torrent without a labels array stays in
    // the list. The monitor matches by hash anyway, so over-listing is harmless.
    async listByCategory(category) {
      const { torrents = [] } = await rpc('torrent-get', { fields: TR_FIELDS });
      return torrents
        .filter((t) => !category || !Array.isArray(t.labels) || t.labels.includes(category))
        .map((t) => ({ id: String(t.hashString).toLowerCase(), ...mapTrState(t, config) }));
    },

    async remove(hash, { deleteFiles = false } = {}) {
      await rpc('torrent-remove', { ids: [hash], 'delete-local-data': !!deleteFiles }).catch(() => {});
    },
  };
}

// ---- Deluge ----------------------------------------------------------------
// The web UI is a JSON-RPC proxy in front of the daemon: log in with the web
// password (cookie session), make sure the UI is attached to a daemon, then
// call core.* methods. The password is the only credential Deluge's web UI has.

// `label` needs the Label plugin; when it's disabled the key is simply absent
// from the status dicts (Deluge ignores unknown keys rather than erroring).
const DELUGE_FIELDS = ['name', 'hash', 'progress', 'state', 'save_path', 'total_seeds', 'num_seeds', 'label'];

// Deluge progress is ALREADY 0-100. save_path (like Transmission's
// downloadDir) is the containing folder — append the torrent name.
function mapDelugeState(t, config) {
  const s = Number(t.total_seeds ?? t.num_seeds ?? -1);
  const base = { name: t.name, seeders: Number.isFinite(s) ? s : -1 };
  if (String(t.state) === 'Error') return { ...base, state: 'failed', progress: 0, path: null, error: 'Error' };
  if ((Number(t.progress) || 0) >= 100) return { ...base, state: 'done', progress: 100, path: mapPath(`${t.save_path}/${t.name}`, config) };
  return { ...base, state: 'downloading', progress: Math.round(Number(t.progress) || 0), path: null };
}

export function makeDelugeClient(config, { fetchImpl = fetch } = {}) {
  const base = delugeBaseUrl(config);
  if (!base) throw new Error('Deluge host is not configured');
  const url = `${base}/json`;
  let cookie = null;  // "_session_id=…" web-session cookie
  let ready = false;  // logged in + daemon connected
  let seq = 0;

  async function call(method, params = []) {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ method, params, id: ++seq }) });
    if (!res.ok) throw new Error(`Deluge HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`Deluge: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  }

  // Log in (capturing the session cookie) and make sure the web UI is attached
  // to a daemon — it can be up with no connection, e.g. right after a restart,
  // in which case core.* calls fail. Attach to the first known host.
  async function connect() {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'auth.login', params: [config.delugePass || ''], id: ++seq }) });
    if (!res.ok) throw new Error(`Deluge HTTP ${res.status}`);
    const j = await res.json().catch(() => ({}));
    if (j.error || j.result !== true) throw new Error('Deluge login failed — check the password');
    cookie = sessionCookie(res) || cookie;
    if (!(await call('web.connected'))) {
      const hosts = await call('web.get_hosts').catch(() => []);
      if (!Array.isArray(hosts) || !hosts.length) throw new Error('Deluge daemon not connected');
      await call('web.connect', [hosts[0][0]]); // [id, host, port, status]
    }
    ready = true;
  }

  // One call, connecting on first use and retrying once when the web session
  // expired (Deluge answers "Not authenticated" instead of an HTTP error).
  async function rpc(method, params = [], { retry = true } = {}) {
    if (!ready) await connect();
    try {
      return await call(method, params);
    } catch (e) {
      if (retry && /not authenticated/i.test(String(e?.message))) { ready = false; cookie = null; return rpc(method, params, { retry: false }); }
      throw e;
    }
  }

  return {
    async add(link, { name, category } = {}) {
      const u = String(link);
      const id = u.startsWith('magnet:')
        ? await rpc('core.add_torrent_magnet', [u, {}])
        : await rpc('core.add_torrent_url', [u, {}]);
      // Adding a duplicate returns null — derive the hash from the link instead.
      const hash = id ? String(id).toLowerCase() : await infohashFromLink(u, fetchImpl);
      // Category = a Label-plugin label (lowercase — Deluge requires it). All
      // best-effort: the plugin may not be enabled (RPC error → skip), and
      // "already exists" from label.add is the normal steady state.
      if (category) {
        const label = String(category).toLowerCase();
        await rpc('label.add', [label]).catch(() => {});
        await rpc('label.set_torrent', [hash, label]).catch(() => {});
      }
      return hash;
    },

    async status(hash) {
      const dict = await rpc('core.get_torrents_status', [{ id: [hash] }, DELUGE_FIELDS]);
      const t = dict?.[hash] || Object.values(dict || {})[0];
      if (!t) return { state: 'queued', progress: 0, name: null, path: null };
      return mapDelugeState(t, config);
    },

    // The Label plugin may be absent, so fetch everything and filter on the
    // `label` field only when a torrent carries one — the monitor matches by
    // hash anyway, so over-listing unlabeled torrents is harmless.
    async listByCategory(category) {
      const dict = await rpc('core.get_torrents_status', [{}, DELUGE_FIELDS]);
      const want = String(category || '').toLowerCase();
      return Object.entries(dict || {})
        .filter(([, t]) => !want || t.label == null || String(t.label) === want)
        .map(([id, t]) => ({ id: String(id).toLowerCase(), ...mapDelugeState(t, config) }));
    },

    async remove(hash, { deleteFiles = false } = {}) {
      await rpc('core.remove_torrent', [hash, !!deleteFiles]).catch(() => {});
    },
  };
}

// Ping qBittorrent without adding anything (the "Test connection" button). Walks
// the auth steps explicitly so a 403 says WHERE it failed and what to change.
async function testQb(config, { fetchImpl = fetch } = {}) {
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
    const cookie = sessionCookie(lres);
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

// Ping Transmission without adding anything: one session-get through the 409
// handshake proves the URL, the credentials, and the CSRF flow all work.
async function testTransmission(config, { fetchImpl = fetch } = {}) {
  const base = trBaseUrl(config);
  if (!base) return { ok: false, message: 'A Transmission host is required.' };
  try {
    const url = `${base}/transmission/rpc`;
    const headers = { 'Content-Type': 'application/json' };
    if (config.trUser) headers.Authorization = 'Basic ' + Buffer.from(`${config.trUser}:${config.trPass || ''}`).toString('base64');
    const body = JSON.stringify({ method: 'session-get' });
    let res;
    try { res = await fetchImpl(url, { method: 'POST', headers, body }); }
    catch (e) { return { ok: false, message: `Connection failed: ${e.message}` }; }
    if (res.status === 409) {
      const sid = res.headers.get('x-transmission-session-id');
      if (!sid) return { ok: false, message: '409 without a session id — is this the Transmission RPC URL?' };
      res = await fetchImpl(url, { method: 'POST', headers: { ...headers, 'X-Transmission-Session-Id': sid }, body });
    }
    if (res.status === 401) return { ok: false, message: 'Authentication failed — check the username/password.' };
    if (!res.ok) return { ok: false, message: `HTTP ${res.status} — check the host/port and HTTPS setting.` };
    let j; try { j = await res.json(); } catch { return { ok: false, message: 'Response was not JSON — is this the Transmission RPC URL?' }; }
    if (j.result !== 'success') return { ok: false, message: `Transmission error: ${j.result}` };
    const a = j.arguments || {};
    if (!a.version) return { ok: true, message: 'Connected to Transmission.' };
    return { ok: true, message: `Connected to Transmission ${a.version}${a['rpc-version'] ? ` (RPC ${a['rpc-version']})` : ''}.` };
  } catch (e) {
    return { ok: false, message: `Connection failed: ${e.message}` };
  }
}

// Ping Deluge without adding anything: log in, make sure a daemon is attached
// (connecting to the first known host if not), and read the daemon version
// where the API offers one — older web UIs don't, and that's fine.
async function testDeluge(config, { fetchImpl = fetch } = {}) {
  const base = delugeBaseUrl(config);
  if (!base) return { ok: false, message: 'A Deluge host is required.' };
  try {
    const url = `${base}/json`;
    let seq = 0;
    let cookie = null;
    const call = async (method, params = []) => {
      const headers = { 'Content-Type': 'application/json' };
      if (cookie) headers.Cookie = cookie;
      const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ method, params, id: ++seq }) });
      if (!res.ok) throw new Error(`HTTP ${res.status} — check the host/port and HTTPS setting.`);
      let j; try { j = await res.json(); } catch { throw new Error('Response was not JSON — is this the Deluge web UI URL?'); }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      cookie = sessionCookie(res) || cookie;
      return j.result;
    };
    if ((await call('auth.login', [config.delugePass || ''])) !== true) {
      return { ok: false, message: 'Login failed — check the password.' };
    }
    if (!(await call('web.connected'))) {
      const hosts = await call('web.get_hosts').catch(() => []);
      if (Array.isArray(hosts) && hosts.length) await call('web.connect', [hosts[0][0]]).catch(() => {});
      if (!(await call('web.connected'))) {
        return { ok: false, message: 'Logged in, but the web UI has no Deluge daemon connected — start deluged and attach it under Connection Manager.' };
      }
    }
    const version = await call('daemon.get_version').catch(() => call('daemon.info').catch(() => null));
    return { ok: true, message: version ? `Connected to Deluge ${version}.` : 'Connected to Deluge.' };
  } catch (e) {
    return { ok: false, message: `Connection failed: ${e.message}` };
  }
}

// Ping the configured torrent client without adding anything (the "Test
// connection" button) — dispatches on torrentClient like makeTorrentClient.
export async function testTorrentClient(config, deps = {}) {
  const kind = (config.torrentClient || 'qbittorrent').toLowerCase();
  if (kind === 'transmission') return testTransmission(config, deps);
  if (kind === 'deluge') return testDeluge(config, deps);
  return testQb(config, deps);
}

// Parity with makeNzbClient: pick a torrent client by kind.
export function makeTorrentClient(config, deps = {}) {
  const kind = (config.torrentClient || 'qbittorrent').toLowerCase();
  if (kind === 'qbittorrent') return makeQbClient(config, deps);
  if (kind === 'transmission') return makeTransmissionClient(config, deps);
  if (kind === 'deluge') return makeDelugeClient(config, deps);
  throw new Error(`unknown torrentClient: ${config.torrentClient}`);
}
