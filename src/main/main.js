// RADHA — Electron main process.
// Owns everything that touches the file system, Python, or the network,
// and exposes it to the renderer through a narrow IPC surface (see preload.cjs).
import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, ShareMenu } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseLocal, checkPythonEngines } from './localParser.js';
import { sarvamParsePdf } from './sarvam.js';
import { TRANSLATORS, translateTexts } from './translators.js';
import { Store } from './store.js';
import { PROVIDERS, aiChat, aiListModels } from './aiProviders.js';
import { EngineInstaller, engineList, estimate, managedPython, hasManagedPython, managedEnv } from './engines.js';
import { checkForUpdate, downloadUpdate, installUpdate, cleanupAfterUpdate } from './updater.js';
import { newCode, formatCode, encryptShare, decryptShare, checkEnvelope } from './shareCrypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

let mainWindow;
let store;
let installer;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: 'RADHA — Report Analysis & Deterministic Health Assistant',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  // Open external links in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Where the one-click engines live (RADHA_ENGINES_HOME lets smoke tests reuse the real install).
const engineHome = () => process.env.RADHA_ENGINES_HOME || app.getPath('userData');

function settingsForPython(engine) {
  const s = store.getSettings();
  const userData = engineHome();
  const managed = managedPython(userData);
  const pythonPath = s.pythonPath || (hasManagedPython(userData) ? managed : (process.platform === 'win32' ? 'python' : 'python3'));
  const all = s.engineOptions || {};
  const options = { ...(all.common || {}), ...(all[engine] || {}), engines: all };
  // Smaller batches by default on 8 GB machines (the user can change it under Tune).
  if (options.lowMemory == null) options.lowMemory = os.totalmem() <= 9e9;
  return { pythonPath, env: pythonPath === managed ? managedEnv(userData) : {}, options, managed: pythonPath === managed };
}

function wrap(fn) {
  // Return {ok, data | error} so the renderer never sees a raw rejected IPC promise.
  return async (_evt, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(err);
      return { ok: false, error: err?.message || String(err) };
    }
  };
}

