// HTTP for site sources — the part every download site plugin used to carry
// on its own. One implementation, shared:
//   • realistic browser headers and a per-session cookie/UA pair;
//   • Cloudflare: a cached per-host clearance (cookie + the UA it is bound
//     to), FlareSolverr when a URL is configured, a clear error otherwise;
//   • per-host pacing, so no source can hammer a site into banning the
//     instance's IP (that has happened);
//   • an SSRF guard — every URL here ultimately comes from a web page or a
//     user's search result, so internal addresses are refused;
//   • streaming downloads with byte progress, manual redirect hopping with
//     per-host cookies (a download button often lands on a file host with its
//     own Cloudflare gate), and an optional egress proxy for the file hop.
import { request, Agent, ProxyAgent, interceptors } from 'undici';
import { setTimeout as sleep } from 'node:timers/promises';

const redirectDispatcher = new Agent().compose(interceptors.redirect({ maxRedirections: 5 }));

// A current, realistic desktop Firefox UA. When FlareSolverr solves a challenge
// its cf_clearance cookie is bound to the UA it used, so follow-up requests
// adopt whatever UA it reports.
export const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0';

/** Refuse loopback, private, link-local and metadata addresses. Domain names
 *  pass (these are public comic hosts); a literal internal IP does not.
 *  BACKISSUE_ALLOW_INTERNAL_FETCH=1 lifts it for tests against a local server. */
export function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`refusing non-http(s) URL: ${u.protocol}`);
  if (process.env.BACKISSUE_ALLOW_INTERNAL_FETCH === '1') return u;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const bad = host === 'localhost' || host.endsWith('.localhost')
    || /^127\./.test(host) || host === '0.0.0.0' || host === '::1' || host === '::'
    || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^169\.254\./.test(host) || /^fe80:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host);
  if (bad) throw new Error(`refusing to fetch an internal address: ${host}`);
  return u;
}

export function looksChallenged(html, status) {
  if (/just a moment|challenge-platform|cf-browser-verification|_cf_chl/i.test(html || '')) return true;
  if (status !== 403 && status !== 503) return false;
  // A 403 is not automatically Cloudflare: a site's own API answers 403 with
  // JSON when a request is missing something. Calling that "a challenge" sends
  // people to configure FlareSolverr for a problem it cannot fix.
  const body = String(html || '').trim();
  return !(body.startsWith('{') || body.startsWith('['));
}

// ---- per-host pacing --------------------------------------------------------
// Every request through this module to the same host waits until `gapMs` has
// passed since the previous one started. Sources declare their gap; the
// strictest gap any caller asked for wins for that host.
const hostGap = new Map();   // host → ms
const hostChain = new Map(); // host → promise of the last scheduled slot
const hostLast = new Map();  // host → timestamp the last request was released

export function setHostGap(host, gapMs) {
  const g = Math.max(0, Number(gapMs) || 0);
  if (g > (hostGap.get(host) || 0)) hostGap.set(host, g);
}

/** Wait for this host's slot. Resolves when the caller may send. */
export async function pace(host, gapMs = null) {
  if (gapMs != null) setHostGap(host, gapMs);
  const gap = hostGap.get(host) || 0;
  const prev = hostChain.get(host) || Promise.resolve();
  const mine = prev.then(async () => {
    const wait = (hostLast.get(host) || 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    hostLast.set(host, Date.now());
  });
  hostChain.set(host, mine.catch(() => {}));
  await mine;
}

/** Test hook: forget every host's pacing state. */
export function resetPacing() { hostGap.clear(); hostChain.clear(); hostLast.clear(); }

// ---- Cloudflare clearance cache ---------------------------------------------
// A cf_clearance cookie stays valid a while (typically 15-30 min) and a fresh
// solve costs ~20 s of Cloudflare's own timer, so the win is NOT re-solving:
// cache each host's clearance and reuse it across every source and download.
const CLEARANCE_TTL_MS = 15 * 60 * 1000;
const clearanceJar = new Map(); // host → { cookieHeader, ua, ts }
function clearanceGet(host) {
  const e = clearanceJar.get(host);
  if (e && Date.now() - e.ts < CLEARANCE_TTL_MS) return e;
  if (e) clearanceJar.delete(host);
  return null;
}
function clearanceSet(host, cookieHeader, ua) {
  if (cookieHeader) clearanceJar.set(host, { cookieHeader, ua, ts: Date.now() });
}

/** Solve/fetch a Cloudflare-gated page via FlareSolverr → { html, cookieHeader, ua, status }. */
export async function viaFlareSolverr(flareUrl, url) {
  // FlareSolverr v3 lives at /v1 — tolerate the URL given with or without it
  // (without it the service answers 405 and nothing explains why).
  const endpoint = /\/v1\/?$/.test(flareUrl) ? flareUrl : flareUrl.replace(/\/+$/, '') + '/v1';
  // A solve runs Cloudflare's own timer, so the wait is long by nature: give
  // the request more headroom than the solve itself, and say plainly when the
  // service never answered — otherwise this surfaces as a bare
  // "Headers Timeout Error" that reads like the site's fault, not the helper's.
  const maxTimeout = 60000;
  let data;
  try {
    const res = await request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url, maxTimeout }),
      headersTimeout: maxTimeout + 30000,
      bodyTimeout: maxTimeout + 30000,
    });
    data = await res.body.json();
  } catch (e) {
    throw Object.assign(new Error(`FlareSolverr at ${endpoint} did not answer within ${(maxTimeout + 30000) / 1000}s (${e?.message || e}) — check the service is running and reachable`), { flaresolverr: true });
  }
  if (data.status !== 'ok' || !data.solution) throw new Error('FlareSolverr: ' + (data.message || 'no solution'));
  const sol = data.solution;
  const cookieHeader = (sol.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
  return { html: sol.response || '', cookieHeader, ua: sol.userAgent || DEFAULT_UA, status: sol.status || 200 };
}

