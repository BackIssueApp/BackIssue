// Proves the Docker + Xvfb path gives a legitimate (non-headless) browser.
// Run inside the container: `docker run --rm <img> node docker/xvfb-smoke.mjs`.
// Set TARGET=https://a-cloudflare-site to also probe whether the Cloudflare
// challenge clears — do that sparingly (repeated hits can get the IP blocked).
import { chromium } from 'patchright';

const target = process.env.TARGET || '';
console.log('launching Chromium under DISPLAY', process.env.DISPLAY || '(none)', '…');
const ctx = await chromium.launchPersistentContext('/tmp/prof', {
  headless: false,               // REAL browser — Xvfb gives it a screen
  viewport: null,
  timeout: 30000,
  dumpio: !!process.env.DUMPIO,  // set DUMPIO=1 to surface Chromium's stderr
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-position=-2400,-2400', '--window-size=1366,900',
    ...(process.env.CHROMIUM_EXTRA_ARGS || '').split(/\s+/).filter(Boolean)],
});
console.log('Chromium launched.');
const p = ctx.pages()[0] || await ctx.newPage();

// Fingerprint check on a benign local page — no network, always safe.
await p.setContent('<canvas id="c" width="100" height="40"></canvas><h1 id="t">ok</h1>');
const fp = await p.evaluate(() => {
  const g = document.getElementById('c').getContext('webgl');
  const d = g && g.getExtension('WEBGL_debug_renderer_info');
  return {
    ua: navigator.userAgent,
    headless: /headless/i.test(navigator.userAgent),
    dom: document.getElementById('t')?.textContent,
    webgl: !!g,
    gpu: d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a',
    screen: `${screen.width}x${screen.height}`,
  };
});
console.log('DISPLAY           :', process.env.DISPLAY || '(none)');
console.log('User-Agent        :', fp.ua);
console.log('HeadlessChrome UA?:', fp.headless, fp.headless ? '  <-- BAD (headless leaked)' : '  <-- good, looks like a real browser');
console.log('DOM renders       :', JSON.stringify(fp.dom), '| WebGL:', fp.webgl);
console.log('GPU renderer      :', fp.gpu);
console.log('Screen            :', fp.screen);

if (target) {
  console.log(`\nProbing ${target} (single load)…`);
  const resp = await p.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => ({ err: e.message }));
  let verdict = 'unknown';
  for (let i = 0; i < 12; i++) {
    await p.waitForTimeout(2000);
    const s = await p.evaluate(() => ({
      title: document.title,
      real: !!document.querySelector('.readed, input[name="login_name"], a[href*="action=logout"]'),
      cf: /just a moment|attention required/i.test(document.title) || !!document.querySelector('#challenge-running, script[src*="challenge-platform"]'),
    })).catch(() => ({}));
    if (s.real) { verdict = 'PASSED — real site loaded (Cloudflare cleared)'; break; }
    if (s.cf) verdict = 'BLOCKED — stuck on Cloudflare challenge';
  }
  console.log('HTTP status       :', resp?.status?.() ?? resp?.err);
  console.log('final title       :', JSON.stringify(await p.title().catch(() => '?')));
  console.log('VERDICT           :', verdict);
}

await ctx.close();
