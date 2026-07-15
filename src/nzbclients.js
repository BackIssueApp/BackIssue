// Download-client abstraction for the deferred (usenet) source. Two backends —
// SABnzbd and NZBGet — behind a common interface:
//   add(nzbUrl, { name, category }) -> id           (opaque client job id)
//   status(id) -> { state, progress, name, path }   (state: queued|downloading|done|failed)
// `path` is the completed folder as the CLIENT sees it; the usenet source maps it
// onto a locally-readable path via usenetCompleteDir/usenetCompleteDirRemote.
import { remapClientPath } from './paths.js';

// Build the client's base URL from host + port (+ ssl). Falls back to a legacy
// nzbClientUrl if host isn't set, so pre-existing configs keep working.
export function clientBaseUrl(config) {
  const raw = String(config.nzbClientHost || '').trim();
  if (!raw) return (config.nzbClientUrl || '').replace(/\/+$/, '');
  const host = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const scheme = config.nzbClientSsl ? 'https' : 'http';
  const hasPort = /:\d+$/.test(host);
  const port = config.nzbClientPort;
  return `${scheme}://${host}${hasPort || !port ? '' : ':' + port}`;
}

function normalizeStorage(storage, config) {
  return remapClientPath(storage, config.usenetCompleteDirRemote, config.usenetCompleteDir);
}

// ---- SABnzbd -------------------------------------------------------------
// JSON API at <url>/api keyed by apikey. addurl returns nzo_ids; queue/history
// report progress and the final storage path.
function sabnzbd(config, { fetchImpl = fetch } = {}) {
  const base = clientBaseUrl(config);
  const key = config.nzbClientApiKey || '';
  const call = async (params) => {
    const p = new URLSearchParams({ output: 'json', apikey: key, ...params });
    const res = await fetchImpl(`${base}/api?${p.toString()}`);
    if (!res.ok) throw new Error(`sabnzbd HTTP ${res.status}`);
    return res.json();
  };
  return {
    async add(nzbUrl, { name, category } = {}) {
      const params = { mode: 'addurl', name: nzbUrl };
      if (category) params.cat = category;
      if (name) params.nzbname = name;
      const j = await call(params);
      const id = j?.nzo_ids?.[0];
      if (!id) throw new Error(`sabnzbd rejected the NZB: ${JSON.stringify(j)}`);
      return id;
    },
    async status(id) {
      const q = await call({ mode: 'queue' });
      const slot = q?.queue?.slots?.find((s) => s.nzo_id === id);
      if (slot) {
        const pct = Number(slot.percentage) || 0;
        return { state: 'downloading', progress: pct, name: slot.filename, path: null };
      }
      const h = await call({ mode: 'history' });
      const hs = h?.history?.slots?.find((s) => s.nzo_id === id);
      if (hs) return sabHistoryState(hs, config);
      return { state: 'queued', progress: 0, name: null, path: null };
    },
    // All downloads in a category, keyed by id — queue (in progress) + history
    // (finished). Used by the background monitor to reconcile our category.
    async listByCategory(category) {
      const out = new Map();
      const q = await call({ mode: 'queue' });
      for (const s of q?.queue?.slots || []) {
        if (category && s.cat !== category) continue;
        out.set(s.nzo_id, { id: s.nzo_id, name: s.filename, state: 'downloading', progress: Number(s.percentage) || 0, path: null });
      }
      const h = await call({ mode: 'history' });
      for (const s of h?.history?.slots || []) {
        if (category && s.category !== category) continue;
        if (!out.has(s.nzo_id)) out.set(s.nzo_id, { id: s.nzo_id, ...sabHistoryState(s, config) });
      }
      return [...out.values()];
    },
    async remove(id, { deleteFiles = true } = {}) {
      const del_files = deleteFiles ? 1 : 0;
      // A completed download lives in HISTORY, so the queue delete is a harmless
      // no-op then (best-effort). The history delete is what actually removes the
      // finished files — SAB answers HTTP 200 with {status:false} when it refuses,
      // so check it and throw rather than silently leaving the files behind.
      await call({ mode: 'queue', name: 'delete', value: id, del_files }).catch(() => {});
      const r = await call({ mode: 'history', name: 'delete', value: id, del_files });
      if (r && r.status === false) throw new Error(`SABnzbd refused history delete for ${id}: ${r.error || JSON.stringify(r)}`);
      return r;
    },
  };
}

function sabHistoryState(hs, config) {
  const st = String(hs.status || '').toLowerCase();
  if (st === 'completed') return { state: 'done', progress: 100, name: hs.name, path: normalizeStorage(hs.storage, config) };
  if (st === 'failed') return { state: 'failed', progress: 0, name: hs.name, path: null, error: hs.fail_message };
  return { state: 'downloading', progress: 100, name: hs.name, path: null };
}

