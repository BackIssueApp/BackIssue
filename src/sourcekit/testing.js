// Offline harness for site-source tests: a kit whose HTTP answers come from
// recorded fixtures, so a plugin's search/resolve run against saved HTML or
// JSON with no network. Routes are matched by exact URL, then by RegExp,
// then by substring; a value may be a string/Buffer/object or a function of
// the request ({ url, opts }).
import { makeKit } from './define.js';

export function fakeHttp(routes = {}) {
  const calls = [];
  const entries = Object.entries(routes);
  const answer = (url, opts) => {
    calls.push({ url, opts });
    for (const [k, v] of entries) if (k === url) return typeof v === 'function' ? v({ url, opts }) : v;
    for (const [k, v] of entries) if (k.startsWith('re:') && new RegExp(k.slice(3)).test(url)) return typeof v === 'function' ? v({ url, opts }) : v;
    for (const [k, v] of entries) if (url.includes(k)) return typeof v === 'function' ? v({ url, opts }) : v;
    throw Object.assign(new Error(`no fixture for ${url}`), { status: 404 });
  };
  return {
    calls,
    html: async (url, opts) => String(await answer(url, opts)),
    json: async (url, opts) => { const v = await answer(url, opts); return typeof v === 'string' ? JSON.parse(v) : v; },
    download: async (url, opts) => {
      const v = await answer(url, opts);
      const buffer = Buffer.isBuffer(v) ? v : Buffer.from(String(v));
      opts?.onProgress?.({ done: buffer.length, total: buffer.length, bps: 0 });
      return { buffer, filename: null, contentType: null };
    },
  };
}

/** A kit for a definition whose network is `routes` (see fakeHttp). */
export function testKit(def, routes = {}, { config = {}, ctx = {} } = {}) {
  const http = fakeHttp(routes);
  const kit = makeKit(def, { config: { [`${def.id}Enabled`]: true, ...config }, ...ctx }, { session: {}, http });
  kit.calls = http.calls;
  return kit;
}