function registerIpc() {
  ipcMain.handle('settings:get', wrap(() => store.getSettings({ redactKey: true })));
  ipcMain.handle('settings:set', wrap((patch) => store.setSettings(patch)));

  ipcMain.handle('python:check', wrap(async () => ({ ...(await checkPythonEngines(settingsForPython())), managed: settingsForPython().managed })));

  // One-click engine installer (packages + models into <userData>/engines).
  ipcMain.handle('engines:info', wrap(async (installed = {}) => {
    const list = engineList();
    const local = list.map((e) => e.id);
    const essentials = ['pdfplumber', 'pymupdf', 'applevision'].filter((id) => local.includes(id));
    return {
      list, platform: process.platform, totalMemMB: Math.round(os.totalmem() / 1e6),
      status: installer.status(), usage: await installer.usage(),
      estimates: { all: estimate(local, installed).diskMB, essentials: estimate(essentials, installed).diskMB },
    };
  }));
  ipcMain.handle('engines:install', wrap(async (ids) => {
    const res = await installer.install(ids, { options: store.getSettings().engineOptions || {} });
    // Use RADHA's own engine environment from now on (a custom Python path would hide it).
    if (store.getSettings().pythonPath) await store.setSettings({ pythonPath: '' });
    return res;
  }));
  ipcMain.handle('engines:cancel', wrap(() => { installer.cancel(); return true; }));
  ipcMain.handle('engines:remove', wrap((id) => installer.remove(id)));
  ipcMain.handle('engines:removeAll', wrap(() => installer.removeAll()));

  ipcMain.handle('parse:pdf', wrap(async ({ filePath, engine }) => {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('Not a file: ' + filePath);
    if (engine === 'sarvam') {
      const key = store.getApiKey();
      if (!key) throw new Error('Sarvam AI API key is not set. Add it in Settings.');
      const s = store.getSettings();
      return sarvamParsePdf(filePath, key, { language: s.sarvamParseLanguage || 'en-IN' });
    }
    return parseLocal(filePath, engine, settingsForPython(engine || 'auto'));
  }));

  ipcMain.handle('dialog:openPdf', wrap(async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select blood test report(s)',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    return res.canceled ? [] : res.filePaths;
  }));

  ipcMain.handle('translate:services', wrap(() => TRANSLATORS.map((t) => ({
    ...t, hasKey: Boolean(store.getProviderKey(t.id === 'sarvam' ? 'sarvam' : `tr_${t.id}`)),
  }))));
  ipcMain.handle('translate:run', wrap(({ texts, target, service }) => {
    const s = store.getSettings();
    return translateTexts(service || s.translationProvider, texts, target, { settings: s, getKey: (id) => store.getProviderKey(id) });
  }));

  ipcMain.handle('ai:providers', wrap(() => {
    const s = store.getSettings();
    return PROVIDERS.map(({ id, name, needsKey, optionalKey, free, local, note, defaultModel }) => ({
      id, name, needsKey, optionalKey: Boolean(optionalKey), free: Boolean(free), local: Boolean(local), note,
      hasKey: Boolean(store.getProviderKey(id)), model: s.aiModels?.[id] || defaultModel,
    }));
  }));
  ipcMain.handle('ai:setKey', wrap(async ({ id, key }) => { await store.setProviderKey(id, key); return true; }));
  ipcMain.handle('ai:models', wrap((id) => aiListModels(id, { key: store.getProviderKey(id), settings: store.getSettings() })));
  ipcMain.handle('ai:chat', wrap(({ provider, model, messages }) => {
    const s = store.getSettings();
    return aiChat(provider, messages, { model: model || s.aiModels?.[provider], key: store.getProviderKey(provider), settings: s });
  }));

  ipcMain.handle('db:listReports', wrap(() => store.listReports()));
  ipcMain.handle('db:listPatients', wrap(() => store.listPatients()));
  ipcMain.handle('db:savePatient', wrap((p) => store.savePatient(p)));
  ipcMain.handle('db:deletePatient', wrap(({ id, deleteReports }) => store.deletePatient(id, { deleteReports })));
  ipcMain.handle('db:mergePatients', wrap(({ fromId, intoId }) => store.mergePatients(fromId, intoId)));
  ipcMain.handle('db:exportBackup', wrap(async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Back up RADHA data', defaultPath: path.join(app.getPath('documents'), `RADHA-backup-${stamp}.json`),
      filters: [{ name: 'RADHA backup', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, JSON.stringify(store.exportData(), null, 2), 'utf8');
    return filePath;
  }));
  ipcMain.handle('db:importBackup', wrap(async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: 'Restore RADHA backup', properties: ['openFile'], filters: [{ name: 'RADHA backup', extensions: ['json'] }] });
    if (res.canceled || !res.filePaths[0]) return null;
    return store.importData(JSON.parse(await fs.readFile(res.filePaths[0], 'utf8')));
  }));
  ipcMain.handle('file:saveText', wrap(async ({ content, defaultName, filterName, extensions }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('documents'), defaultName), filters: [{ name: filterName, extensions }],
    });
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }));
  ipcMain.handle('db:saveReport', wrap((report) => store.saveReport(report)));
  ipcMain.handle('db:deleteReport', wrap((id) => store.deleteReport(id)));

  ipcMain.handle('export:pdf', wrap(async ({ html, suggestedName }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export RADHA summary',
      defaultPath: path.join(app.getPath('documents'), suggestedName || 'RADHA-summary.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return null;

    // Render the report HTML in an invisible window, then print it to PDF.
    const tmp = path.join(app.getPath('temp'), `radha-export-${Date.now()}.html`);
    await fs.writeFile(tmp, html, 'utf8');
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
    try {
      await win.loadFile(tmp);
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { marginType: 'custom', top: 0.5, bottom: 0.6, left: 0.5, right: 0.5 },
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate:
          '<div style="font-size:7px;width:100%;text-align:center;color:#666;font-family:sans-serif">' +
          'RADHA summary — not a diagnosis. Follow your medical practitioner\'s advice. ' +
          'Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
      });
      await fs.writeFile(filePath, pdf);
    } finally {
      win.destroy();
      fs.unlink(tmp).catch(() => {});
    }
    return filePath;
  }));

  ipcMain.handle('shell:showItem', wrap((p) => shell.showItemInFolder(p)));
  // Sharing a patient with a doctor (.radha files, see docs/share-format.md).
  ipcMain.handle('share:create', wrap(async ({ payload, fileName, contents }) => {
    const code = newCode();
    const env = await encryptShare(payload, { code, contents, createdBy: { app: 'RADHA', version: app.getVersion(), role: 'patient' } });
    const dir = process.env.RADHA_SHARE_DIR || path.join(app.getPath('documents'), 'RADHA Shares');
    await fs.mkdir(dir, { recursive: true });
    const safe = String(fileName || 'patient').replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'patient';
    const file = path.join(dir, `${safe} ${new Date().toISOString().slice(0, 10)} ${code.slice(0, 4)}.radha`);
    await fs.writeFile(file, JSON.stringify(env), 'utf8');
    return { file, code: formatCode(code), shareId: env.shareId, bytes: (await fs.stat(file)).size };
  }));
  ipcMain.handle('share:menu', wrap(async (file) => {
    if (process.platform === 'darwin' && ShareMenu) { new ShareMenu({ filePaths: [file] }).popup({ window: mainWindow }); return 'menu'; }
    shell.showItemInFolder(file);
    return 'folder';
  }));
  ipcMain.handle('share:saveCopy', wrap(async (file) => {
    const res = await dialog.showSaveDialog(mainWindow, { defaultPath: path.basename(file), filters: [{ name: 'RADHA share file', extensions: ['radha'] }] });
    if (res.canceled || !res.filePath) return null;
    await fs.copyFile(file, res.filePath);
    return res.filePath;
  }));
  ipcMain.handle('share:open', wrap(async () => {
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'RADHA share file', extensions: ['radha', 'json'] }] });
    if (res.canceled || !res.filePaths[0]) return null;
    const file = res.filePaths[0];
    const env = checkEnvelope(JSON.parse(await fs.readFile(file, 'utf8')));
    return { file, fileName: path.basename(file), createdAt: env.createdAt, createdBy: env.createdBy, contents: env.contents, shareId: env.shareId };
  }));
  ipcMain.handle('share:decrypt', wrap(async ({ file, code }) => decryptShare(JSON.parse(await fs.readFile(file, 'utf8')), code)));
  ipcMain.handle('clipboard:write', wrap((text) => { clipboard.writeText(String(text)); return true; }));
  ipcMain.handle('shell:openExternal', wrap((url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return true; }));

  // Updates (see updater.js): check the latest GitHub release, download + verify, install and restart.
  ipcMain.handle('app:info', wrap(() => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged })));
  ipcMain.handle('update:check', wrap(() => checkForUpdate()));
  ipcMain.handle('update:download', wrap((asset) => downloadUpdate(asset, (f) => mainWindow?.webContents.send('update:progress', f))));
  ipcMain.handle('update:install', wrap((file) => installUpdate(file)));

  ipcMain.handle('library:index', wrap(async () => (await loadLibrary()).index));
  ipcMain.handle('library:get', wrap(async (id) => (await loadLibrary()).byId.get(id) || null));
}

