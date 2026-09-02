// Download-client URL construction, shared by the Usenet and torrent clients.
// Both used to carry their own near-identical copy of this; they drifted (only
// one understood a URL base), so it lives in one place now.

/** A URL base ("URL Base" in the *arr apps): the path a reverse proxy serves
 *  the client under, e.g. https://seedbox.example/sabnzbd/api. Normalized to
 *  '' or '/x/y', so every spelling a user might paste — 'sab', '/sab', 'sab/',
 *  even a whole URL — behaves the same. */
export function normalizeUrlBase(v) {
  const p = String(v || '').trim().replace(/^https?:\/\/[^/]*/i, '');
  const clean = p.split('/').filter(Boolean).join('/');
  return clean ? `/${clean}` : '';
}

/** scheme://host[:port][/urlBase] from the pieces a client config holds.
 *  A path typed into the HOST field is treated as part of the URL base —
 *  without that, the port would be appended AFTER the path and produce
 *  http://host/sabnzbd:8080, a dead address behind a vague "cannot connect". */
export function buildClientUrl({ host, port, ssl, urlBase = '' }) {
  const raw = String(host || '').trim();
  if (!raw) return '';
  const noScheme = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const slash = noScheme.indexOf('/');
  const h = slash === -1 ? noScheme : noScheme.slice(0, slash);
  const hostPath = slash === -1 ? '' : noScheme.slice(slash);
  const scheme = ssl ? 'https' : 'http';
  const hasPort = /:\d+$/.test(h);
  const origin = `${scheme}://${h}${hasPort || !port ? '' : ':' + port}`;
  return `${origin}${normalizeUrlBase(hostPath)}${normalizeUrlBase(urlBase)}`;
}
