// Plugin catalog + installer. The app ships with no plugins; this fetches a
// remote catalog manifest, then downloads/verifies/extracts first-party plugin
// bundles into the plugins/ dir. Plugins register routes/jobs/sources at boot,
// so an install/uninstall applies on the next restart (handled by the caller).
//
// Security: bundles come only from the catalog manifest (a trusted URL); each
// download is checksum-verified when the manifest gives a sha256; and zip
// extraction is path-traversal-guarded so a malicious entry can't escape the
// plugin's own folder. Install is admin-gated at the route layer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import config from './config.js';
import { pluginsDir } from './plugins.js';

const UA = 'comic-metadata-client/1.0';
const execFileP = promisify(execFile);

// Does the installed plugin declare runtime dependencies that need fetching?
function needsDeps(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return !!(pkg.dependencies && Object.keys(pkg.dependencies).length);
  } catch {
    return false;
  }
}

// Fetch a plugin's deps for the HOST platform — needed for native modules
// (e.g. the reader plugin's sharp), which can't ship portably in a zip.
async function defaultNpmInstall(dir) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await execFileP(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    timeout: 5 * 60 * 1000,
    windowsHide: true,
  });
}

export function catalogUrl() {
  return config.pluginCatalogUrl || 'https://data.backissue.app/plugins/catalog.json';
}

// A plugin id is also a folder name — keep it to a safe charset.
function safeId(id) {
  const clean = String(id || '').replace(/[^a-z0-9_-]/gi, '');
  if (!clean) throw new Error('invalid plugin id');
  return clean;
}

// Fetch the remote catalog: { plugins: [{ id, name, description, version,
// download, sha256? }] }. Returns the validated plugin entries.
export async function fetchCatalog({ fetchImpl = fetch } = {}) {
  const resp = await fetchImpl(catalogUrl(), { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`catalog request failed (HTTP ${resp.status})`);
  const data = await resp.json();
  const list = Array.isArray(data?.plugins) ? data.plugins : [];
  return list.filter((p) => p && p.id && p.download);
}

// Extract a zip buffer into `destDir`, guarding every entry against path
// traversal (a "../" or absolute entry that would escape destDir is rejected).
function extractZip(buf, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const root = path.resolve(destDir);
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        const target = path.resolve(root, entry.fileName);
        // Must stay within destDir (block ../ and absolute escapes).
        if (target !== root && !target.startsWith(root + path.sep)) {
          return reject(new Error(`unsafe zip entry: ${entry.fileName}`));
        }
        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(target, { recursive: true });
          return zip.readEntry();
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, (e, rs) => {
          if (e) return reject(e);
          const ws = fs.createWriteStream(target);
          rs.on('error', reject);
          ws.on('error', reject);
          ws.on('close', () => zip.readEntry());
          rs.pipe(ws);
        });
      });
      zip.on('end', resolve);
      zip.readEntry();
    });
  });
}

// A GitHub-style archive zip wraps everything in one top-level folder; a bare
// bundle has the files at the root. Return whichever dir actually holds the
// plugin (the one containing index.js).
function resolveBundleRoot(dir) {
  if (fs.existsSync(path.join(dir, 'index.js'))) return dir;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (subs.length === 1) {
    const inner = path.join(dir, subs[0].name);
    if (fs.existsSync(path.join(inner, 'index.js'))) return inner;
  }
  return dir; // let the caller's index.js check fail with a clear message
}

// Download, verify, extract and install one catalog entry into plugins/<id>/.
// Returns { id, version }. Throws on any failure, leaving the existing install
// (if any) untouched — the new copy is staged in a temp dir and swapped in last.
export async function installPlugin(entry, { fetchImpl = fetch, npmInstall = defaultNpmInstall } = {}) {
  const id = safeId(entry?.id);
  const dir = pluginsDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, id);
  const staging = path.join(dir, `.${id}.installing`);

  const resp = await fetchImpl(entry.download, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`download failed (HTTP ${resp.status})`);
  const buf = Buffer.from(await resp.arrayBuffer());

  if (entry.sha256) {
    const got = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
    if (got !== String(entry.sha256).toLowerCase()) {
      throw new Error('checksum mismatch — refusing to install');
    }
  }

  fs.rmSync(staging, { recursive: true, force: true });
  try {
    await extractZip(buf, staging);
    const src = resolveBundleRoot(staging);
    if (!fs.existsSync(path.join(src, 'index.js'))) {
      throw new Error('bundle has no index.js — not a valid plugin');
    }
    // Swap into place last so a failure never leaves a half-written install.
    fs.rmSync(dest, { recursive: true, force: true });
    if (src !== staging) {
      fs.renameSync(src, dest);
    } else {
      fs.renameSync(staging, dest);
    }
    // Native/deep deps can't ship portably in the zip — install them for the
    // host platform. A failure here is surfaced but leaves the files in place
    // so the Plugins page shows the load error and the user can retry.
    if (needsDeps(dest)) {
      try {
        await npmInstall(dest);
      } catch (e) {
        throw new Error(`installed, but dependency install failed: ${e?.message || e}`);
      }
    }
    return { id, version: entry.version || null };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// Remove an installed plugin's folder. Returns { removed }.
export function uninstallPlugin(id) {
  const clean = safeId(id);
  const dest = path.join(pluginsDir(), clean);
  if (!fs.existsSync(dest)) return { removed: false };
  fs.rmSync(dest, { recursive: true, force: true });
  return { removed: true };
}
