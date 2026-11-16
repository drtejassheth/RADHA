// One-click installer for the local parsing engines.
//
// Everything lives in its own folder (<userData>/engines) so it never touches the system Python:
//   bin/uv        the uv package manager (found on the computer or downloaded from GitHub)
//   python/       a private Python 3.12 that uv downloads when needed
//   venv/         the virtual environment the engines are installed into
//   models/       model weights downloaded by EasyOCR / Docling / Marker
// "Remove all" just deletes that folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { PARSER_SCRIPT } from './localParser.js';

const IS_WIN = process.platform === 'win32';
const PY_VERSION = '3.12';

/**
 * Engine install metadata. disk = packages + models on disk (MB); ram = peak memory (MB) while
 * reading a 9-page report, measured on an 8 GB Apple-silicon Mac with Python 3.12 (Nov 2026).
 * PyTorch is shared, so installing several engines costs less than the sum.
 */
export const ENGINE_INFO = {
  pdfplumber: { pip: ['pdfplumber'], disk: 35, ram: 100, models: null, label: 'pdfplumber' },
  pymupdf: { pip: ['pymupdf'], disk: 110, ram: 300, models: null, label: 'PyMuPDF' },
  applevision: { pip: ['ocrmac', 'pdfplumber'], disk: 60, ram: 900, models: null, label: 'Apple Vision OCR', platforms: ['darwin'] },
  easyocr: { pip: ['easyocr', 'pdfplumber'], disk: 1000, ram: 1400, models: ['easyocr/'], label: 'EasyOCR' },
  docling: { pip: ['docling', 'pdfplumber'], disk: 1600, ram: 1700, models: ['hf:docling-project/', 'hf:ds4sd/'], label: 'Docling' },
  marker: { pip: ['marker-pdf', 'pdfplumber'], disk: 1000, ram: 1700, models: ['hf:datalab-to/', 'datalab/'], label: 'Marker (Surya)' },
};
const TORCH_MB = 750; // PyTorch + NumPy/SciPy, shared by EasyOCR / Docling / Marker

export function enginesDir(userData) { return path.join(userData, 'engines'); }
export function managedPython(userData) {
  const v = path.join(enginesDir(userData), 'venv');
  return IS_WIN ? path.join(v, 'Scripts', 'python.exe') : path.join(v, 'bin', 'python');
}
export function hasManagedPython(userData) { return existsSync(managedPython(userData)); }

/** Environment for running the managed Python: keeps all model downloads inside engines/models. */
export function managedEnv(userData) {
  const m = path.join(enginesDir(userData), 'models');
  return {
    HF_HOME: path.join(m, 'hf'),
    EASYOCR_MODULE_PATH: path.join(m, 'easyocr'),
    MODEL_CACHE_DIR: path.join(m, 'datalab'),
    TORCH_HOME: path.join(m, 'torch'),
    XDG_CACHE_HOME: path.join(m, 'cache'),
    HF_HUB_DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    TOKENIZERS_PARALLELISM: 'false',
    PYTORCH_ENABLE_MPS_FALLBACK: '1',
  };
}

/** Estimated download/disk for installing `ids` on top of what is already installed. */
export function estimate(ids, installed = {}) {
  const heavy = (id) => ['easyocr', 'docling', 'marker'].includes(id);
  const torchPresent = Object.keys(installed).some((k) => installed[k] && heavy(k));
  let disk = 0;
  let torchNeeded = false;
  for (const id of ids) {
    if (installed[id]) continue;
    const info = ENGINE_INFO[id];
    if (!info) continue;
    disk += heavy(id) ? info.disk - TORCH_MB : info.disk;
    if (heavy(id)) torchNeeded = true;
  }
  if (torchNeeded && !torchPresent) disk += TORCH_MB;
  return { diskMB: disk };
}

export function engineList() {
  return Object.entries(ENGINE_INFO)
    .filter(([, i]) => !i.platforms || i.platforms.includes(process.platform))
    .map(([id, i]) => ({ id, label: i.label, diskMB: i.disk, ramMB: i.ram }));
}

// ------------------------------------------------------------------ process helpers

function run(cmd, args, { env, onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    let tail = '';
    const feed = (d) => {
      // Progress bars use \r; treat it like a new line so the UI sees the latest state.
      for (const line of String(d).split(/[\r\n]+/)) {
        const t = line.trim();
        if (!t) continue;
        tail = (tail + '\n' + t).split('\n').slice(-12).join('\n');
        onLine?.(t);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Cancelled.'));
      if (code === 0) resolve(tail);
      else reject(new Error(`${path.basename(cmd)} exited with code ${code}\n${tail.split('\n').slice(-6).join('\n')}`));
    });
  });
}