// ---- NZBGet --------------------------------------------------------------
// JSON-RPC at <url>/jsonrpc, HTTP basic auth. append() (v16+) accepts a URL as
// its content; listgroups + history report progress and the DestDir path.
function nzbget(config, { fetchImpl = fetch } = {}) {
  const base = clientBaseUrl(config);
  const headers = { 'Content-Type': 'application/json' };
  if (config.nzbClientUser) {
    const auth = Buffer.from(`${config.nzbClientUser}:${config.nzbClientPass || ''}`).toString('base64');
    headers.Authorization = `Basic ${auth}`;
  }
  const rpc = async (method, params = []) => {
    const res = await fetchImpl(`${base}/jsonrpc`, { method: 'POST', headers, body: JSON.stringify({ method, params, id: 1 }) });
    if (!res.ok) throw new Error(`nzbget HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`nzbget: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  };
  return {
    async add(nzbUrl, { name, category } = {}) {
      // append(NZBFilename, Content(url), Category, Priority, AddToTop, AddPaused,
      //        DupeKey, DupeScore, DupeMode, PPParameters[]) — the trailing
      // PPParameters array is required; omitting it fails with "Invalid parameter".
      const nzbId = await rpc('append', [name ? `${name}.nzb` : '', nzbUrl, category || '', 0, false, false, '', 0, 'SCORE', []]);
      if (!nzbId || nzbId <= 0) throw new Error(`nzbget rejected the NZB (result ${nzbId})`);
      return nzbId;
    },
    async status(id) {
      const groups = await rpc('listgroups', [0]);
      const g = Array.isArray(groups) ? groups.find((x) => x.NZBID === id) : null;
      if (g) {
        const total = Number(g.FileSizeMB) || 0;
        const remaining = Number(g.RemainingSizeMB) || 0;
        const progress = total > 0 ? Math.round(((total - remaining) / total) * 100) : 0;
        return { state: 'downloading', progress, name: g.NZBName, path: null };
      }
      const hist = await rpc('history', [false]);
      const h = Array.isArray(hist) ? hist.find((x) => x.NZBID === id) : null;
      if (h) return ngHistoryState(h, config);
      return { state: 'queued', progress: 0, name: null, path: null };
    },
    async listByCategory(category) {
      const out = new Map();
      const groups = await rpc('listgroups', [0]);
      for (const g of Array.isArray(groups) ? groups : []) {
        if (category && g.Category !== category) continue;
        const total = Number(g.FileSizeMB) || 0, remaining = Number(g.RemainingSizeMB) || 0;
        out.set(g.NZBID, { id: g.NZBID, name: g.NZBName, state: 'downloading', progress: total > 0 ? Math.round(((total - remaining) / total) * 100) : 0, path: null });
      }
      const hist = await rpc('history', [false]);
      for (const h of Array.isArray(hist) ? hist : []) {
        if (category && h.Category !== category) continue;
        if (!out.has(h.NZBID)) out.set(h.NZBID, { id: h.NZBID, ...ngHistoryState(h, config) });
      }
      return [...out.values()];
    },
    async remove(id, { deleteFiles = true } = {}) {
      // editqueue(Command, Offset, EditText, IDs) — HistoryFinalDelete also removes files.
      await rpc('editqueue', [deleteFiles ? 'HistoryFinalDelete' : 'HistoryDelete', 0, '', [id]]).catch(() => {});
    },
  };
}

function ngHistoryState(h, config) {
  const status = String(h.Status || '');
  if (status.startsWith('SUCCESS')) return { state: 'done', progress: 100, name: h.NZBName, path: normalizeStorage(h.DestDir, config) };
  if (status.startsWith('FAILURE') || status.startsWith('DELETED')) return { state: 'failed', progress: 0, name: h.NZBName, path: null, error: status };
  return { state: 'downloading', progress: 100, name: h.NZBName, path: null };
}

// Ping the configured download client without grabbing anything (used by the
// "Test connection" button). One authenticated call per client validates the URL
// AND the credentials, and reports the version on success.
export async function testClient(config, { fetchImpl = fetch } = {}) {
  const kind = (config.nzbClient || 'sabnzbd').toLowerCase();
  const base = clientBaseUrl(config);
  if (!base) return { ok: false, message: 'A client host is required.' };
  try {
    if (kind === 'sabnzbd') {
      // mode=queue requires the API key, so it doubles as an auth check.
      const key = config.nzbClientApiKey || '';
      const res = await fetchImpl(`${base}/api?mode=queue&limit=0&output=json&apikey=${encodeURIComponent(key)}`);
      if (!res.ok) return { ok: false, message: `HTTP ${res.status} — check the URL.` };
      let j; try { j = await res.json(); } catch { return { ok: false, message: 'Response was not JSON — is this the SABnzbd URL?' }; }
      if (j.status === false || j.error) return { ok: false, message: `SABnzbd rejected the request${j.error ? `: ${j.error}` : ' (check the API key).'}` };
      const version = j?.queue?.version;
      return { ok: true, message: version ? `Connected to SABnzbd ${version}.` : 'Connected to SABnzbd.' };
    }
    if (kind === 'nzbget') {
      const headers = { 'Content-Type': 'application/json' };
      if (config.nzbClientUser) headers.Authorization = 'Basic ' + Buffer.from(`${config.nzbClientUser}:${config.nzbClientPass || ''}`).toString('base64');
      const res = await fetchImpl(`${base}/jsonrpc`, { method: 'POST', headers, body: JSON.stringify({ method: 'version', params: [], id: 1 }) });
      if (res.status === 401) return { ok: false, message: 'Authentication failed — check the username/password.' };
      if (!res.ok) return { ok: false, message: `HTTP ${res.status} — check the URL.` };
      let j; try { j = await res.json(); } catch { return { ok: false, message: 'Response was not JSON — is this the NZBGet URL?' }; }
      if (j.error) return { ok: false, message: `NZBGet error: ${j.error.message || JSON.stringify(j.error)}` };
      return { ok: true, message: `Connected to NZBGet ${j.result || ''}`.trim() + '.' };
    }
    return { ok: false, message: `Unknown client: ${config.nzbClient}` };
  } catch (e) {
    return { ok: false, message: `Connection failed: ${e.message}` };
  }
}

export function makeNzbClient(config, deps = {}) {
  const kind = (config.nzbClient || 'sabnzbd').toLowerCase();
  if (kind === 'nzbget') return nzbget(config, deps);
  if (kind === 'sabnzbd') return sabnzbd(config, deps);
  throw new Error(`unknown nzbClient: ${config.nzbClient}`);
}

export { normalizeStorage };