// Calculator library (src/data/calculator-library.json, ~9 MB) is loaded once, on first use.
let libraryPromise;
function loadLibrary() {
  libraryPromise ||= fs.readFile(path.join(ROOT, 'src', 'data', 'calculator-library.json'), 'utf8').then((raw) => {
    const all = JSON.parse(raw);
    const byId = new Map(all.map((c) => [c.id, c]));
    const index = all.map((c) => ({
      id: c.id, name: c.name, aliases: c.aliases, categories: c.categories, types: c.types,
      description: (c.description || '').slice(0, 240),
      inputs: c.versions.reduce((n, v) => Math.max(n, (v.inputs || []).length), 0),
      scored: c.versions.some((v) => v.score),
    }));
    return { byId, index };
  });
  return libraryPromise;
}

// Smoke-test mode: isolated data folder + scripted walkthrough (see test/smoke.js).
if (process.env.RADHA_SMOKE) app.setPath('userData', path.join(app.getPath('temp'), `radha-smoke-${process.pid}`));

app.whenReady().then(async () => {
  if (process.env.RADHA_SMOKE && process.env.RADHA_SMOKE_SEED) {
    // Smoke tests can start from a copy of an existing database.
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.copyFile(process.env.RADHA_SMOKE_SEED, path.join(app.getPath('userData'), 'radha-db.json'));
  }
  store = new Store(app.getPath('userData'));
  await store.load();
  installer = new EngineInstaller(engineHome(), { onProgress: (p) => mainWindow?.webContents.send('engines:progress', p) });
  registerIpc();
  createWindow();
  cleanupAfterUpdate().catch(() => {});
  if (process.env.RADHA_SMOKE) {
    // RADHA_SCRIPT swaps in another automation script (e.g. scripts/capture-docs.js for the guide's screenshots).
    const { runSmoke } = await import(path.resolve(ROOT, process.env.RADHA_SCRIPT || path.join('test', 'smoke.js')));
    runSmoke(mainWindow, process.env.RADHA_SMOKE).finally(() => app.quit());
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
