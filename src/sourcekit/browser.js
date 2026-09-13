// The browser, as a last resort for sources.
//
// The app ships in two images. The lean one has no Chromium at all (its
// install drops the browser package), and it is the one most people run. So a
// source reaches for a browser only when a site genuinely cannot be reached
// any other way, and the order is always: plain HTTP → FlareSolverr (a
// separate container, so the app stays lean) → a real browser.
//
// A source declares its need with `browser: 'fallback' | 'required'`:
//   'fallback' — normal HTTP, and the browser only if the site challenges and
//                no FlareSolverr is configured. Runs fine on the lean image.
//   'required' — cannot work otherwise. On an image with no browser the source
//                is disabled and says why, instead of failing every download.
//
// One context is shared by every source that needs one: launching Chromium per
// source would multiply the memory that already dominates this container.
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);

let availability = null;
/** Is a browser installed in this image? Synchronous, so `isEnabled` can use it. */
export function browserAvailable() {
  if (availability === null) {
    try { require.resolve('patchright'); availability = true; }
    catch { availability = false; }
  }
  return availability;
}

/** Test hook: pretend the browser is (un)available. */
export function setBrowserAvailable(v) { availability = v === null ? null : !!v; }

let contextPromise = null;
/** The shared browser context, launched on first use. Never call this without
 *  checking `browserAvailable()` — on the lean image the import throws. */
export async function sharedContext() {
  if (!browserAvailable()) throw new Error('this source needs the browser image (the lean image ships no browser)');
  if (contextPromise) {
    // The context may have been closed by another holder (a plugin's crawler
    // restarting its browser) since it was cached — then it is no use to
    // anyone, and the next page must come from a fresh launch.
    const ctx = await contextPromise.catch(() => null);
    if (ctx && !ctx.__closed && isOpen(ctx)) return ctx;
    contextPromise = null;
  }
  contextPromise = (async () => {
    const { launchContext } = await import('../browser.js');
    return launchContext();
  })().catch((e) => { contextPromise = null; throw e; });
  return contextPromise;
}

function isOpen(ctx) {
  try { ctx.pages(); return ctx.browser() ? ctx.browser().isConnected() : true; }
  catch { return false; }
}

/** Close the shared context (app shutdown). */
export async function closeSharedBrowser() {
  const p = contextPromise;
  contextPromise = null;
  if (!p) return;
  try { const ctx = await p; await ctx.close(); } catch { /* already gone */ }
}

async function withPage(fn) {
  let ctx = await sharedContext();
  let page;
  try { page = await ctx.newPage(); }
  catch (e) {
    // The context can be dead without ever having said so — its window was
    // closed by hand, or the browser went away — and the only symptom is
    // that it will not open a page. Treat that as closed: drop it, launch
    // afresh, and try once more.
    if (!/closed|disconnected|Target/i.test(String(e?.message || e))) throw e;
    console.warn('browser: the shared context refused a new page — relaunching:', e?.stack || e?.message || e);
    ctx.__closed = true;
    contextPromise = null;
    try { await ctx.close(); } catch { /* already gone */ }
    ctx = await sharedContext();
    page = await ctx.newPage();
  }
  try { return await fn(page); }
  finally { try { await page.close(); } catch { /* ignore */ } }
}

/** A page's HTML, fetched by the real browser (challenges clear on their own). */
export async function browserHtml(url, { referer = '', waitMs = 0, waitFor = null } = {}) {
  const { gotoPolite, isChallenged, waitForChallengeClear } = await import('../browser.js');
  return withPage(async (page) => {
    if (referer) await page.setExtraHTTPHeaders({ referer });
    await gotoPolite(page, url);
    if (await isChallenged(page)) await waitForChallengeClear(page);
    if (waitFor) { try { await page.waitForSelector(waitFor, { timeout: 15000 }); } catch { /* return what loaded */ } }
    if (waitMs) await sleep(waitMs);
    return page.content();
  });
}

/** The cookies the browser holds for a host, plus its user agent — what a
 *  plain request needs to be honoured by a site the browser just cleared. */
export async function browserClearance(host) {
  const ctx = await sharedContext();
  const h = String(host || '').toLowerCase();
  const cookies = (await ctx.cookies()).filter((c) => {
    const d = String(c.domain || '').toLowerCase().replace(/^\./, '');
    return h === d || h.endsWith('.' + d);
  });
  if (!cookies.length) return null;
  const ua = await withPage((page) => page.evaluate(() => navigator.userAgent)).catch(() => '');
  return { cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '), ua };
}

/** One image's bytes, read through the browser — for hosts that serve images
 *  only to a real browser session. Falls back to reading the bytes in-page,
 *  which large images need (the inspector cache evicts them). */
export async function browserImage(url, { referer = '' } = {}) {
  return withPage(async (page) => {
    const resp = await page.goto(url, { referer: referer || undefined, waitUntil: 'commit' });
    if (!resp) throw new Error('no response (network error)');
    if (resp.status() !== 200) throw Object.assign(new Error(`HTTP ${resp.status()}`), { status: resp.status() });
    try { return await resp.body(); }
    catch (e) {
      if (!/evicted|inspector cache/i.test(String(e?.message))) throw e;
      const b64 = await page.evaluate(async () => {
        const r = await fetch(location.href, { cache: 'force-cache', credentials: 'include' });
        if (!r.ok) throw new Error('in-page fetch status ' + r.status);
        const bytes = new Uint8Array(await r.arrayBuffer());
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s);
      });
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) throw new Error('in-page fetch returned no bytes');
      return buf;
    }
  });
}
