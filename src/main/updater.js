// Updates from the project's GitHub releases.
//
// RADHA's installers are not code-signed, so the platform auto-updaters (Squirrel.Mac needs a signed
// app) cannot be used. Instead: ask GitHub for the latest release, download this platform's installer,
// check its size and SHA-256 against the release, then install it:
//   macOS   — mount the DMG, copy RADHA.app over the running copy, relaunch (or open the DMG if the
//             app's folder is not writable).
//   Windows — run the NSIS installer silently; it replaces the installed app and starts it again.
// Only the release information and the installer are downloaded. Nothing about the user is sent.
import { app, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { compareVersions, pickAsset } from '../shared/updates.js';

const run = promisify(execFile);
export const REPO = 'drtejassheth/RADHA';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;

export async function checkForUpdate() {
  const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RADHA-desktop' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const rel = await res.json();
  const version = String(rel.tag_name || '').replace(/^v/, '');
  const current = app.getVersion();
  const asset = pickAsset(rel.assets || []);
  return {
    current,
    version,
    available: compareVersions(version, current) > 0,
    name: rel.name || `RADHA ${version}`,
    notes: rel.body || '',
    page: rel.html_url,
    publishedAt: rel.published_at,
    asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url, digest: asset.digest || null } : null,
    checkedAt: new Date().toISOString(),
  };
}

/** Download the installer; onProgress(fraction). Returns the local file path after verification. */
export async function downloadUpdate(asset, onProgress = () => {}) {
  if (!asset?.url || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(asset.url)) throw new Error('Unexpected download address.');
  const dir = path.join(app.getPath('temp'), 'radha-update');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, path.basename(asset.name));
  const res = await fetch(asset.url, { headers: { 'User-Agent': 'RADHA-desktop' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
  const total = asset.size || Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  const out = createWriteStream(file);
  let got = 0;
  let last = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (total && got - last > total / 100) { last = got; onProgress(got / total); }
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  if (asset.size && got !== asset.size) { await fs.rm(file, { force: true }); throw new Error('The download is incomplete. Please try again.'); }
  const digest = `sha256:${hash.digest('hex')}`;
  if (asset.digest && asset.digest !== digest) { await fs.rm(file, { force: true }); throw new Error('The download did not match the release checksum and was deleted.'); }
  onProgress(1);
  return file;
}

/** The .app bundle this copy of RADHA runs from (macOS), or null in development. */
function currentBundle() {
  const m = process.execPath.match(/^(.*?\.app)\/Contents\/MacOS\//);
  return m && app.isPackaged ? m[1] : null;
}

/** After an update the previous copy may be left as RADHA.app.old (macOS keeps it while it runs): remove it. */
export async function cleanupAfterUpdate() {
  const target = currentBundle();
  if (!target) return;
  for (const p of [`${target}.old`, `${target}.updating`]) await fs.rm(p, { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(app.getPath('temp'), 'radha-update'), { recursive: true, force: true }).catch(() => {});
}

/**
 * Install a downloaded update and restart. Resolves with { mode } when it could not replace the app
 * itself and opened the installer for the user instead ('opened').
 */
export async function installUpdate(file) {
  if (process.platform === 'win32') {
    // Silent install over the existing one; --force-run starts RADHA again afterwards.
    spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 500);
    return { mode: 'installing' };
  }
  if (process.platform === 'darwin') {
    const target = currentBundle();
    if (!target) { await shell.openPath(file); return { mode: 'opened' }; }
    const mount = await fs.mkdtemp(path.join(app.getPath('temp'), 'radha-dmg-'));
    try {
      await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, file]);
      const src = (await fs.readdir(mount)).find((n) => n.endsWith('.app'));
      if (!src) throw new Error('No app found in the update.');
      const staged = `${target}.updating`;
      const old = `${target}.old`;
      await fs.rm(staged, { recursive: true, force: true });
      await run('ditto', [path.join(mount, src), staged]);
      await run('xattr', ['-cr', staged]).catch(() => {});
      await fs.rm(old, { recursive: true, force: true });
      await fs.rename(target, old);
      try { await fs.rename(staged, target); } catch (err) { await fs.rename(old, target); throw err; }
      await fs.rm(old, { recursive: true, force: true }).catch(() => {});
    } catch (err) {
      // Folder not writable (or anything else): let the user drag the app across themselves.
      await run('hdiutil', ['detach', mount, '-quiet']).catch(() => {});
      await shell.openPath(file);
      return { mode: 'opened', reason: err.message };
    }
    await run('hdiutil', ['detach', mount, '-quiet']).catch(() => {});
    app.relaunch();
    app.exit(0);
    return { mode: 'installing' };
  }
  await shell.openPath(file);
  return { mode: 'opened' };
}