async function viaDirect(url, { cookieHeader = '', ua = DEFAULT_UA, headers = {}, method = 'GET', body = undefined, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } = {}) {
  const res = await request(url, {
    method,
    body,
    dispatcher: redirectDispatcher,
    headers: {
      'user-agent': ua,
      accept,
      'accept-language': 'en-US,en;q=0.9',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...headers,
    },
  });
  const html = await res.body.text();
  return { html, cookieHeader, ua, status: res.statusCode, headers: res.headers };
}

/**
 * Fetch an HTML page, solving Cloudflare when needed. `session` (a plain
 * object the caller keeps) carries cookies/UA between calls so one solve
 * serves a whole find → fetch flow. `flareUrl` is the FlareSolverr endpoint
 * ('' = try direct). `rateMs` paces requests to the host.
 */
export async function fetchHtml(url, { flareUrl = '', session = {}, headers = {}, rateMs = null, settingsHint = 'Settings → Sources' } = {}) {
  assertPublicUrl(url);
  const host = new URL(url).host;
  await pace(host, rateMs);

  // A fresh clearance for this host is honoured by a plain request too (the
  // solving browser's UA is reused), so a repeat page skips FlareSolverr.
  const cached = clearanceGet(host);
  if (cached) {
    const r = await viaDirect(url, { cookieHeader: cached.cookieHeader, ua: cached.ua, headers });
    if (!looksChallenged(r.html, r.status)) {
      session.cookieHeader = cached.cookieHeader;
      session.ua = cached.ua;
      return r.html;
    }
    clearanceJar.delete(host); // stale — solve again below
  }

  if (flareUrl) {
    const r = await viaFlareSolverr(flareUrl, url);
    session.cookieHeader = r.cookieHeader;
    session.ua = r.ua;
    clearanceSet(host, r.cookieHeader, r.ua);
    return r.html;
  }
  const r = await viaDirect(url, { ...session, headers });
  if (looksChallenged(r.html, r.status)) {
    throw Object.assign(new Error(`Cloudflare challenge on ${host} — set a FlareSolverr URL in ${settingsHint} to get past it.`), { challenged: true, status: r.status });
  }
  if (r.status >= 400) throw Object.assign(new Error(`HTTP ${r.status} from ${host}`), { status: r.status });
  return r.html;
}

/**
 * Fetch a JSON API endpoint (GET, or POST with a JSON body). Paced per host,
 * browser-like headers, session cookies. Throws with `.status` on a non-2xx.
 */
export async function fetchJson(url, { method = 'GET', body = undefined, headers = {}, session = {}, rateMs = null } = {}) {
  assertPublicUrl(url);
  const host = new URL(url).host;
  await pace(host, rateMs);
  const r = await viaDirect(url, {
    ...session, method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    accept: 'application/json, text/plain, */*',
  });
  if (r.status >= 400) {
    throw Object.assign(new Error(`HTTP ${r.status} from ${host}${looksChallenged(r.html, r.status) ? ' (Cloudflare challenge)' : ''}`), { status: r.status, body: r.html });
  }
  try { return JSON.parse(r.html); } catch { throw new Error(`${host} answered with something other than JSON`); }
}

