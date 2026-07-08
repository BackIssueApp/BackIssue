import { chromium } from 'patchright';
import { setTimeout as sleep } from 'node:timers/promises';
import config from './config.js';

export async function launchContext() {
  // Patchright (a stealth-patched Playwright fork) drives the bundled Chromium
  // and closes the automation leaks anti-bot systems detect. Do NOT add manual
  // fingerprint patches here (webdriver overrides, automation flags): patchright
  // handles them, and redundant patches create detectable inconsistencies.
  //
  // IMPORTANT: sites behind Cloudflare hard-block TRUE headless Chromium — the
  // "Just a moment…" interstitial never clears (verified). A REAL browser (even
  // one parked off-screen) passes it in ~2s. So:
  //   'hidden'  — real window off-screen; the invisible-but-safe mode.
  //   'visible' — normal window (first-run login / debugging).
  //   'headless'— no window; works for non-Cloudflare use but Cloudflare blocks
  //               it. On a headless server run 'hidden' under a virtual display
  //               (e.g. `xvfb-run node src/index.js` on Linux).
  //
  // Why not spoof the UA to hide "HeadlessChrome" and keep headless? Because it's
  // WORSE: a UA inconsistent with the rest of the fingerprint is a stronger bot
  // signal that can escalate to an IP BAN (observed). This is why patchright
  // itself says never set a custom userAgent. Do not add one.
  const mode = config.windowMode;
  const args = [];
  if (mode === 'hidden') args.push('--window-position=-2400,-2400', '--window-size=1366,900');
  else if (mode !== 'headless') args.push('--start-maximized');
  // Extra flags for special environments (e.g. the Docker/Xvfb image adds
  // software-GL flags so WebGL works without a GPU — a browser with no WebGL is
  // itself a bot signal). Space-separated in CHROMIUM_EXTRA_ARGS.
  if (process.env.CHROMIUM_EXTRA_ARGS) args.push(...process.env.CHROMIUM_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  const ctx = await chromium.launchPersistentContext(config.profileDir, {
    headless: mode === 'headless',
    acceptDownloads: true,
    viewport: null,
    args,
  });

  // Abort known third-party telemetry/analytics that we never need. The
  // Cloudflare Web Analytics beacon is injected as a deferred script; if its
  // host can't be resolved (e.g. behind a VPN) the browser waits out the full
  // DNS timeout before firing DOMContentLoaded, stalling every navigation ~30s.
  await ctx.route(/(?:static\.cloudflareinsights\.com|cloudflareinsights\.com|\/cdn-cgi\/(?:rum|beacon))/i,
    (route) => route.abort());

  return ctx;
}

export async function newPage(context) {
  return context.newPage();
}

// Is this page currently sitting on a Cloudflare interstitial ("Just a
// moment…")? Checked by title, the challenge URL token, and the challenge
// script — any one is conclusive.
export async function isChallenged(page) {
  try {
    if (/(?:__cf_chl|cf_chl_)/i.test(page.url())) return true;
    const title = await page.title().catch(() => '');
    if (/just a moment|attention required|checking your browser|checking if the site/i.test(title)) return true;
    return await page.evaluate(() =>
      !!document.querySelector('#challenge-running, #cf-challenge-running, script[src*="challenge-platform"], #cf-please-wait')
    ).catch(() => false);
  } catch { return false; }
}

// Cloudflare's interstitial auto-solves in a real browser after a moment. Wait
// for it to clear (headed passes in ~2s); a stuck challenge means we're blocked
// (headless). Returns true once clear, false if still challenged at timeout.
export async function waitForChallengeClear(page, { timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isChallenged(page))) return true;
    await sleep(1500);
  }
  return !(await isChallenged(page));
}

export async function gotoPolite(page, url) {
  // Explicit timeout so a single slow/blocked page reliably fails instead of
  // hanging a worker forever (which would wedge the whole crawl pool).
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs || 45000 });
  // A real browser occasionally lands on a Cloudflare interstitial that clears
  // itself in a second or two; wait it out so the worker scrapes the real page,
  // not the challenge HTML.
  if (await isChallenged(page)) await waitForChallengeClear(page, { timeoutMs: config.navTimeoutMs || 45000 });
  await sleep(config.actionDelayMs);
}

// Wait for the logged-in indicator rather than sampling instantly: at
// domcontentloaded the target element may not be rendered yet, and Cloudflare's
// auto-clearing interstitial can still be mid-flight — an instant count()
// reports "not logged in" even when the session is perfectly valid.
export async function isLoggedIn(page, selector, { timeoutMs = 12000 } = {}) {
  if (!selector) return false;
  try {
    await page.locator(selector).first().waitFor({ state: 'attached', timeout: timeoutMs });
    return true;
  } catch {
    return (await page.locator(selector).count().catch(() => 0)) > 0;
  }
}

export async function closeContext(context) {
  await context.close();
}