async function dirSizeMB(dir, follow = false) {
  if (!existsSync(dir)) return 0;
  if (!IS_WIN) {
    // du is fast and does not run out of file handles on big trees like PyTorch.
    const out = await new Promise((resolve) => {
      const c = spawn('du', [follow ? '-skL' : '-sk', dir]); // -L: Hugging Face snapshots are symlinks into a shared blobs folder
      let o = '';
      c.stdout.on('data', (d) => { o += d; });
      c.on('close', () => resolve(o));
      c.on('error', () => resolve(''));
    });
    const kb = parseInt(out, 10);
    if (Number.isFinite(kb)) return Math.round(kb / 1000);
  }
  let total = 0;
  const walk = async (d) => {
    let ents;
    try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { try { total += (await fs.lstat(p)).size; } catch { /* gone */ } }
    }
  };
  await walk(dir);
  return Math.round(total / 1e6);
}

// ------------------------------------------------------------------ uv

async function findUv(base) {
  const exe = IS_WIN ? 'uv.exe' : 'uv';
  const home = os.homedir();
  const candidates = [
    path.join(base, 'bin', exe),
    path.join(home, '.local', 'bin', exe),
    path.join(home, '.cargo', 'bin', exe),
    '/opt/homebrew/bin/uv', '/usr/local/bin/uv',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return null;
}

export async function downloadUv(base, report) {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const target = process.platform === 'darwin' ? `${arch}-apple-darwin`
    : IS_WIN ? `${arch}-pc-windows-msvc` : `${arch}-unknown-linux-gnu`;
  const ext = IS_WIN ? 'zip' : 'tar.gz';
  const url = `https://github.com/astral-sh/uv/releases/latest/download/uv-${target}.${ext}`;
  report(`Downloading the uv package manager (≈ 20 MB) from GitHub…`);
  const binDir = path.join(base, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const archive = path.join(base, `uv.${ext}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Could not download uv (${res.status}).`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));
  await run('tar', IS_WIN ? ['-xf', archive, '-C', binDir] : ['-xzf', archive, '-C', binDir, '--strip-components', '1']);
  await fs.rm(archive, { force: true });
  const uv = path.join(binDir, IS_WIN ? 'uv.exe' : 'uv');
  if (!existsSync(uv)) throw new Error('uv download did not contain the uv program.');
  return uv;
}

// ------------------------------------------------------------------ installer

export class EngineInstaller {
  constructor(userData, { onProgress } = {}) {
    this.userData = userData;
    this.base = enginesDir(userData);
    this.onProgress = onProgress || (() => {});
    this.job = null; // { ids, controller }
  }

  status() {
    return { busy: Boolean(this.job), ids: this.job?.ids || [], python: managedPython(this.userData), managed: hasManagedPython(this.userData) };
  }

  cancel() { this.job?.controller.abort(); }

  uvEnv() {
    return {
      UV_PYTHON_INSTALL_DIR: path.join(this.base, 'python'),
      UV_CACHE_DIR: path.join(this.base, 'cache'),
      UV_NO_PROGRESS: '1',
      UV_LINK_MODE: 'copy',
    };
  }

  async ensureVenv(uv, emit, signal) {
    const py = managedPython(this.userData);
    if (existsSync(py)) return py;
    emit({ phase: 'python', message: `Setting up a private Python ${PY_VERSION} (≈ 50 MB, one time)…` });
    await run(uv, ['venv', '--python', PY_VERSION, '--seed', path.join(this.base, 'venv')], {
      env: { ...this.uvEnv(), UV_PYTHON_PREFERENCE: 'managed' }, signal, onLine: (l) => emit({ phase: 'python', line: l }),
    });
    return py;
  }

  /** Install engines (packages + models). Resolves to a summary; progress goes to onProgress. */
  async install(ids, { options = {} } = {}) {
    if (this.job) throw new Error('An installation is already running.');
    ids = ids.filter((id) => ENGINE_INFO[id] && (!ENGINE_INFO[id].platforms || ENGINE_INFO[id].platforms.includes(process.platform)));
    if (!ids.length) throw new Error('Nothing to install.');
    const controller = new AbortController();
    const { signal } = controller;
    this.job = { ids, controller };
    const total = ids.length + 2;
    let stepNo = 0;
    const emit = (p) => this.onProgress({ ids, step: stepNo, total, ...p });
    try {
      await fs.mkdir(this.base, { recursive: true });
      stepNo = 1;
      emit({ phase: 'uv', message: 'Looking for the uv package manager…' });
      const uv = (await findUv(this.base)) || (await downloadUv(this.base, (m) => emit({ phase: 'uv', message: m })));
      if (signal.aborted) throw new Error('Cancelled.');

      stepNo = 2;
      const py = await this.ensureVenv(uv, emit, signal);

      const pkgs = [...new Set(ids.flatMap((id) => ENGINE_INFO[id].pip))];
      emit({ phase: 'packages', message: `Downloading and installing ${ids.map((id) => ENGINE_INFO[id].label).join(', ')}…` });
      await run(uv, ['pip', 'install', '--python', py, ...pkgs], {
        env: this.uvEnv(), signal, onLine: (l) => emit({ phase: 'packages', line: l }),
      });

      for (const id of ids) {
        stepNo += 1;
        if (!['applevision', 'easyocr', 'docling', 'marker'].includes(id)) continue;
        emit({ phase: 'models', engine: id, message: `Preparing ${ENGINE_INFO[id].label}${ENGINE_INFO[id].models ? ' — downloading its models' : ''}…` });
        await run(py, [PARSER_SCRIPT, '--warmup', id, '--options', JSON.stringify(options[id] || {})], {
          env: managedEnv(this.userData), signal, onLine: (l) => emit({ phase: 'models', engine: id, line: l }),
        });
      }
      stepNo = total;
      emit({ phase: 'cleanup', message: 'Cleaning up the download cache…' });
      await run(uv, ['cache', 'clean'], { env: this.uvEnv() }).catch(() => {});
      const usage = await this.usage();
      emit({ phase: 'done', message: `Installed ${ids.map((id) => ENGINE_INFO[id].label).join(', ')}.`, usage });
      return { python: py, usage };
    } catch (err) {
      emit({ phase: 'error', message: err.message });
      throw err;
    } finally {
      this.job = null;
    }
  }

  /** Uninstall one engine's packages and delete its own models (shared PyTorch stays). */
  async remove(id) {
    if (this.job) throw new Error('Wait for the installation to finish.');
    const info = ENGINE_INFO[id];
    if (!info) throw new Error(`Unknown engine: ${id}`);
    const py = managedPython(this.userData);
    if (!existsSync(py)) throw new Error('No engines are installed by RADHA.');
    const uv = await findUv(this.base);
    if (!uv) throw new Error('uv is missing — use "Remove all local engines" instead.');
    const keep = new Set(Object.entries(ENGINE_INFO).filter(([k]) => k !== id).flatMap(([, i]) => i.pip));
    const pkgs = info.pip.filter((p) => !keep.has(p));
    if (pkgs.length) await run(uv, ['pip', 'uninstall', '--python', py, ...pkgs], { env: this.uvEnv() });
    const hfRepos = (info.models || []).filter((m) => m.startsWith('hf:')).map((m) => m.slice(3));
    if (hfRepos.length) {
      // Hugging Face keeps files in a shared blobs folder: let its own cache tool free them.
      const script = 'import sys\nfrom huggingface_hub import scan_cache_dir\nc = scan_cache_dir()\n'
        + 'revs = [v.commit_hash for r in c.repos if r.repo_id.startswith(tuple(sys.argv[1:])) for v in r.revisions]\n'
        + 'revs and c.delete_revisions(*revs).execute()';
      await run(py, ['-c', script, ...hfRepos], { env: managedEnv(this.userData) }).catch(() => {});
    }
    for (const dir of await this.modelDirs(id)) await fs.rm(dir, { recursive: true, force: true });
    return this.usage();
  }

  async removeAll() {
    if (this.job) throw new Error('Wait for the installation to finish.');
    await fs.rm(this.base, { recursive: true, force: true });
    return true;
  }

  /** Model folders that belong to one engine (prefixes inside engines/models; '/' = the whole folder). */
  async modelDirs(id) {
    const out = [];
    for (let prefix of ENGINE_INFO[id]?.models || []) {
      if (prefix.startsWith('hf:')) prefix = `hf/hub/models--${prefix.slice(3).replace('/', '--')}`;
      const full = path.join(this.base, 'models', prefix);
      if (prefix.endsWith('/')) { if (existsSync(full)) out.push(full); continue; }
      const parent = path.dirname(full);
      const start = path.basename(full);
      try {
        for (const name of await fs.readdir(parent)) if (name.startsWith(start)) out.push(path.join(parent, name));
      } catch { /* none */ }
    }
    return out;
  }

  async usage() {
    if (!existsSync(this.base)) return { totalMB: 0, modelsMB: 0, packagesMB: 0, models: {} };
    const [venv, python, models] = await Promise.all([
      dirSizeMB(path.join(this.base, 'venv')), dirSizeMB(path.join(this.base, 'python')), dirSizeMB(path.join(this.base, 'models')),
    ]);
    const per = {};
    for (const [id, i] of Object.entries(ENGINE_INFO)) {
      if (!i.models) continue;
      per[id] = 0;
      for (const dir of await this.modelDirs(id)) {
        const snap = path.join(dir, 'snapshots');
        per[id] += existsSync(snap) ? await dirSizeMB(snap, true) : await dirSizeMB(dir);
      }
    }
    return { totalMB: venv + python + models, packagesMB: venv + python, modelsMB: models, models: per, folder: this.base };
  }
}