// Plain (non-redirecting) dispatchers for downloads — the hop loop below follows
// redirects itself. An optional egress proxy routes ONLY the file download
// through another IP (some file hosts block datacenter ranges with a 403 while
// the site itself works). One dispatcher per proxy URL.
const plainAgent = new Agent();
const plainProxyDispatchers = new Map();
function plainDispatcher(proxyUrl) {
  if (!proxyUrl) return plainAgent;
  let d = plainProxyDispatchers.get(proxyUrl);
  if (!d) { d = new ProxyAgent(proxyUrl); plainProxyDispatchers.set(proxyUrl, d); }
  return d;
}

/**
 * Stream a file to a Buffer → { buffer, filename, contentType }. Redirects are
 * followed manually with per-host cookies; a hop that answers a Cloudflare
 * challenge is solved for THAT host (once) when FlareSolverr is available.
 * onProgress({ done, total, bps }) is throttled to ~5/s; onStage(name, host)
 * announces the slow pre-stream stages ('solving').
 */
export async function downloadToBuffer(url, {
  referer = '', headers = {}, session = {}, maxBytes = 2 * 1024 * 1024 * 1024,
  onProgress = null, onStage = null, proxyUrl = '', flareUrl = '', rateMs = null,
} = {}) {
  assertPublicUrl(url);
  const stage = (name, host) => { try { onStage?.(name, host); } catch { /* best-effort */ } };
  const hostCookies = session.hostCookies || (session.hostCookies = {});
  if (session.cookieHeader) hostCookies[new URL(url).host] ||= session.cookieHeader;

  let res = null;
  const solved = new Set();
  for (let hop = 0; hop < 8; hop++) {
    const curHost = new URL(url).host;
    if (!hostCookies[curHost]) {
      const c = clearanceGet(curHost);
      if (c) { hostCookies[curHost] = c.cookieHeader; session.ua = session.ua || c.ua; }
    }
    await pace(curHost, hop === 0 ? rateMs : null);
    res = await request(url, {
      method: 'GET',
      dispatcher: plainDispatcher(proxyUrl),
      headers: {
        'user-agent': session.ua || DEFAULT_UA,
        accept: '*/*',
        ...(referer ? { referer } : {}),
        ...(hostCookies[curHost] ? { cookie: hostCookies[curHost] } : {}),
        ...headers,
      },
    });
    const loc = res.headers.location;
    if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
      await res.body.dump();
      url = new URL(Array.isArray(loc) ? loc[0] : loc, url).href;
      assertPublicUrl(url);
      continue;
    }
    if (res.statusCode >= 400) {
      const host = new URL(url).host;
      const body = await res.body.text().catch(() => '');
      if (flareUrl && !solved.has(host) && looksChallenged(body, 0)) {
        clearanceJar.delete(host);
        solved.add(host);
        stage('solving', host);
        const r = await viaFlareSolverr(flareUrl, new URL(url).origin + '/');
        hostCookies[host] = r.cookieHeader;
        session.ua = r.ua;
        clearanceSet(host, r.cookieHeader, r.ua);
        continue;
      }
      throw Object.assign(new Error('download HTTP ' + res.statusCode), { status: res.statusCode, challenged: looksChallenged(body, res.statusCode) });
    }
    break;
  }
  if (!res || res.statusCode >= 300) throw new Error('download failed: too many redirects');
  const cd = res.headers['content-disposition'] || '';
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(Array.isArray(cd) ? cd[0] : cd);
  const filename = m ? decodeURIComponent(m[1].replace(/"/g, '').trim()) : null;
  const ct = res.headers['content-type'];
  const contentType = String(Array.isArray(ct) ? ct[0] : ct || '').split(';')[0].trim() || null;
  const total = Number(res.headers['content-length']) || 0;

  const chunks = [];
  let done = 0;
  let winStart = null, winBytes = 0, bps = 0, lastEmit = 0;
  const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
  for await (const chunk of res.body) {
    done += chunk.length;
    if (done > maxBytes) throw new Error('file exceeds size cap (' + Math.round(maxBytes / 1024 / 1024) + 'MB)');
    chunks.push(chunk);
    if (!onProgress) continue;
    const t = nowMs();
    if (winStart === null) winStart = t;
    winBytes += chunk.length;
    const elapsed = t - winStart;
    if (elapsed >= 1000) { bps = Math.round((winBytes / elapsed) * 1000); winStart = t; winBytes = 0; }
    if (t - lastEmit >= 200) { lastEmit = t; onProgress({ done, total, bps }); }
  }
  if (onProgress) onProgress({ done, total: total || done, bps });
  return { buffer: Buffer.concat(chunks), filename, contentType };
}
