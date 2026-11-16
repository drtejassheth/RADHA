// Local JSON persistence for settings and verified reports (kept in the app's userData folder).
// API keys (Sarvam and the AI-narrative providers) are encrypted with the OS keychain via Electron
// safeStorage when available.
import { safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_SETTINGS = {
  pythonPath: '',
  defaultEngine: 'auto',
  sarvamParseLanguage: 'en-IN',
  sarvamChatModel: 'sarvam-105b',
  outputLanguage: 'en-IN',
  aiProvider: 'pollinations',
  aiModels: {},
  ollamaUrl: 'http://localhost:11434',
  customBaseUrl: '',
  translationProvider: 'google_free',
  myMemoryEmail: '',
  libreUrl: '',
  engineOptions: {},   // per local engine tuning: { common: {...}, easyocr: {...}, ... }
};

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'radha-db.json');
    this.data = { settings: { ...DEFAULT_SETTINGS }, apiKey: null, providerKeys: {}, patients: [], reports: [] };
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = {
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
        apiKey: raw.apiKey || null,
        providerKeys: raw.providerKeys || {},
        patients: Array.isArray(raw.patients) ? raw.patients : [],
        reports: Array.isArray(raw.reports) ? raw.reports : [],
      };
      // Existing Sarvam users keep Sarvam as their translator until they choose another.
      if (!raw.settings?.translationProvider && raw.apiKey) this.data.settings.translationProvider = 'sarvam';
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Could not read RADHA database:', err);
    }
    if (this.migratePatients()) await this.save();
    // One-time import: launching with SARVAM_API_KEY set stores the key (encrypted) if none is saved yet.
    if (!this.data.apiKey && process.env.SARVAM_API_KEY && !process.env.RADHA_SMOKE) {
      this.setApiKey(process.env.SARVAM_API_KEY);
      await this.save();
    }
  }

  async save() {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }

  getSettings({ redactKey = false } = {}) {
    const s = { ...this.data.settings };
    if (redactKey) s.hasApiKey = Boolean(this.getApiKey());
    return s;
  }

  async setSettings(patch) {
    const { apiKey, ...rest } = patch || {};
    for (const k of Object.keys(rest)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      this.data.settings[k] = k === 'aiModels' || k === 'engineOptions' ? { ...this.data.settings[k], ...rest[k] } : rest[k];
    }
    if (apiKey !== undefined) this.setApiKey(apiKey);
    await this.save();
    return this.getSettings({ redactKey: true });
  }

  setApiKey(key) {
    this.data.apiKey = seal(key);
  }

  getApiKey() {
    return unseal(this.data.apiKey, 'Sarvam') || process.env.SARVAM_API_KEY || null;
  }

  /** Keys for the AI-narrative providers; Sarvam shares the main Sarvam key. */
  async setProviderKey(id, key) {
    if (id === 'sarvam') this.setApiKey(key);
    else if (key) this.data.providerKeys[id] = seal(key);
    else delete this.data.providerKeys[id];
    await this.save();
  }

  getProviderKey(id) {
    return id === 'sarvam' ? this.getApiKey() : unseal(this.data.providerKeys[id], id);
  }

  listReports() {
    return this.data.reports;
  }

  // ---------------------------------------------------------------- patient profiles

  /** Give every report a patient profile (reports saved before profiles existed are grouped by name). */
  migratePatients() {
    let changed = false;
    for (const r of this.data.reports) {
      if (r.pid && this.data.patients.some((p) => p.id === r.pid)) continue;
      const key = nameKey(r.patient?.name);
      let p = key && this.data.patients.find((x) => nameKey(x.name) === key);
      if (!p) {
        p = newPatient({ name: r.patient?.name || 'Unnamed patient', sex: r.patient?.sex || '', dob: r.patient?.dob || '',
          heightCm: r.patient?.heightCm ?? null, weightKg: r.patient?.weightKg ?? null });
        this.data.patients.push(p);
      }
      if (r.patient?.patientId && !p.labIds.includes(r.patient.patientId)) p.labIds.push(r.patient.patientId);
      r.pid = p.id;
      changed = true;
    }
    return changed;
  }

  listPatients() {
    return this.data.patients;
  }

  async savePatient(patient) {
    const now = new Date().toISOString();
    const i = this.data.patients.findIndex((x) => x.id === patient.id);
    const p = { ...(i >= 0 ? this.data.patients[i] : newPatient({})), ...patient, updatedAt: now };
    if (i >= 0) this.data.patients[i] = p; else this.data.patients.push(p);
    await this.save();
    return p;
  }

  /** Delete a profile; its reports are deleted too, or kept as unassigned. */
  async deletePatient(id, { deleteReports = false } = {}) {
    this.data.patients = this.data.patients.filter((p) => p.id !== id);
    if (deleteReports) this.data.reports = this.data.reports.filter((r) => r.pid !== id);
    else for (const r of this.data.reports) if (r.pid === id) r.pid = null;
    await this.save();
    return true;
  }

  /** Move all reports of `fromId` to `intoId` and remove the duplicate profile. */
  async mergePatients(fromId, intoId) {
    const from = this.data.patients.find((p) => p.id === fromId);
    const into = this.data.patients.find((p) => p.id === intoId);
    if (!from || !into || fromId === intoId) throw new Error('Choose two different patients to merge.');
    for (const r of this.data.reports) if (r.pid === fromId) r.pid = intoId;
    into.labIds = [...new Set([...(into.labIds || []), ...(from.labIds || [])])];
    for (const k of Object.keys(from)) if ((into[k] == null || into[k] === '') && from[k] != null && from[k] !== '') into[k] = from[k];
    into.updatedAt = new Date().toISOString();
    this.data.patients = this.data.patients.filter((p) => p.id !== fromId);
    await this.save();
    return into;
  }

  /** Everything except settings and API keys — for backup files. */
  exportData() {
    return { app: 'RADHA', version: 1, exportedAt: new Date().toISOString(), patients: this.data.patients, reports: this.data.reports };
  }

  /** Merge a backup into the database (same ids are overwritten, new ones added). */
  async importData(data) {
    if (!data || data.app !== 'RADHA' || !Array.isArray(data.patients) || !Array.isArray(data.reports)) {
      throw new Error('This file is not a RADHA backup.');
    }
    const upsert = (list, items) => {
      for (const it of items) {
        if (!it?.id) continue;
        const i = list.findIndex((x) => x.id === it.id);
        if (i >= 0) list[i] = it; else list.push(it);
      }
    };
    upsert(this.data.patients, data.patients);
    upsert(this.data.reports, data.reports);
    this.migratePatients();
    await this.save();
    return { patients: data.patients.length, reports: data.reports.length };
  }

  async saveReport(report) {
    const r = { ...report };
    if (!r.id) r.id = crypto.randomUUID();
    r.savedAt = new Date().toISOString();
    const i = this.data.reports.findIndex((x) => x.id === r.id);
    if (i >= 0) this.data.reports[i] = r; else this.data.reports.push(r);
    await this.save();
    return r;
  }

  async deleteReport(id) {
    this.data.reports = this.data.reports.filter((r) => r.id !== id);
    await this.save();
    return true;
  }
}

