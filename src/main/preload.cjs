// Narrow, typed bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('radha', {
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  checkPython: () => invoke('python:check'),
  enginesInfo: (installed) => invoke('engines:info', installed),
  installEngines: (ids) => invoke('engines:install', ids),
  cancelEngineInstall: () => invoke('engines:cancel'),
  removeEngine: (id) => invoke('engines:remove', id),
  removeAllEngines: () => invoke('engines:removeAll'),
  onEngineProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('engines:progress', fn);
    return () => ipcRenderer.removeListener('engines:progress', fn);
  },

  pathForFile: (file) => webUtils.getPathForFile(file),
  openPdfDialog: () => invoke('dialog:openPdf'),
  parsePdf: (filePath, engine) => invoke('parse:pdf', { filePath, engine }),

  translate: (texts, target, service) => invoke('translate:run', { texts, target, service }),
  translationServices: () => invoke('translate:services'),
  aiProviders: () => invoke('ai:providers'),
  aiSetKey: (id, key) => invoke('ai:setKey', { id, key }),
  aiModels: (id) => invoke('ai:models', id),
  aiChat: (provider, model, messages) => invoke('ai:chat', { provider, model, messages }),

  listReports: () => invoke('db:listReports'),
  saveReport: (report) => invoke('db:saveReport', report),
  deleteReport: (id) => invoke('db:deleteReport', id),
  listPatients: () => invoke('db:listPatients'),
  savePatient: (p) => invoke('db:savePatient', p),
  deletePatient: (id, deleteReports) => invoke('db:deletePatient', { id, deleteReports }),
  mergePatients: (fromId, intoId) => invoke('db:mergePatients', { fromId, intoId }),
  exportBackup: () => invoke('db:exportBackup'),
  importBackup: () => invoke('db:importBackup'),
  saveText: (content, defaultName, filterName, extensions) => invoke('file:saveText', { content, defaultName, filterName, extensions }),

  exportPdf: (html, suggestedName) => invoke('export:pdf', { html, suggestedName }),
  showItem: (p) => invoke('shell:showItem', p),
  openExternal: (url) => invoke('shell:openExternal', url),
  copyText: (text) => invoke('clipboard:write', text),

  createShare: (payload, fileName, contents) => invoke('share:create', { payload, fileName, contents }),
  shareMenu: (file) => invoke('share:menu', file),
  saveShareCopy: (file) => invoke('share:saveCopy', file),
  openShareFile: () => invoke('share:open'),
  decryptShare: (file, code) => invoke('share:decrypt', { file, code }),

  lockStatus: () => invoke('lock:status'),
  unlock: (pin) => invoke('lock:unlock', pin),
  lockNow: () => invoke('lock:lock'),
  showLockFile: () => invoke('lock:showFile'),
  setPin: (pin, currentPin) => invoke('lock:setPin', { pin, currentPin }),
  removePin: (currentPin) => invoke('lock:remove', currentPin),
  setAutoLock: (minutes) => invoke('lock:setAutoLock', minutes),
  onSystemLock: (cb) => {
    const fn = (_e, why) => cb(why);
    ipcRenderer.on('lock:system', fn);
    return () => ipcRenderer.removeListener('lock:system', fn);
  },

  appInfo: () => invoke('app:info'),
  checkUpdate: () => invoke('update:check'),
  downloadUpdate: (asset) => invoke('update:download', asset),
  installUpdate: (file) => invoke('update:install', file),
  onUpdateProgress: (cb) => {
    const fn = (_e, f) => cb(f);
    ipcRenderer.on('update:progress', fn);
    return () => ipcRenderer.removeListener('update:progress', fn);
  },

  libraryIndex: () => invoke('library:index'),
  libraryGet: (id) => invoke('library:get', id),
});