function seal(key) {
  if (!key) return null;
  return safeStorage.isEncryptionAvailable()
    ? { enc: true, v: safeStorage.encryptString(key).toString('base64') }
    : { enc: false, v: key };
}

function unseal(k, label) {
  if (!k) return null;
  try {
    return k.enc ? safeStorage.decryptString(Buffer.from(k.v, 'base64')) : k.v;
  } catch (err) {
    // e.g. the keychain entry belongs to a differently signed build: ask for the key again.
    console.error(`Could not decrypt the saved ${label} API key:`, err.message);
    return null;
  }
}

const TITLES = /\b(dr|mr|mrs|ms|miss|smt|shri|master|baby)\b\.?/g;
/** Name comparison key: case, titles, digits and punctuation ignored ("DR. ARJUN MEHTA 123456" = "Arjun Mehta"). */
export function nameKey(name) {
  return String(name || '').toLowerCase().replace(TITLES, ' ').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function newPatient(fields) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), name: '', sex: '', dob: '', bloodGroup: '', phone: '', email: '', address: '',
    heightCm: null, weightKg: null, sbp: null, dbp: null,
    conditions: { diabetes: false, hypertension: false, ckd: false, liver: false, heart: false, thyroid: false },
    bpTreated: false, otherConditions: '', medications: '', allergies: '', familyHistory: '',
    smoking: '', alcohol: '', labIds: [], notes: '', createdAt: now, updatedAt: now,
    ...fields,
  };
}
