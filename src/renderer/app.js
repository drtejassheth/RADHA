// RADHA renderer: ingest → verify (human in the loop) → dashboard / labs / calculators / analysis / trends.
import { BIOMARKERS, BY_KEY, PANELS, fmtRange, normUnit } from '../shared/biomarkers.js';
import { extractReport, extractPatient, cleanText, buildRow, parseDate } from '../shared/extractor.js';
import { runCalculators, CALCULATORS } from '../shared/calculators.js';
import { analyze } from '../shared/analysis.js';
import { DEMO_REPORTS } from './demo.js';
import { buildExportHtml, renderStatusChartImage } from './export.js';
import { LANGUAGES, translateBundle } from './translate.js';

const api = window.radha;

// ------------------------------------------------------------------ state
const state = {
  view: 'ingest',
  settings: {},
  python: null,
  engine: 'auto',
  queue: [],            // {id, fileName, filePath, status, error, engine, draft}
  activeDraftId: null,
  report: null,         // current verified report (saved)
  reports: [],
  lang: 'en-IN',
  translations: {},     // `${reportId}:${lang}` -> translated bundle
  translating: false,
  labFilter: 'all',
  labSearch: '',
  trendKey: null,
  trendMarker: null,
  aiProviders: [],      // narrative-summary providers (from the main process)
  aiModelLists: {},     // providerId -> model ids loaded from the provider
  trServices: [],       // translation services (Google free, Sarvam, MyMemory, …)
  patients: [],         // patient profiles
  activePid: null,      // profile shown in the top bar / used for manual entry
  patientSel: null,     // profile open on the Patients tab
  patientSearch: '',
};
const charts = [];

const VIEW_TITLES = {
  ingest: 'Ingest reports', verify: 'Verify extracted values', dashboard: 'Clinical summary dashboard',
  labs: 'Lab results', calculators: 'Medical calculators', analysis: 'Clinical analysis & action plan',
  trends: 'Multi-year comparison & trends', settings: 'Settings', library: 'Calculator library', patients: 'Patient profiles',
};

const ENGINES = [
  { id: 'sarvam', title: 'Sarvam AI (online)', desc: 'Document AI parse via api.sarvam.ai. Best for complex layouts and Indic text. Sends the PDF to Sarvam.', online: true },
  { id: 'auto', title: 'Local — Auto (recommended)', desc: 'Reads the PDF\'s text layer; only pages without text (scanned) are sent to OCR. Handles digital, scanned and mixed reports.' },
  { id: 'pdfplumber', title: 'Local — pdfplumber', desc: 'Exact text-layer reading for digital PDFs. Fastest and tiny.' },
  { id: 'pymupdf', title: 'Local — PyMuPDF', desc: 'Very fast text-layer reader; a good fallback for unusual PDFs.' },
  { id: 'applevision', title: 'Local — Apple Vision OCR', desc: 'The OCR built into macOS (same as Live Text). Fast, accurate and very light — best OCR choice on a Mac.', mac: true },
  { id: 'easyocr', title: 'Local — EasyOCR', desc: 'Neural OCR for scanned or photographed reports; reads Hindi, Marathi, Bengali, Tamil, Telugu, Kannada and more.' },
  { id: 'docling', title: 'Local — Docling (IBM)', desc: 'Layout-aware table recognition to Markdown; OCRs scanned pages.' },
  { id: 'marker', title: 'Local — Marker (Surya)', desc: 'Surya OCR + layout models. Most robust on messy layouts; heaviest and slowest.' },
];
const LOCAL_IDS = ['pdfplumber', 'pymupdf', 'applevision', 'easyocr', 'docling', 'marker'];
const ESSENTIAL_IDS = ['pdfplumber', 'pymupdf', 'applevision'];

// Tuning options for each local engine (stored in settings.engineOptions). Defaults are tuned for lab reports.
const DEVICE_OPTS = [['auto', 'Automatic (Apple GPU when it helps)'], ['mps', 'Apple GPU (Metal)'], ['cpu', 'CPU only']];
const TUNING = {
  common: [
    { k: 'pages', label: 'Pages to read', type: 'text', def: '', placeholder: 'all — or e.g. 1-3,5', help: 'Skip cover letters, graphs or doctor notes to save time.' },
    { k: 'device', label: 'Processor for AI models (EasyOCR, Docling, Marker)', type: 'select', def: 'auto', options: DEVICE_OPTS },
    { k: 'threads', label: 'CPU threads', type: 'number', def: '', min: 1, max: 32, placeholder: 'automatic' },
    { k: 'lowMemory', label: 'Low-memory mode — smaller batches for EasyOCR, Docling and Marker; slower but safe on 8 GB Macs', type: 'checkbox', def: null },
  ],
  auto: [
    { k: 'textEngine', label: 'Text-layer reader', type: 'select', def: 'pdfplumber', options: [['pdfplumber', 'pdfplumber (most exact)'], ['pymupdf', 'PyMuPDF (fastest)']] },
    { k: 'ocrEngine', label: 'OCR for scanned pages', type: 'select', def: 'best', options: [['best', 'Best installed (Apple Vision → Docling → EasyOCR → Marker)'], ['applevision', 'Apple Vision OCR'], ['easyocr', 'EasyOCR'], ['docling', 'Docling'], ['marker', 'Marker']] },
    { k: 'minChars', label: 'Treat a page as scanned when it has fewer than … characters', type: 'number', def: 60, min: 0, max: 2000 },
  ],
  pdfplumber: [
    { k: 'lineTolerance', label: 'Line tolerance (points) — raise if a test name and its value land on different lines', type: 'number', def: 3, min: 1, max: 15, step: 0.5 },
    { k: 'columnGap', label: 'Column gap (× text height) — lower to split columns more eagerly', type: 'number', def: 1.2, min: 0.3, max: 5, step: 0.1 },
  ],
  applevision: [
    { k: 'languages', label: 'Languages (codes, comma separated)', type: 'langs', def: ['en'], help: 'en, hi (Hindi), mr (Marathi), fr, de, es, pt, it, zh, ja, ko, ru, ar, tr … — English is always read.' },
    { k: 'framework', label: 'Recognizer', type: 'select', def: 'both', options: [['both', 'Vision + Live Text (recommended — catches lone digits like a "0" result)'], ['vision', 'Vision only'], ['livetext', 'Live Text only']] },
    { k: 'level', label: 'Recognition level', type: 'select', def: 'accurate', options: [['accurate', 'Accurate (recommended)'], ['fast', 'Fast (Vision only)']] },
    { k: 'dpi', label: 'Render resolution (DPI)', type: 'number', def: 300, min: 100, max: 600, step: 50 },
    { k: 'enhance', label: 'Enhance image (greyscale, auto-contrast, sharpen) — only for faint, coloured or photographed reports', type: 'checkbox', def: false },
    { k: 'languageCorrection', label: 'Language correction — off keeps abbreviations like HbA1c, SGPT, TSH exactly as printed', type: 'checkbox', def: false },
    { k: 'minConfidence', label: 'Ignore text read with confidence below (0–1)', type: 'number', def: 0, min: 0, max: 1, step: 0.05 },
  ],
  easyocr: [
    { k: 'languages', label: 'Languages (codes, comma separated)', type: 'langs', def: ['en'], help: 'English plus one script: hi, mr, ne (Devanagari) · bn, as · ta · te · kn · ur, ar … Each new language downloads a small model on first use.' },
    { k: 'dpi', label: 'Render resolution (DPI)', type: 'number', def: 300, min: 100, max: 600, step: 50 },
    { k: 'enhance', label: 'Enhance image (greyscale, auto-contrast, sharpen)', type: 'checkbox', def: true },
    { k: 'rotate', label: 'Detect rotated text (photographed / sideways pages) — slower', type: 'checkbox', def: false },
    { k: 'minConfidence', label: 'Ignore text read with confidence below (0–1)', type: 'number', def: 0.2, min: 0, max: 1, step: 0.05 },
    { k: 'textThreshold', label: 'Text detection threshold — lower finds fainter text', type: 'number', def: 0.7, min: 0.3, max: 0.95, step: 0.05 },
    { k: 'lowText', label: 'Low-text bound — lower keeps thin characters', type: 'number', def: 0.4, min: 0.1, max: 0.8, step: 0.05 },
    { k: 'magRatio', label: 'Magnification — raise (1.5–2) for small print', type: 'number', def: 1, min: 0.5, max: 3, step: 0.25 },
  ],
  docling: [
    { k: 'ocr', label: 'OCR', type: 'select', def: 'auto', options: [['auto', 'Only where the PDF has no text (recommended)'], ['force', 'Force full-page OCR (ignore the text layer)'], ['off', 'Off — digital PDFs only (fastest)']] },
    { k: 'ocrEngine', label: 'OCR engine inside Docling', type: 'select', def: 'auto', options: [['auto', 'Automatic (Apple Vision on Mac)'], ['ocrmac', 'Apple Vision'], ['easyocr', 'EasyOCR']] },
    { k: 'languages', label: 'OCR languages', type: 'langs', def: ['en'] },
    { k: 'tableMode', label: 'Table recognition', type: 'select', def: 'accurate', options: [['accurate', 'Accurate (recommended for lab tables)'], ['fast', 'Fast']] },
    { k: 'cellMatching', label: 'Match table cells to PDF text — turn off if values from neighbouring columns get merged', type: 'checkbox', def: true },
    { k: 'imagesScale', label: 'Page image scale for OCR (1 = 72 DPI; 2–3 for small print)', type: 'number', def: 2, min: 1, max: 4, step: 0.5 },
    { k: 'fillGaps', label: 'Fill gaps with RADHA\'s line reader — recovers tests and patient details Docling misses (recommended)', type: 'checkbox', def: true },
  ],
  marker: [
    { k: 'mode', label: 'Mode', type: 'select', def: 'fast', options: [['fast', 'Fast — compact layout + OCR models, CPU friendly (recommended)'], ['no_ocr', 'Text layer only — digital PDFs, lightest'], ['balanced', 'Balanced — adds the Surya vision model for tables/scans (large download, needs a strong GPU)'], ['accurate', 'Accurate — Surya vision model on every page (very slow without a GPU)']] },
    { k: 'fillGaps', label: 'Fill gaps with RADHA\'s line reader (recommended)', type: 'checkbox', def: true },
    { k: 'forceOcr', label: 'Force OCR on every page (ignore the text layer)', type: 'checkbox', def: false },
    { k: 'stripExistingOcr', label: 'Remove a bad existing OCR layer and re-OCR', type: 'checkbox', def: false },
  ],
};
TUNING.pymupdf = TUNING.pdfplumber;


// ------------------------------------------------------------------ helpers
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (s) => document.querySelector(s);

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 8000 : 3500);
}

async function call(promise) {
  const res = await promise;
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

const fmtNum = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return String(a >= 100 ? Math.round(v * 10) / 10 : a >= 10 ? Math.round(v * 100) / 100 : Math.round(v * 1000) / 1000);
};
const statusLabel = (r) => (r.critical ? 'Critical' : { low: 'Low', high: 'High', normal: 'Normal', unknown: 'No range' }[r.status]);
const pill = (r) => h('span', { class: `pill ${r.critical ? 'critical' : r.status}` }, statusLabel(r));
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return Number.isNaN(+d) ? iso : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
};
// Group by name (lab IDs change between visits); fall back to the ID when no name was read.
const patientKey = (p) => {
  const name = (p.name || '').toLowerCase().replace(/\b(dr|mr|mrs|ms|miss|smt|shri)\b\.?/g, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return name ? 'name:' + name : p.patientId ? 'id:' + p.patientId.toLowerCase() : 'unknown';
};
/** Reports are grouped by their patient profile (falling back to the name for unassigned reports). */
const groupKey = (r) => (r.pid ? 'pid:' + r.pid : patientKey(r.patient || {}));
const profileOf = (pid) => state.patients.find((x) => x.id === pid) || null;
const ageAt = (dob, date) => {
  const a = new Date(dob); const b = date ? new Date(date) : new Date();
  if (Number.isNaN(+a) || Number.isNaN(+b)) return null;
  return Math.floor((b - a) / (365.25 * 864e5));
};
const includedRows = (rows) => rows.filter((r) => r.include !== false && r.value != null);

function counts(rows) {
  const c = { total: 0, normal: 0, low: 0, high: 0, unknown: 0, critical: 0 };
  for (const r of includedRows(rows)) { c.total++; c[r.status]++; if (r.critical) c.critical++; }
  return c;
}

function destroyCharts() { while (charts.length) charts.pop().destroy(); }

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ------------------------------------------------------------------ navigation
function setView(v) {
  state.view = v;
  render();
}

function render() {
  destroyCharts();
  document.querySelectorAll('#nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
    if (b.hasAttribute('data-needs-report')) b.disabled = !state.report;
  });
  const ready = state.queue.filter((q) => q.status === 'ready').length;
  const badge = $('#queueBadge');
  badge.hidden = !ready;
  badge.textContent = ready;

  $('#viewTitle').textContent = VIEW_TITLES[state.view];
  const chip = $('#patientChip');
  if (state.report && !['ingest', 'verify', 'settings'].includes(state.view)) {
    const p = state.report.patient;
    chip.hidden = false;
    chip.textContent = [p.name || 'Unnamed patient', p.age ? `${p.age} y` : null, p.sex === 'M' ? 'Male' : p.sex === 'F' ? 'Female' : null, p.date ? `Report ${fmtDate(p.date)}` : null].filter(Boolean).join(' · ');
  } else chip.hidden = true;
  $('#exportBtn').disabled = !state.report;

  const banner = $('#banner');
  const showLangBanner = state.lang !== 'en-IN' && ['analysis', 'calculators', 'dashboard'].includes(state.view);
  banner.hidden = !showLangBanner || (!state.translating && Boolean(currentTranslation()));
  if (!banner.hidden) banner.textContent = state.translating ? `Translating into ${langName(state.lang)} with ${translatorName()}…` : `Showing English — translation into ${langName(state.lang)} is not available yet.`;

  const view = $('#view');
  view.replaceChildren(VIEWS[state.view]());
  view.scrollTop = 0;
}

// ------------------------------------------------------------------ ingest
function viewIngest() {
  const engineCards = ENGINES.filter((e) => !e.mac || state.engineInfo?.platform === 'darwin' || state.python?.platform === 'darwin').map(engineCard);
  const dz = h('div', { class: 'dropzone', tabindex: 0, role: 'button', 'aria-label': 'Choose or drop PDF reports',
    onclick: async () => addFiles(await call(api.openPdfDialog())),
    onkeydown: async (e) => { if (e.key === 'Enter' || e.key === ' ') addFiles(await call(api.openPdfDialog())); },
    ondragover: (e) => { e.preventDefault(); dz.classList.add('over'); },
    ondragleave: () => dz.classList.remove('over'),
    ondrop: (e) => {
      e.preventDefault(); dz.classList.remove('over');
      const paths = [...e.dataTransfer.files].filter((f) => /\.pdf$/i.test(f.name)).map((f) => api.pathForFile(f));
      if (!paths.length) toast('Please drop PDF files.', true); else addFiles(paths);
    },
  },
  h('div', { class: 'big' }, '⬆'),
  h('div', { style: { fontSize: '16px', fontWeight: 600 } }, 'Drag & drop blood test PDFs here'),
  h('div', { class: 'muted' }, 'or click to browse. Add several years at once to unlock the trend view.'));

  const queue = state.queue.length ? h('div', { class: 'card mt' }, h('h2', {}, 'Processing queue'),
    state.queue.map((q) => h('div', { class: 'queue-item' },
      q.status === 'parsing' ? h('span', { class: 'spinner' }) : h('span', {}, q.status === 'error' ? '⚠' : q.status === 'done' ? '✓' : '●'),
      h('div', { style: { flex: 1 } }, h('div', {}, q.fileName),
        h('div', { class: 'small muted' }, q.status === 'parsing' ? `Parsing with ${q.engine}…` : q.status === 'error' ? q.error :
          q.status === 'done' ? 'Verified and saved' : `${q.draft.rows.length} tests extracted with ${q.engine} — waiting for verification`)),
      q.status === 'ready' ? h('button', { class: 'btn small primary', onclick: () => { state.activeDraftId = q.id; setView('verify'); } }, 'Verify') : null,
      q.status === 'error' || q.status === 'done' ? h('button', { class: 'btn small', onclick: () => { state.queue = state.queue.filter((x) => x !== q); render(); } }, 'Remove') : null,
    ))) : null;

  return h('div', {},
    dz,
    h('div', { class: 'row mt' },
      h('button', { class: 'btn', onclick: startManual }, '✎ Manual entry'),
      h('button', { class: 'btn', onclick: loadDemo }, '▶ Load demo reports (2 years)'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'link small', onclick: refreshPython }, 'Re-check local engines')),
    queue,
    h('div', { class: 'card mt' }, h('h2', {}, 'Parsing engine'), installBar(),
      h('div', { class: 'engine-grid wide' }, engineCards),
      h('p', { class: 'small muted' }, pythonLine())),
    h('div', { class: 'disclaimer mt' }, h('b', {}, 'Privacy: '),
      'Local engines keep the report on this computer. The Sarvam AI engine sends the PDF to Sarvam AI. Translation and the optional AI narrative go to the services you choose in Settings (Ollama stays on this computer); they never include the patient name or ID.'),
  );
}

function anyLocalEngine() {
  const e = state.python?.engines;
  return Boolean(e && Object.values(e).some(Boolean));
}

const fmtMB = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(mb >= 10000 ? 0 : 1)} GB` : `${Math.max(1, Math.round(mb))} MB`);
const engineMeta = (id) => state.engineInfo?.list?.find((x) => x.id === id);
const isInstalled = (id) => Boolean(state.python?.engines?.[id]);
const installing = (id) => Boolean(state.install && state.install.ids.includes(id));

function engineCard(e) {
  const avail = e.online ? state.settings.hasApiKey : e.id === 'auto' ? anyLocalEngine() : isInstalled(e.id);
  const meta = engineMeta(e.id);
  const totalMB = state.engineInfo?.totalMemMB || 0;
  const heavy = meta && totalMB && meta.ramMB > totalMB * 0.45;
  let status;
  let color = avail ? 'var(--normal)' : 'var(--warn)';
  if (e.online) status = state.settings.hasApiKey ? 'API key configured' : 'Needs API key (Settings)';
  else if (state.python == null) status = 'Checking…';
  else if (installing(e.id)) { status = 'Installing…'; color = 'var(--accent)'; }
  else if (e.id === 'auto') status = !avail ? 'Install any local engine below' : ocrForAuto() ? `Ready — text layer + ${ocrForAuto()}` : 'Ready for digital PDFs — install an OCR engine for scanned ones';
  else if (avail) status = `Installed · uses ≈ ${fmtMB(meta?.ramMB || 0)} memory while reading`;
  else status = meta ? `Not installed · ≈ ${fmtMB(meta.diskMB)} download · needs ≈ ${fmtMB(meta.ramMB)} memory` : 'Not installed';

  const stop = (fn) => (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(); };
  const actions = [];
  if (!e.online && e.id !== 'auto' && !avail && meta && !state.install) actions.push(h('button', { class: 'btn small primary', onclick: stop(() => installEngines([e.id])) }, '⬇ Install'));
  if (!e.online && (avail || e.id === 'auto') && TUNING[e.id]) actions.push(h('button', { class: 'btn small', onclick: stop(() => openTuneModal(e.id)) }, '⚙ Tune'));

  return h('label', { class: 'engine' + (avail ? '' : ' unavailable') },
    h('input', { type: 'radio', name: 'engine', value: e.id, checked: state.engine === e.id, onchange: () => { state.engine = e.id; api.setSettings({ defaultEngine: e.id }); } }),
    h('div', { style: { flex: 1 } }, h('div', { class: 't' }, e.title), h('div', { class: 'd' }, e.desc),
      h('div', { class: 's', style: { color } }, status),
      heavy && !avail ? h('div', { class: 's', style: { color: 'var(--warn)' } }, `Heavy for this computer (${fmtMB(totalMB)} RAM) — low-memory mode will be used.`) : null,
      actions.length ? h('div', { class: 'row engine-actions' }, actions) : null));
}

function ocrForAuto() {
  const e = state.python?.engines || {};
  const o = state.settings.engineOptions?.auto?.ocrEngine;
  const name = (id) => ENGINES.find((x) => x.id === id)?.title.replace('Local — ', '').replace(/ OCR$/, '');
  if (o && o !== 'best') return e[o] ? `${name(o)} OCR` : null;
  const id = ['applevision', 'docling', 'easyocr', 'marker'].find((k) => e[k]);
  return id ? `${name(id)} OCR for scanned pages` : null;
}

function pythonLine() {
  const p = state.python;
  if (!p) return '';
  if (p.error) return p.managed === false ? `Local engines unavailable: ${p.error}` : 'No local engines yet — install them with the buttons above (nothing else to set up).';
  const used = state.engineInfo?.usage?.totalMB;
  return p.managed ? `RADHA engine environment · Python ${p.python}${used ? ` · ${fmtMB(used)} on disk` : ''} · remove or change in Settings`
    : `Python ${p.python} (${p.executable}) — one-click installs go into RADHA's own Python 3.12 environment.`;
}

function installBar() {
  const ins = state.install;
  if (ins) {
    return h('div', { class: 'install-panel' },
      h('div', { class: 'row' }, h('span', { class: 'spinner' }),
        h('b', {}, `Installing ${ins.ids.map((id) => engineMeta(id)?.label || id).join(', ')}`),
        h('span', { class: 'spacer' }), h('span', { class: 'small muted' }, `Step ${Math.min(ins.step || 1, ins.total || 1)} of ${ins.total || '…'}`),
        h('button', { class: 'btn small', onclick: () => api.cancelEngineInstall() }, 'Cancel')),
      h('div', { class: 'progress' }, h('div', { class: 'bar', style: { width: `${Math.round(100 * Math.min(ins.step || 0, ins.total || 1) / (ins.total || 1))}%` } })),
      h('div', { class: 'small', id: 'install-msg' }, ins.message || 'Starting…'),
      h('div', { class: 'small muted mono', id: 'install-line' }, ins.line || ''),
      h('div', { class: 'small muted' }, 'You can keep using RADHA while this runs. Large downloads (PyTorch, models) can take several minutes.'));
  }
  if (state.python == null) return null;
  const missing = LOCAL_IDS.filter((id) => engineMeta(id) && !isInstalled(id));
  if (!missing.length) return null;
  const est = state.engineInfo?.estimates || {};
  const essentials = ESSENTIAL_IDS.filter((id) => missing.includes(id) && engineMeta(id));
  const peak = Math.max(...missing.map((id) => engineMeta(id)?.ramMB || 0));
  return h('div', { class: 'install-panel' },
    h('div', { class: 'small' }, h('b', {}, 'Local engines run on this computer — reports never leave it. '),
      'Install them with one click; RADHA sets up its own private Python, nothing else to configure.'),
    h('div', { class: 'row mt' },
      essentials.length ? h('button', { class: 'btn small primary', onclick: () => installEngines(essentials) },
        `⬇ Install essentials (${essentials.map((id) => engineMeta(id).label).join(', ')}) · ≈ ${fmtMB(est.essentials || 0)}`) : null,
      h('button', { class: essentials.length ? 'btn small' : 'btn small primary', onclick: () => installEngines(missing) },
        `⬇ Install all ${missing.length === LOCAL_IDS.filter(engineMeta).length ? 'local engines' : `${missing.length} missing engines`} · ≈ ${fmtMB(est.all || 0)} download`)),
    h('div', { class: 'small muted mt' }, `Memory while reading a report: ${(state.engineInfo?.list || []).map((m) => `${m.label} ≈ ${fmtMB(m.ramMB)}`).join(', ')}. `,
      state.engineInfo?.totalMemMB ? `This computer has ${fmtMB(state.engineInfo.totalMemMB)} RAM.` : '',
      peak > (state.engineInfo?.totalMemMB || Infinity) * 0.45 ? ' Heavy engines run in low-memory mode automatically.' : ''));
}

async function refreshPython() {
  try { state.python = await call(api.checkPython()); } catch (err) { state.python = { error: err.message, engines: {} }; }
  try {
    const installed = state.python?.engines || {};
    state.engineInfo = await call(api.enginesInfo(installed));
    if (state.engineInfo.status?.busy && !state.install) state.install = { ids: state.engineInfo.status.ids, step: 1, total: 1 };
  } catch { /* older main process */ }
  if (state.view === 'ingest' || state.view === 'settings') render();
}

async function installEngines(ids) {
  if (state.install) return;
  state.install = { ids, step: 0, total: ids.length + 2, message: 'Starting…', local: true };
  render();
  try {
    await call(api.installEngines(ids));
    toast(`Installed ${ids.map((id) => engineMeta(id)?.label || id).join(', ')}.`);
  } catch (err) {
    if (!/cancel/i.test(err.message)) toast(`Installation failed: ${err.message}`, true);
    else toast('Installation cancelled.');
  }
  state.install = null;
  try { state.settings = await call(api.getSettings()); } catch { /* keep */ }
  await refreshPython();
  render();
}

function onEngineProgress(p) {
  if (p.phase === 'done' || p.phase === 'error') {
    // installEngines() normally finishes the job; this covers installs started elsewhere (e.g. before a reload).
    setTimeout(() => { if (state.install && !state.install.local) { state.install = null; refreshPython(); } }, 300);
    return;
  }
  if (!state.install) state.install = { ids: p.ids };
  const phaseChanged = p.step !== state.install.step || (p.message && p.message !== state.install.message);
  Object.assign(state.install, { ids: p.ids, step: p.step, total: p.total });
  if (p.message) state.install.message = p.message;
  if (p.line) state.install.line = p.line.slice(0, 220);
  if (state.view !== 'ingest') return;
  const line = document.getElementById('install-line');
  if (!phaseChanged && line) { line.textContent = state.install.line; return; }
  const view = document.getElementById('view');
  const top = view?.scrollTop;
  render();
  if (view) view.scrollTop = top;
}

// ------------------------------------------------------------------ engine tuning
function tuneValues(id) {
  const saved = state.settings.engineOptions?.[id] || {};
  const lowMemDefault = (state.engineInfo?.totalMemMB || 16000) <= 9000;
  const out = {};
  for (const f of TUNING[id] || []) out[f.k] = saved[f.k] ?? (f.k === 'lowMemory' ? lowMemDefault : f.def);
  return out;
}

function tuneField(f, value) {
  let input;
  if (f.type === 'checkbox') input = h('input', { type: 'checkbox', checked: Boolean(value) });
  else if (f.type === 'select') {
    input = h('select', {}, f.options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  } else {
    input = h('input', { type: f.type === 'number' ? 'number' : 'text', value: f.type === 'langs' ? (value || []).join(', ') : value ?? '',
      placeholder: f.placeholder || '', min: f.min, max: f.max, step: f.step || 'any', style: { width: f.type === 'number' ? '120px' : '100%' } });
  }
  const read = () => {
    if (f.type === 'checkbox') return input.checked;
    if (f.type === 'number') return input.value === '' ? (f.def === '' ? '' : f.def) : Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, Number(input.value)));
    if (f.type === 'langs') { const l = input.value.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean); return l.length ? [...new Set(l)] : ['en']; }
    return input.value;
  };
  const set = (v) => { if (f.type === 'checkbox') input.checked = Boolean(v); else input.value = f.type === 'langs' ? (v || []).join(', ') : v ?? ''; };
  const row = f.type === 'checkbox'
    ? h('label', { class: 'tune-row check' }, input, h('span', {}, f.label))
    : h('label', { class: 'tune-row' }, h('span', {}, f.label), input);
  if (f.help) row.append(h('div', { class: 'small muted' }, f.help));
  return { f, row, read, set };
}

function openTuneModal(id) {
  closeModal();
  const eng = ENGINES.find((e) => e.id === id);
  const own = (TUNING[id] || []).map((f) => tuneField(f, tuneValues(id)[f.k]));
  const common = TUNING.common.map((f) => tuneField(f, tuneValues('common')[f.k]));
  const result = h('div', {});
  const values = (fields) => Object.fromEntries(fields.map((x) => [x.f.k, x.read()]));
  const save = async (quiet) => {
    state.settings = await call(api.setSettings({ engineOptions: { [id]: values(own), common: values(common) } }));
    if (!quiet) toast(`${eng.title.replace('Local — ', '')} settings saved.`);
  };
  const reset = () => {
    for (const x of own) x.set(x.f.def);
    for (const x of common) x.set(x.f.k === 'lowMemory' ? (state.engineInfo?.totalMemMB || 16000) <= 9000 : x.f.def);
  };
  const test = async () => {
    const files = await call(api.openPdfDialog());
    if (!files?.length) return;
    await save(true);
    result.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'spinner' }), `Reading ${files[0].split(/[\\/]/).pop()} with ${eng.title.replace('Local — ', '')}…`));
    const t0 = performance.now();
    try {
      const parsed = await call(api.parsePdf(files[0], id));
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      const ex = extractReport(parsed.text || '');
      result.replaceChildren(
        h('div', { class: 'tune-result' },
          h('div', {}, h('b', {}, `${ex.rows.length} tests recognised`), ` · ${parsed.pages ?? '?'} page(s) · ${secs} s · engine: ${parsed.engine}`),
          ex.patient?.name ? h('div', { class: 'small muted' }, `Patient: ${ex.patient.name}${ex.patient.date ? ` · report date ${fmtDate(ex.patient.date)}` : ''}`) : null,
          (parsed.warnings || []).map((w) => h('div', { class: 'small', style: { color: 'var(--warn)' } }, w)),
          h('details', {}, h('summary', { class: 'small' }, 'Show the text the engine read'), h('pre', { class: 'raw-preview' }, (parsed.text || '').slice(0, 6000)))));
    } catch (err) {
      result.replaceChildren(h('div', { style: { color: 'var(--crit)' } }, err.message));
    }
  };
  const box = h('div', { class: 'modal card' },
    h('h2', {}, `Tune ${eng.title.replace('Local — ', '')}`),
    h('p', { class: 'small muted' }, eng.desc),
    own.length ? h('div', { class: 'tune-grid' }, own.map((x) => x.row)) : null,
    h('h3', { style: { marginTop: '22px' } }, 'All local engines'),
    h('div', { class: 'tune-grid' }, common.map((x) => x.row)),
    h('div', { class: 'row mt' },
      h('button', { class: 'btn small', onclick: reset }, 'Reset to recommended'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => test().catch((e) => toast(e.message, true)) }, '🧪 Test on a report…'),
      h('button', { class: 'btn small primary', onclick: async () => { await save(); closeModal(); render(); } }, 'Save')),
    result);
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (ev) => { if (ev.target === backdrop) closeModal(); } },
    h('div', { class: 'modal-wrap' }, h('button', { class: 'btn small modal-close', onclick: closeModal }, '✕ Close'), box));
  document.body.append(backdrop);
}

let qid = 0;
async function addFiles(paths) {
  if (!paths?.length) return;
  const engine = state.engine;
  const items = paths.map((p) => ({ id: ++qid, fileName: p.split(/[\\/]/).pop(), filePath: p, status: 'parsing', engine }));
  state.queue.push(...items);
  render();
  await Promise.all(items.map(async (q) => {
    try {
      const parsed = await call(api.parsePdf(q.filePath, engine));
      q.engine = parsed.engine || engine;
      q.draft = makeDraft(parsed.text, { fileName: q.fileName, engine: q.engine, warnings: parsed.warnings });
      q.status = 'ready';
    } catch (err) {
      q.status = 'error';
      q.error = err.message;
    }
    if (state.view === 'ingest') render();
  }));
  const first = state.queue.find((q) => q.status === 'ready');
  if (first && state.view === 'ingest') { state.activeDraftId = first.id; setView('verify'); } else render();
}

function makeDraft(text, source) {
  const ex = extractReport(text || '');
  return {
    patient: { ...ex.patient, diabetes: '' },
    rows: ex.rows,
    rawText: ex.text,
    source,
    pid: matchProfile(ex.patient),
  };
}

/** Existing profile for a report: same lab ID, else same name (titles/digits ignored); otherwise 'new'. */
function matchProfile(p) {
  const byId = p.patientId && state.patients.find((x) => (x.labIds || []).includes(p.patientId));
  if (byId) return byId.id;
  const key = patientKey({ name: p.name });
  const byName = key !== 'unknown' && state.patients.find((x) => patientKey({ name: x.name }) === key);
  return byName ? byName.id : 'new';
}

/** Re-open a saved report on the Verify screen to correct values or details. */
function editReport(r) {
  const q = { id: ++qid, fileName: r.source?.fileName || 'Saved report', status: 'ready', engine: 'edit',
    draft: { patient: { ...r.patient }, rows: r.rows.map((x) => ({ ...x })), rawText: r.rawText || '', source: r.source || { fileName: 'Saved report', engine: 'edit' },
      pid: r.pid || matchProfile(r.patient), reportId: r.id, createdAt: r.createdAt, calcInputs: r.calcInputs, narrative: r.narrative } };
  state.queue.push(q);
  state.activeDraftId = q.id;
  setView('verify');
}

function startManual() {
  const q = { id: ++qid, fileName: 'Manual entry', status: 'ready', engine: 'manual',
    draft: { patient: { name: '', age: null, sex: '', date: new Date().toISOString().slice(0, 10), patientId: '', heightCm: null, weightKg: null, diabetes: '' }, rows: [], rawText: '', source: { fileName: 'Manual entry', engine: 'manual' }, pid: state.activePid || 'new' } };
  const prof = profileOf(state.activePid);
  if (prof) Object.assign(q.draft.patient, { name: prof.name, sex: prof.sex, heightCm: prof.heightCm, weightKg: prof.weightKg, dob: prof.dob, age: prof.dob ? ageAt(prof.dob) : null });
  state.queue.push(q);
  state.activeDraftId = q.id;
  setView('verify');
}

function loadDemo() {
  for (const d of DEMO_REPORTS) {
    state.queue.push({ id: ++qid, fileName: d.fileName, status: 'ready', engine: d.engine, draft: makeDraft(d.text, { fileName: d.fileName, engine: d.engine }) });
  }
  state.activeDraftId = state.queue.find((q) => q.status === 'ready').id;
  toast('Two demo reports loaded. Verify each one to continue.');
  setView('verify');
}

// ------------------------------------------------------------------ verify (human in the loop)
const UNIT_OPTIONS = (key) => {
  const b = BY_KEY[key];
  if (!b) return [];
  const pretty = { 'mg/dl': 'mg/dL', 'mmol/l': 'mmol/L', 'umol/l': 'µmol/L', 'g/dl': 'g/dL', 'g/l': 'g/L', 'ng/ml': 'ng/mL', 'nmol/l': 'nmol/L', 'pmol/l': 'pmol/L', 'pg/ml': 'pg/mL', 'ug/dl': 'µg/dL', 'u/l': 'U/L', 'iu/l': 'IU/L', 'mg/l': 'mg/L', 'uiu/ml': 'µIU/mL', 'miu/l': 'mIU/L', 'mg/g': 'mg/g', 'mg/mmol': 'mg/mmol', 'meq/l': 'mEq/L', 'ng/dl': 'ng/dL', 'mmol/mol': 'mmol/mol' };
  const seen = new Set();
  return [b.unit, ...Object.keys(b.conv).map((u) => pretty[u] || u)].filter((u) => u && !seen.has(normUnit(u)) && seen.add(normUnit(u)));
};

function activeDraft() { return state.queue.find((q) => q.id === state.activeDraftId && q.status === 'ready'); }

function viewVerify() {
  let q = activeDraft();
  if (!q) {
    q = state.queue.find((x) => x.status === 'ready');
    if (q) state.activeDraftId = q.id;
  }
  if (!q) {
    return h('div', { class: 'empty' }, h('div', { class: 'big' }, '✎'), h('div', {}, 'Nothing waiting for verification.'),
      h('div', { class: 'row mt', style: { justifyContent: 'center' } }, h('button', { class: 'btn primary', onclick: () => setView('ingest') }, 'Ingest a report'), h('button', { class: 'btn', onclick: startManual }, 'Manual entry')));
  }
  const d = q.draft;
  const p = d.patient;
  const pending = state.queue.filter((x) => x.status === 'ready');
  const rebuildAll = () => { d.rows = d.rows.map((r) => rebuild(r, p.sex)); };

  const field = (label, input) => h('label', {}, label, input);
  // Re-match until the user picks: profiles created by earlier reports in the same batch count.
  if (!d.pidChosen) d.pid = matchProfile(p);
  const chosen = profileOf(d.pid);
  const useProfile = (id) => {
    d.pid = id;
    d.pidChosen = true;
    const prof = profileOf(id);
    if (prof) {
      // Fill what the report did not print; never overwrite values read from the report.
      for (const [k, v] of [['sex', prof.sex], ['heightCm', prof.heightCm], ['weightKg', prof.weightKg], ['dob', prof.dob]]) if ((p[k] == null || p[k] === '') && v) p[k] = v;
      if ((p.age == null || p.age === '') && p.dob) p.age = ageAt(p.dob, p.date);
      rebuildAll();
    }
    render();
  };
  const patientForm = h('div', { class: 'card' },
    h('div', { class: 'row mb' }, h('h2', { style: { margin: 0 } }, d.reportId ? 'Edit saved report' : 'Patient profile'), h('span', { class: 'spacer' }),
      h('span', { class: 'small muted' }, `Source: ${d.source.fileName} · ${d.source.engine}`)),
    h('div', { class: 'row mb' },
      h('span', { class: 'small muted' }, 'Save this report under'),
      h('select', { onchange: (e) => useProfile(e.target.value) },
        h('option', { value: 'new', selected: d.pid === 'new' }, `➕ New patient${p.name ? `: ${p.name}` : ''}`),
        [...state.patients].sort((a, b) => a.name.localeCompare(b.name)).map((x) => h('option', { value: x.id, selected: x.id === d.pid },
          `${x.name}${x.dob ? ` · born ${x.dob}` : ''}${(x.labIds || []).length ? ` · ID ${x.labIds[0]}` : ''}`))),
      chosen ? h('span', { class: 'small', style: { color: 'var(--normal)' } }, '✓ matched existing profile — gaps filled from it') : h('span', { class: 'small muted' }, 'a new profile will be created')),
    h('div', { class: 'form-grid' },
      field('Name', h('input', { type: 'text', value: p.name, oninput: (e) => { p.name = e.target.value; } })),
      field('Age (years)', h('input', { type: 'number', min: 0, max: 120, value: p.age ?? '', oninput: (e) => { p.age = e.target.value === '' ? null : +e.target.value; } })),
      field('Sex', h('select', { onchange: (e) => { p.sex = e.target.value; rebuildAll(); render(); } },
        h('option', { value: '', selected: !p.sex }, '— select —'), h('option', { value: 'M', selected: p.sex === 'M' }, 'Male'), h('option', { value: 'F', selected: p.sex === 'F' }, 'Female'))),
      field('Report date', h('input', { type: 'date', value: p.date || '', oninput: (e) => { p.date = e.target.value; } })),
      field('Date of birth', h('input', { type: 'date', value: p.dob || '', oninput: (e) => { p.dob = e.target.value; } })),
      field('Patient ID / UHID', h('input', { type: 'text', value: p.patientId || '', oninput: (e) => { p.patientId = e.target.value; } })),
      field('Height (cm)', h('input', { type: 'number', min: 50, max: 250, value: p.heightCm ?? '', oninput: (e) => { p.heightCm = e.target.value === '' ? null : +e.target.value; } })),
      field('Weight (kg)', h('input', { type: 'number', min: 2, max: 400, value: p.weightKg ?? '', oninput: (e) => { p.weightKg = e.target.value === '' ? null : +e.target.value; } })),
      field('Known diabetes / IFG', h('select', { onchange: (e) => { p.diabetes = e.target.value === '' ? '' : e.target.value === 'yes'; } },
        h('option', { value: '', selected: p.diabetes === '' }, 'Auto (from labs)'), h('option', { value: 'yes', selected: p.diabetes === true }, 'Yes'), h('option', { value: 'no', selected: p.diabetes === false }, 'No')))),
    !p.sex || !p.age ? h('p', { class: 'small', style: { color: 'var(--warn)', marginBottom: 0 } }, 'Age and sex are needed for sex-specific ranges and calculators such as eGFR and FIB-4.') : null);

  const testSelect = (r) => {
    const sel = h('select', { onchange: (e) => {
      const key = e.target.value;
      Object.assign(r, rebuild({ ...r, key, rawName: BY_KEY[key]?.name || r.rawName }, p.sex));
      render();
    } });
    if (!BY_KEY[r.key]) sel.append(h('option', { value: r.key, selected: true }, `Other: ${r.rawName}`));
    for (const panel of PANELS) {
      const og = h('optgroup', { label: panel });
      for (const b of BIOMARKERS.filter((x) => x.panel === panel)) og.append(h('option', { value: b.key, selected: b.key === r.key }, b.name));
      sel.append(og);
    }
    return sel;
  };

  const numInput = (r, field, ph) => h('input', { type: 'number', step: 'any', value: r[field] ?? '', placeholder: ph || '',
    onchange: (e) => { r[field] = e.target.value === '' ? null : parseFloat(e.target.value); Object.assign(r, rebuild(r, p.sex)); render(); } });

  const rowsEl = d.rows.map((r, i) => {
    const listId = `units-${i}`;
    return h('tr', { class: (r.include === false ? 'excluded ' : '') + (r.critical ? 'abn-crit' : r.status === 'low' ? 'abn-low' : r.status === 'high' ? 'abn-high' : '') },
      h('td', {}, h('input', { type: 'checkbox', checked: r.include !== false, title: 'Include in analysis', onchange: (e) => { r.include = e.target.checked; render(); } })),
      h('td', { style: { minWidth: '190px' } }, testSelect(r), r.rawName && BY_KEY[r.key] && r.rawName.toLowerCase() !== r.name.toLowerCase() ? h('div', { class: 'small muted' }, `as printed: “${r.rawName}”`) : null),
      h('td', { style: { width: '95px' } }, numInput(r, 'rawValue')),
      h('td', { style: { width: '110px' } }, h('input', { type: 'text', list: listId, value: r.rawUnit || '', placeholder: BY_KEY[r.key]?.unit || '',
        onchange: (e) => { r.rawUnit = e.target.value.trim(); Object.assign(r, rebuild(r, p.sex)); render(); } }),
        h('datalist', { id: listId }, UNIT_OPTIONS(r.key).map((u) => h('option', { value: u })))),
      h('td', { style: { width: '100px' } }, numInput(r, 'rawLow', r.rangeSource === 'default' && r.low != null ? `${fmtNum(r.low)}` : '')),
      h('td', { style: { width: '100px' } }, numInput(r, 'rawHigh', r.rangeSource === 'default' && r.high != null ? `${fmtNum(r.high)}` : '')),
      h('td', { class: 'num' }, h('b', {}, fmtNum(r.value)), ' ', h('span', { class: 'muted small' }, r.unit === 'ratio' ? '' : r.unit),
        h('div', { class: 'small muted' }, `ref ${fmtRange(r.low != null ? fmtNum(r.low) : null, r.high != null ? fmtNum(r.high) : null)}${r.rangeSource === 'default' ? ' (default)' : ''}`),
        r.converted ? h('div', { class: 'small', style: { color: 'var(--accent)' } }, `converted from ${r.rawUnit}`) : null,
        r.unitWarning ? h('div', { class: 'warn-cell' }, `⚠ unit “${r.rawUnit}” not recognised — check value`) : null),
      h('td', {}, pill(r)),
      h('td', {}, h('button', { class: 'btn small danger', title: 'Remove row', onclick: () => { d.rows.splice(i, 1); render(); } }, '✕')));
  });

  const addRow = () => {
    const used = new Set(d.rows.map((r) => r.key));
    const key = BIOMARKERS.find((b) => !used.has(b.key))?.key || 'hemoglobin';
    d.rows.push(buildRow({ key, rawName: BY_KEY[key].name, value: null, unit: BY_KEY[key].unit, source: 'manual' }, p.sex));
    render();
    const view = $('#view'); view.scrollTop = view.scrollHeight;
  };

  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'verify-table' },
    h('thead', {}, h('tr', {}, ['', 'Test', 'Value', 'Unit', 'Ref low', 'Ref high', 'Normalized (standard unit)', 'Status', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rowsEl.length ? rowsEl : h('tr', {}, h('td', { colspan: 9, class: 'muted', style: { textAlign: 'center', padding: '24px' } }, 'No tests yet — use “Add test”.')))));

  const warnings = d.source.warnings?.length ? h('div', { class: 'banner', style: { margin: '0 0 12px' } }, d.source.warnings.join(' ')) : null;
  const unitIssues = d.rows.filter((r) => r.unitWarning && r.include !== false).length;

  return h('div', {},
    pending.length > 1 ? h('div', { class: 'row mb' }, h('span', { class: 'muted' }, 'Reports waiting:'),
      pending.map((x) => h('button', { class: 'btn small' + (x.id === q.id ? ' primary' : ''), onclick: () => { state.activeDraftId = x.id; render(); } }, x.fileName))) : null,
    warnings,
    patientForm,
    h('div', { class: 'grid mt', style: { gridTemplateColumns: d.rawText ? 'minmax(0, 3fr) minmax(0, 1.2fr)' : '1fr' } },
      h('div', {},
        h('div', { class: 'row mb' }, h('h2', { style: { margin: 0, fontSize: '15px' } }, `${d.rows.length} tests extracted`),
          h('span', { class: 'small muted' }, 'Edit anything that looks wrong. Values are converted to standard units automatically.'),
          h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: addRow }, '+ Add test')),
        table,
        h('div', { class: 'row mt' },
          h('button', { class: 'btn danger', onclick: () => { if (confirm('Discard this report?')) { state.queue = state.queue.filter((x) => x !== q); render(); } } }, 'Discard'),
          h('span', { class: 'spacer' }),
          unitIssues ? h('span', { class: 'small', style: { color: 'var(--warn)' } }, `${unitIssues} unit(s) need checking`) : null,
          h('button', { class: 'btn primary', onclick: () => confirmDraft(q) }, pending.length > 1 ? 'Confirm & verify next →' : 'Confirm & analyse →'))),
      d.rawText ? h('details', { class: 'card', open: true }, h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, 'Extracted text (for comparison)'),
        h('div', { class: 'raw-text mt' }, d.rawText)) : null),
  );
}

function rebuild(r, sex) {
  const nr = buildRow({ key: r.key, rawName: r.rawName, value: r.rawValue, unit: r.rawUnit, low: r.rawLow, high: r.rawHigh, qualifier: r.qualifier, flag: r.flag, source: r.source }, sex);
  nr.include = r.include;
  return nr;
}

/** Create the profile for a new patient, or add what this report teaches us to the existing one. */
async function upsertProfileFromDraft(d) {
  const p = d.patient;
  let prof = profileOf(d.pid);
  if (!prof) {
    prof = { name: p.name || 'Unnamed patient', sex: p.sex || '', dob: p.dob || '', heightCm: p.heightCm ?? null, weightKg: p.weightKg ?? null,
      measuredOn: p.date || '', labIds: p.patientId ? [p.patientId] : [],
      conditions: { diabetes: p.diabetes === true, hypertension: false, ckd: false, liver: false, heart: false, thyroid: false } };
  } else {
    prof = { ...prof, labIds: [...new Set([...(prof.labIds || []), ...(p.patientId ? [p.patientId] : [])])] };
    if (!prof.sex && p.sex) prof.sex = p.sex;
    if (!prof.dob && p.dob) prof.dob = p.dob;
    // Height/weight: keep the most recent measurement.
    const latest = !prof.measuredOn || (p.date && p.date >= prof.measuredOn);
    if (latest && p.heightCm) { prof.heightCm = p.heightCm; prof.measuredOn = p.date; }
    if (latest && p.weightKg) { prof.weightKg = p.weightKg; prof.measuredOn = p.date; }
  }
  const saved = await call(api.savePatient(prof));
  d.pid = saved.id;
  return saved.id;
}

async function confirmDraft(q) {
  const d = q.draft;
  const p = d.patient;
  const valid = d.rows.filter((r) => r.include !== false && r.value != null);
  if (!valid.length) { toast('Add at least one test value before confirming.', true); return; }
  if (!p.date) { toast('Please enter the report date — it is needed for trends.', true); return; }
  if (p.date && !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) p.date = parseDate(p.date) || p.date;

  try {
    if (!d.pidChosen) d.pid = matchProfile(p);
    const pid = await upsertProfileFromDraft(d);
    const report = { ...buildReport({ id: d.reportId, pid, patient: { ...p }, rows: d.rows.map((r) => ({ ...r })), source: d.source, rawText: d.rawText, createdAt: d.createdAt, calcInputs: d.calcInputs || {} }),
      ...(d.narrative ? { narrative: d.narrative } : {}) };
    const saved = await call(api.saveReport(report));
    await reloadReports();
    state.report = state.reports.find((x) => x.id === saved.id) || saved;
    state.trendKey = groupKey(saved);
    state.activePid = saved.pid;
    for (const k of Object.keys(state.translations)) if (k.startsWith(saved.id + ':')) delete state.translations[k];
    q.status = 'done';
    q.draft = null;
    const next = state.queue.find((x) => x.status === 'ready');
    if (next) { state.activeDraftId = next.id; toast('Saved. Verify the next report.'); setView('verify'); }
    else {
      // After a batch, open the most recent and most complete report for this patient.
      const same = sameGroup(saved);
      const latest = same.filter((x) => x.patient.date === same[same.length - 1].patient.date);
      state.report = latest.reduce((a, b) => (includedRows(b.rows).length > includedRows(a.rows).length ? b : a));
      toast('Report verified and analysed.');
      setView('dashboard');
    }
    maybeTranslate();
  } catch (err) { toast('Could not save report: ' + err.message, true); }
}

function buildReport({ id, pid, patient, rows, source, rawText, createdAt, calcInputs = {} }) {
  const prof = profileOf(pid);
  const pe = effectivePatient(patient, prof);
  const calc = runCalculators(rows, pe, withProfileInputs(calcInputs, prof));
  const analysis = analyze(rows, pe, calc.filter((c) => c.ready), previousVisit({ id, pid, patient }));
  return { id, pid, patient, rows, source, rawText, calcInputs, calc, analysis, createdAt: createdAt || new Date().toISOString() };
}

/** Report values, with gaps (sex, height, weight, DOB → age, known diabetes) filled from the patient profile. */
function effectivePatient(patient, prof) {
  if (!prof) return patient;
  const e = { ...patient };
  for (const k of ['sex', 'heightCm', 'weightKg', 'dob']) if ((e[k] == null || e[k] === '') && prof[k] != null && prof[k] !== '') e[k] = prof[k];
  if ((e.age == null || e.age === '') && e.dob) e.age = ageAt(e.dob, e.date);
  if ((e.diabetes === '' || e.diabetes == null) && prof.conditions?.diabetes) e.diabetes = true;
  return e;
}

/** Profile facts used as default calculator inputs (blood pressure, BP medicine, smoking). Typed-in values win. */
function withProfileInputs(calcInputs, prof) {
  if (!prof) return calcInputs;
  const ascvd = {};
  if (prof.sbp) ascvd.sbp = prof.sbp;
  ascvd.bp_treated = prof.bpTreated ? 'yes' : 'no';
  if (prof.smoking) ascvd.smoker = prof.smoking === 'current' ? 'yes' : 'no';
  return { ...calcInputs, ascvd_pce: { ...ascvd, ...(calcInputs.ascvd_pce || {}) } };
}

// ------------------------------------------------------------------ dashboard
function viewDashboard() {
  const r = state.report;
  const p = effectivePatient(r.patient, profileOf(r.pid)); // profile fills height/weight/DOB the report lacks
  const c = counts(r.rows);
  const tr = currentTranslation();
  const analysis = tr?.analysis || r.analysis;

  const kpi = (cls, v, l) => h('div', { class: `card kpi ${cls}` }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
  const canvas = h('canvas', { 'aria-label': 'Distribution of normal, low and high results' });

  const byPanel = {};
  for (const row of includedRows(r.rows)) {
    const k = row.panel;
    byPanel[k] ||= { normal: 0, low: 0, high: 0, unknown: 0, total: 0 };
    byPanel[k][row.status]++; byPanel[k].total++;
  }
  const panelBars = PANELS.filter((k) => byPanel[k]).map((k) => {
    const b = byPanel[k];
    const seg = (n, color) => (n ? h('span', { style: { width: `${(n / b.total) * 100}%`, background: color }, title: `${n}` }) : null);
    return h('div', { class: 'pb' }, h('span', {}, k),
      h('div', { class: 'stack' }, seg(b.normal, 'var(--normal)'), seg(b.low, 'var(--low)'), seg(b.high, 'var(--high)'), seg(b.unknown, 'var(--unknown)')),
      h('span', { class: 'muted', style: { textAlign: 'right' } }, `${b.low + b.high}/${b.total}`));
  });

  const bmi = p.heightCm && p.weightKg ? (p.weightKg / (p.heightCm / 100) ** 2).toFixed(1) : null;
  const profile = h('div', { class: 'card profile' }, h('h2', {}, 'Patient profile'),
    h('dl', {},
      h('dt', {}, 'Name'), h('dd', {}, p.name || '—'),
      h('dt', {}, 'Age / Sex'), h('dd', {}, `${p.age ?? '—'} y / ${p.sex === 'M' ? 'Male' : p.sex === 'F' ? 'Female' : '—'}`),
      h('dt', {}, 'Patient ID'), h('dd', {}, p.patientId || '—'),
      h('dt', {}, 'Report date'), h('dd', {}, fmtDate(p.date)),
      h('dt', {}, 'BMI'), h('dd', {}, bmi ? `${bmi} kg/m²` : '—'),
      h('dt', {}, 'Source'), h('dd', {}, `${r.source?.fileName || '—'} (${r.source?.engine || '—'})`),
      h('dt', {}, 'Reports on file'), h('dd', {}, `${sameGroup(r).length}`)));

  const calcReady = r.calc.filter((x) => x.ready);
  const calcFlag = calcReady.filter((x) => x.severity && x.severity !== 'ok').length;

  const node = h('div', {},
    h('div', { class: 'grid cols-5' },
      kpi('', c.total, 'Total tests processed'),
      kpi('normal', c.normal, 'Normal'),
      kpi('low', c.low, 'Low'),
      kpi('high', c.high, 'High'),
      kpi('critical', c.critical, 'Critical values')),
    h('div', { class: 'grid mt', style: { gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr)' } },
      profile,
      h('div', { class: 'card' }, h('h2', {}, 'Result distribution'), h('div', { class: 'chart-box' }, canvas)),
      h('div', { class: 'card panel-bars' }, h('h2', {}, 'Out-of-range by panel'), panelBars,
        h('div', { class: 'row small muted mt' }, legendDot('var(--normal)', 'Normal'), legendDot('var(--low)', 'Low'), legendDot('var(--high)', 'High'), legendDot('var(--unknown)', 'No range')))),
    h('div', { class: 'grid cols-2 mt' },
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, analysis.headline), h('span', { class: 'spacer' }), h('button', { class: 'link', onclick: () => setView('analysis') }, 'Full analysis →')),
        h('p', {}, analysis.summary),
        analysis.observations.slice(0, 4).map((o) => h('div', { class: `sev ${o.severity}`, style: { padding: '4px 10px', margin: '6px 0' } }, h('b', {}, o.title)))),
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'Calculators'), h('span', { class: 'spacer' }), h('button', { class: 'link', onclick: () => setView('calculators') }, 'All calculators →')),
        h('p', { class: 'muted' }, `${calcReady.length} of ${r.calc.length} calculators had all required inputs; ${calcFlag} flagged.`),
        calcReady.filter((x) => x.severity !== 'ok').slice(0, 6).map((x) => h('div', { class: `sev ${x.severity}`, style: { padding: '4px 10px', margin: '6px 0' } },
          h('b', {}, x.name), ': ', `${x.value ?? '—'} ${x.unit} — `, (tr?.calc?.find((t) => t.id === x.id)?.band) || x.band)))),
    h('div', { class: 'disclaimer mt' }, h('b', {}, 'Important: '), 'RADHA organises your results to help you prepare for a consultation. It does not diagnose. Follow your medical practitioner\'s advice for treatment and diagnosis confirmation.'),
  );

  requestAnimationFrame(() => {
    charts.push(new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: ['Normal', 'Low', 'High', 'No range'],
        datasets: [{ data: [c.normal, c.low, c.high, c.unknown], backgroundColor: [cssVar('--normal'), cssVar('--low'), cssVar('--high'), cssVar('--unknown')], borderColor: cssVar('--surface'), borderWidth: 2 }],
      },
      options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { color: cssVar('--text') } } } },
    }));
  });
  return node;
}

const legendDot = (color, label) => h('span', { class: 'row', style: { gap: '5px' } }, h('span', { style: { width: '9px', height: '9px', borderRadius: '50%', background: color, display: 'inline-block' } }), label);

// ------------------------------------------------------------------ labs
function rangeBar(r) {
  if (r.low == null && r.high == null) return h('span', { class: 'muted small' }, '—');
  const lo = r.low ?? 0;
  const hi = r.high ?? lo * 2;
  const span = hi - lo || Math.abs(hi) || 1;
  const min = Math.max(lo - span * 0.6, r.low == null ? 0 : -Infinity);
  const max = hi + span * 0.6;
  const pos = (x) => Math.min(100, Math.max(0, ((x - min) / (max - min)) * 100));
  const color = r.critical ? 'var(--crit)' : r.status === 'low' ? 'var(--low)' : r.status === 'high' ? 'var(--high)' : 'var(--normal)';
  return h('div', { class: 'rangebar', title: `${r.value} (${fmtRange(r.low, r.high)})` },
    h('div', { class: 'ok', style: { left: `${pos(lo)}%`, width: `${pos(hi) - pos(lo)}%` } }),
    h('div', { class: 'dot', style: { left: `${pos(r.value)}%`, background: color } }));
}

function viewLabs() {
  const r = state.report;
  const q = state.labSearch.toLowerCase();
  const rows = includedRows(r.rows).filter((x) => (state.labFilter === 'all' || x.status === 'low' || x.status === 'high' || x.critical) && (!q || x.name.toLowerCase().includes(q)));
  const panels = [...PANELS.filter((pn) => rows.some((x) => x.panel === pn))];
  const body = [];
  for (const pn of panels) {
    const items = rows.filter((x) => x.panel === pn);
    const abn = items.filter((x) => x.status === 'low' || x.status === 'high').length;
    body.push(h('tr', { class: 'panel-head' + (pn === 'Complete Blood Count' ? ' focus' : '') }, h('td', { colspan: 6 }, `${pn}`, h('span', { class: 'muted', style: { fontWeight: 400, marginLeft: '8px' } }, `${items.length} tests${abn ? ` · ${abn} out of range` : ''}`))));
    for (const x of items) {
      body.push(h('tr', { class: x.critical ? 'abn-crit' : x.status === 'low' ? 'abn-low' : x.status === 'high' ? 'abn-high' : '' },
        h('td', {}, x.name, x.rawName && x.rawName.toLowerCase() !== x.name.toLowerCase() ? h('div', { class: 'small muted' }, x.rawName) : null),
        h('td', { class: 'num' }, h('b', {}, fmtNum(x.value)), x.qualifier ? ` ${x.qualifier}` : ''),
        h('td', { class: 'muted' }, x.unit === 'ratio' ? '' : x.unit),
        h('td', { class: 'num' }, fmtRange(x.low != null ? fmtNum(x.low) : null, x.high != null ? fmtNum(x.high) : null), x.rangeSource === 'default' ? h('span', { class: 'small muted' }, ' (default)') : null),
        h('td', {}, rangeBar(x)),
        h('td', {}, pill(x))));
    }
  }
  return h('div', {},
    h('div', { class: 'row mb' },
      h('div', { class: 'tabs' },
        h('button', { class: state.labFilter === 'all' ? 'active' : '', onclick: () => { state.labFilter = 'all'; render(); } }, `All (${includedRows(r.rows).length})`),
        h('button', { class: state.labFilter === 'abnormal' ? 'active' : '', onclick: () => { state.labFilter = 'abnormal'; render(); } }, `Out of range (${counts(r.rows).low + counts(r.rows).high})`)),
      h('input', { type: 'text', placeholder: 'Search tests…', value: state.labSearch, oninput: (e) => { state.labSearch = e.target.value; const pos = e.target.selectionStart; render(); const inp = $('#view input[type=text]'); inp.focus(); inp.setSelectionRange(pos, pos); } }),
      h('span', { class: 'spacer' }),
      legendDot('var(--normal)', 'Normal'), legendDot('var(--low)', 'Low'), legendDot('var(--high)', 'High'), legendDot('var(--crit)', 'Critical')),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Test', 'Result', 'Unit', 'Reference range', 'Position', 'Status'].map((t) => h('th', {}, t)))),
      h('tbody', {}, body.length ? body : h('tr', {}, h('td', { colspan: 6, class: 'muted', style: { textAlign: 'center', padding: '24px' } }, 'No matching tests.'))))));
}

// ------------------------------------------------------------------ calculators
const SEV_COLOR = { ok: 'var(--normal)', mild: 'var(--warn)', moderate: 'var(--high)', severe: 'var(--crit)' };

function viewCalculators() {
  const r = state.report;
  const tr = currentTranslation();
  const ready = r.calc.filter((c) => c.ready);
  const needs = r.calc.filter((c) => c.needsInput);
  const missing = r.calc.filter((c) => !c.ready && !c.needsInput);
  const tab = state.calcTab || 'results';
  const libCount = state.library?.length;

  const card = (c) => {
    const t = tr?.calc?.find((x) => x.id === c.id);
    const libId = libraryIdFor(c);
    const editing = state.calcEditing === c.id;
    return h('div', { class: `card calc sev ${c.severity}`, id: `calc-${c.id}` },
      h('div', { class: 'name' }, c.name),
      h('div', { class: 'val' }, c.value ?? '—', ' ', h('small', {}, c.value == null ? '' : c.unit)),
      h('div', { class: 'band', style: { color: SEV_COLOR[c.severity] } }, t?.band || c.band),
      h('div', { class: 'small', style: { marginTop: '6px' } }, t?.interpretation || c.interpretation),
      h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Inputs: ', inputSummary(c)),
      h('div', { class: 'ref' }, c.reference),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        libId ? h('button', { class: 'link small', onclick: () => openLibraryModal(libId) }, 'ⓘ Calculator details') : null,
        c.extras.length ? h('button', { class: 'link small', onclick: () => { state.calcEditing = editing ? null : c.id; render(); } }, editing ? 'Close inputs' : '✎ Edit inputs') : null),
      editing ? extrasForm(c) : null);
  };

  const groups = (list) => {
    const cats = [...new Set(list.map((c) => c.category))];
    return cats.map((cat) => h('div', { class: 'mb' }, h('h3', { style: { fontSize: '13.5px', margin: '8px 0' } }, cat),
      h('div', { class: 'grid cols-3' }, list.filter((c) => c.category === cat).map(card))));
  };

  let body;
  if (tab === 'results') {
    const routine = ready.filter((c) => c.context !== 'specialist');
    const spec = ready.filter((c) => c.context === 'specialist');
    body = h('div', {}, groups(routine),
      spec.length ? h('div', {}, h('h2', { style: { fontSize: '15px', marginTop: '20px' } }, 'Specialist & condition-specific scores'),
        h('p', { class: 'small muted' }, 'These scores were computed because their inputs are available, but they are only meaningful in a specific clinical situation (for example known cirrhosis or acute kidney injury).'),
        groups(spec)) : null);
  } else if (tab === 'input') {
    body = needs.length ? h('div', {},
      h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Your report already provides the lab values for these calculators. Enter the remaining values (not found on a lab report) to run them; they are saved with this report.'),
      h('div', { class: 'grid cols-2' }, needs.map((c) => h('div', { class: 'card calc', id: `calc-${c.id}` },
        h('div', { class: 'row' }, h('div', { class: 'name' }, c.name), h('span', { class: 'spacer' }),
          libraryIdFor(c) ? h('button', { class: 'link small', onclick: () => openLibraryModal(libraryIdFor(c)) }, 'ⓘ Details') : null),
        h('div', { class: 'small muted', style: { margin: '4px 0 8px' } }, 'From report: ', inputSummary(c)),
        extrasForm(c)))))
      : h('div', { class: 'card empty' }, 'No calculators are waiting for extra inputs.');
  } else {
    body = h('div', { class: 'card' },
      h('p', { class: 'small muted', style: { marginTop: 0 } }, 'These calculators need lab values or profile details that this report does not contain. Add the values on the Verify screen (or add height/weight to the profile) and they will run automatically.'),
      h('table', {}, h('tbody', {}, missing.map((c) => h('tr', {},
        h('td', {}, c.name), h('td', { class: 'muted small' }, c.error ? `Error: ${c.error}` : `Needs: ${c.missing.map(prettyInput).join(', ')}`),
        h('td', {}, libraryIdFor(c) ? h('button', { class: 'link small', onclick: () => openLibraryModal(libraryIdFor(c)) }, 'Details') : null))))));
  }

  return h('div', {},
    h('div', { class: 'row mb' },
      h('div', { class: 'tabs' },
        h('button', { class: tab === 'results' ? 'active' : '', onclick: () => { state.calcTab = 'results'; render(); } }, `Results (${ready.length})`),
        h('button', { class: tab === 'input' ? 'active' : '', onclick: () => { state.calcTab = 'input'; render(); } }, `Needs your input (${needs.length})`),
        h('button', { class: tab === 'missing' ? 'active' : '', onclick: () => { state.calcTab = 'missing'; render(); } }, `Not available (${missing.length})`)),
      h('span', { class: 'spacer' }),
      h('span', { class: 'small muted' }, `${r.calc.length} executable calculators checked against this report`),
      h('button', { class: 'btn small', onclick: () => setView('library') }, `Browse full library${libCount ? ` (${libCount})` : ''} →`)),
    body);
}

function inputSummary(c) {
  const r = state.report;
  const rows = includedRows(r.rows);
  const parts = [];
  const def = CALCULATORS.find((x) => x.id === c.id);
  const keys = [...c.requires, ...(def?.anyOf || []).flat().filter((k) => rows.some((x) => x.key === k))];
  for (const k of keys) {
    if (['age', 'sex', 'height', 'weight', 'bmi'].includes(k)) {
      const p = r.patient;
      const v = { age: p.age && `${p.age} y`, sex: p.sex, height: p.heightCm && `${p.heightCm} cm`, weight: p.weightKg && `${p.weightKg} kg`, bmi: p.heightCm && p.weightKg && `BMI ${(p.weightKg / (p.heightCm / 100) ** 2).toFixed(1)}` }[k];
      if (v) parts.push(`${k} ${v}`.replace(/^(age|height|weight|bmi) /, (m) => m));
      continue;
    }
    const row = rows.find((x) => x.key === k);
    if (row) parts.push(`${row.name} ${fmtNum(row.value)}${row.unit === 'ratio' ? '' : ' ' + row.unit}`);
  }
  for (const e of c.extras) {
    const v = c.inputs?.[e.id];
    const fromLab = e.fromLab && rows.find((x) => x.key === e.fromLab);
    if (fromLab) parts.push(`${fromLab.name} ${fmtNum(fromLab.value)}`);
    else if (v != null && v !== '') parts.push(`${e.label}: ${e.options ? e.options.find((o) => o.value === String(v))?.label || v : v}${e.unit ? ' ' + e.unit : ''}`);
  }
  return parts.join(' · ') || '—';
}

function extrasForm(c) {
  const r = state.report;
  const draft = { ...(r.calcInputs?.[c.id] || {}) };
  const fields = c.extras.filter((e) => !(e.fromLab && includedRows(r.rows).some((x) => x.key === e.fromLab))).map((e) => {
    const cur = draft[e.id] ?? e.default ?? '';
    const input = e.type === 'select'
      ? h('select', { onchange: (ev) => { draft[e.id] = ev.target.value; } },
        h('option', { value: '', selected: cur === '' }, '— select —'), e.options.map((o) => h('option', { value: o.value, selected: String(cur) === o.value }, o.label)))
      : h('input', { type: 'number', step: 'any', value: cur, placeholder: e.optional ? 'optional' : '', oninput: (ev) => { draft[e.id] = ev.target.value; } });
    return h('label', {}, `${e.label}${e.unit ? ` (${e.unit})` : ''}`, input);
  });
  return h('div', { class: 'mt' },
    h('div', { class: 'form-grid', style: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } }, fields),
    h('div', { class: 'row mt' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary small', onclick: () => saveCalcInputs(c.id, draft) }, 'Calculate')));
}

async function saveCalcInputs(calcId, values) {
  const r = state.report;
  const calcInputs = { ...(r.calcInputs || {}), [calcId]: values };
  const updated = { ...r, ...buildReport({ ...r, calcInputs }), calcInputs };
  try {
    const saved = await call(api.saveReport(updated));
    state.report = { ...saved, ...buildReport(saved) };
    state.reports = state.reports.map((x) => (x.id === saved.id ? state.report : x));
    for (const k of Object.keys(state.translations)) if (k.startsWith(saved.id + ':')) delete state.translations[k];
    const res = state.report.calc.find((x) => x.id === calcId);
    state.calcEditing = null;
    if (res?.ready) { state.calcTab = 'results'; toast(`${res.name}: ${res.value ?? ''} ${res.value == null ? '' : res.unit} — ${res.band}`); }
    else toast(res?.error ? `Could not calculate: ${res.error}` : 'Saved. Some required inputs are still empty.', !res?.ready);
    render();
    requestAnimationFrame(() => document.getElementById(`calc-${calcId}`)?.scrollIntoView({ block: 'center' }));
    maybeTranslate();
  } catch (err) { toast(err.message, true); }
}

// ------------------------------------------------------------------ calculator library
const normName = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
let libNameMap = null;

async function ensureLibrary() {
  if (state.library) return state.library;
  state.library = await call(api.libraryIndex());
  libNameMap = new Map();
  for (const c of state.library) for (const n of [c.name, ...(c.aliases || [])]) libNameMap.set(normName(n), c.id);
  return state.library;
}

function libraryIdFor(calc) {
  if (!libNameMap) return null;
  for (const n of calc.lib || []) { const id = libNameMap.get(normName(n)); if (id) return id; }
  return null;
}

function implementedLibraryIds() {
  const ids = new Map();
  if (!libNameMap) return ids;
  for (const c of CALCULATORS) for (const n of c.lib || []) { const id = libNameMap.get(normName(n)); if (id && !ids.has(id)) ids.set(id, c.id); }
  return ids;
}

function viewLibrary() {
  if (!state.library) {
    ensureLibrary().then(render).catch((err) => toast('Could not load the calculator library: ' + err.message, true));
    return h('div', { class: 'empty' }, h('span', { class: 'spinner' }), ' Loading calculator library…');
  }
  const impl = implementedLibraryIds();
  const cats = {};
  for (const c of state.library) for (const k of c.categories) cats[k] = (cats[k] || 0) + 1;
  const catList = Object.entries(cats).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]);

  const list = h('div', { class: 'lib-list' });
  const detail = h('div', { class: 'lib-detail card' });
  const count = h('span', { class: 'small muted' });

  const fill = () => {
    const q = (state.libQuery || '').toLowerCase().trim();
    const terms = q.split(/\s+/).filter(Boolean);
    const matches = state.library.filter((c) => {
      if (state.libOnlyImpl && !impl.has(c.id)) return false;
      if (state.libCat && !c.categories.includes(state.libCat)) return false;
      if (!terms.length) return true;
      const hay = (c.name + ' ' + c.aliases.join(' ') + ' ' + c.categories.join(' ') + ' ' + c.description).toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    count.textContent = `${matches.length} of ${state.library.length} calculators · ${impl.size} run on your reports`;
    list.replaceChildren(...matches.slice(0, 300).map((c) => h('button', {
      class: 'lib-item' + (c.id === state.libSel ? ' active' : ''),
      onclick: () => { state.libSel = c.id; fill(); showLibraryDetail(c.id, detail); },
    }, h('div', { class: 'lib-name' }, c.name, impl.has(c.id) ? h('span', { class: 'pill normal', style: { marginLeft: '6px' } }, 'runs on reports') : null),
    h('div', { class: 'small muted lib-desc' }, c.description || c.categories.slice(0, 3).join(' · ')))),
    matches.length > 300 ? h('div', { class: 'small muted', style: { padding: '8px' } }, `Showing first 300 — refine the search to see more.`) : null);
  };

  const search = h('input', { type: 'text', placeholder: 'Search 2,000+ calculators (name, condition, specialty)…', value: state.libQuery || '', style: { flex: 1, minWidth: '260px' },
    oninput: (e) => { state.libQuery = e.target.value; fill(); } });
  const catSel = h('select', { onchange: (e) => { state.libCat = e.target.value; fill(); } },
    h('option', { value: '' }, 'All specialties'), catList.map(([k, n]) => h('option', { value: k, selected: state.libCat === k }, `${k} (${n})`)));
  const onlyImpl = h('label', { class: 'row small', style: { gap: '6px' } }, h('input', { type: 'checkbox', checked: state.libOnlyImpl, onchange: (e) => { state.libOnlyImpl = e.target.checked; fill(); } }), 'Only calculators that run on reports');

  fill();
  if (state.libSel) showLibraryDetail(state.libSel, detail);
  else detail.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '∑'), 'Select a calculator to see its description, inputs, formula, interpretation, evidence and references.'));
  requestAnimationFrame(() => search.focus());

  return h('div', {},
    h('div', { class: 'row mb' }, search, catSel, onlyImpl),
    h('div', { class: 'row mb' }, count),
    h('div', { class: 'lib-grid' }, list, detail));
}

async function showLibraryDetail(id, container) {
  container.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  let entry;
  try { entry = await call(api.libraryGet(id)); } catch (err) { container.replaceChildren(h('p', {}, err.message)); return; }
  if (!entry) { container.replaceChildren(h('p', {}, 'Not found.')); return; }
  const implId = implementedLibraryIds().get(id);
  const res = implId && state.report?.calc.find((c) => c.id === implId);
  container.replaceChildren(libraryDetail(entry, implId, res));
  container.scrollTop = 0;
}

function libraryDetail(e, implId, res) {
  const sec = (title, ...content) => h('div', { class: 'lib-sec' }, h('h3', {}, title), ...content);
  const text = (t) => h('div', { class: 'lib-text' }, t);
  const versions = e.versions.map((v, i) => h('div', { class: e.versions.length > 1 ? 'lib-version' : '' },
    e.versions.length > 1 ? h('div', { class: 'lib-vtag' }, `Version ${i + 1} of ${e.versions.length}`) : null,
    v.description && i > 0 ? sec('Description', text(v.description)) : null,
    v.about ? sec('About', text(v.about)) : null,
    v.inputs?.length ? sec(`Inputs (${v.inputs.length})`, h('table', { class: 'lib-table' }, h('tbody', {}, v.inputs.map((x) => h('tr', {},
      h('td', {}, x.label), h('td', { class: 'small muted' }, [x.options?.length ? x.options.join(' · ') : x.type, x.units?.length ? `units: ${x.units.join(', ')}` : '', x.help || ''].filter(Boolean).join(' — '))))))) : null,
    v.results?.length ? sec('Results', text(v.results.join(' · '))) : null,
    v.formula ? sec('Formula', text(v.formula)) : null,
    v.equations?.length ? sec('Equations', h('pre', { class: 'lib-pre' }, v.equations.join('\n'))) : null,
    v.interpretation ? sec('Interpretation', text(v.interpretation)) : null,
    v.notes ? sec('Notes', text(v.notes)) : null,
    v.evidence ? sec('Evidence', text(v.evidence)) : null,
    v.article?.length ? sec('Article', ...v.article.map((a) => h('div', {}, a.title ? h('h4', {}, a.title) : null, text(a.text)))) : null,
    v.faqs?.length ? sec('FAQs', ...v.faqs.map((f) => h('div', { class: 'lib-faq' }, h('b', {}, f.q), text(f.a)))) : null,
    v.extra && Object.keys(v.extra).length ? sec('Additional information', ...Object.entries(v.extra).map(([k, val]) => h('div', {}, h('b', {}, k + ': '), val))) : null,
    v.mesh?.length ? sec('MeSH terms', text(v.mesh.join('; '))) : null,
    v.loinc && Object.keys(v.loinc).length ? sec('LOINC codes', text(Object.entries(v.loinc).map(([k, c]) => `${k}: ${[].concat(c).join(', ')}`).join('\n'))) : null,
    v.icd ? sec('ICD codes', text(v.icd)) : null,
    v.references?.length ? sec('References', h('ol', { class: 'small' }, v.references.map((r) => h('li', {}, r)))) : null));

  return h('div', {},
    h('h2', { style: { marginBottom: '4px' } }, e.name),
    e.aliases.length ? h('div', { class: 'small muted' }, 'Also known as: ', e.aliases.join(' · ')) : null,
    h('div', { class: 'small muted', style: { margin: '4px 0 10px' } }, [...e.categories, ...e.types].join(' · ')),
    implId ? h('div', { class: 'card', style: { background: 'var(--accent-soft)', padding: '10px 14px', marginBottom: '12px' } },
      res?.ready ? h('div', {}, h('b', {}, 'Your report: '), `${res.value ?? ''} ${res.value == null ? '' : res.unit} — ${res.band}`)
        : res?.needsInput ? h('div', {}, h('b', {}, 'Runs on your report '), '— needs a few values you can type in.')
          : h('div', {}, h('b', {}, 'RADHA can run this calculator '), state.report ? `— this report is missing: ${(res?.missing || []).map(prettyInput).join(', ')}` : 'on any verified report.'),
      state.report ? h('button', { class: 'btn small mt', onclick: () => { closeModal(); state.calcTab = res?.ready ? 'results' : res?.needsInput ? 'input' : 'missing'; setView('calculators'); requestAnimationFrame(() => document.getElementById(`calc-${implId}`)?.scrollIntoView({ block: 'center' })); } }, 'Open in Calculators →') : null)
      : h('div', { class: 'small muted', style: { marginBottom: '10px' } }, 'Reference only — this calculator needs clinical inputs that are not part of a lab report.'),
    e.description ? text(e.description) : null,
    versions);
}

function closeModal() { document.querySelector('.modal-backdrop')?.remove(); }

async function openLibraryModal(id) {
  await ensureLibrary();
  closeModal();
  const box = h('div', { class: 'modal card' });
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (ev) => { if (ev.target === backdrop) closeModal(); } },
    h('div', { class: 'modal-wrap' }, h('button', { class: 'btn small modal-close', onclick: closeModal }, '✕ Close'), box));
  document.body.append(backdrop);
  showLibraryDetail(id, box);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

const prettyInput = (k) => k.split(' or ').map((x) => BY_KEY[x]?.name || { age: 'age', sex: 'sex', height: 'height', weight: 'weight', bmi: 'height & weight (BMI)' }[x] || x).join(' or ');

// ------------------------------------------------------------------ analysis
function viewAnalysis() {
  const r = state.report;
  const tr = currentTranslation();
  const a = tr?.analysis || r.analysis;
  const narrative = tr?.narrative || r.narrative?.text;
  const english = r.analysis;

  return h('div', {},
    h('div', { class: 'disclaimer mb' }, h('b', {}, 'Not a diagnosis. '), 'These observations are generated by deterministic rules from your verified values to help you prepare for a consultation. Follow your medical practitioner\'s advice for treatment and diagnosis confirmation.'),
    h('div', { class: 'card mb' }, h('h2', {}, a.headline), h('p', { style: { margin: 0 } }, a.summary)),
    a.observations.length ? a.observations.map((o, i) => h('div', { class: `card obs mb sev ${o.severity}` },
      h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, o.title), h('span', { class: 'spacer' }),
        h('span', { class: 'pill ' + ({ urgent: 'critical', attention: 'high', watch: 'unknown', info: 'normal' }[o.severity]) }, { urgent: 'Discuss promptly', attention: 'Discuss soon', watch: 'Keep an eye on', info: 'Info' }[o.severity])),
      h('p', { style: { margin: '8px 0' } }, o.detail),
      h('div', { class: 'ev' }, h('b', {}, 'Evidence: '), english.observations[i].evidence.join(' · ')),
      h('div', { style: { marginTop: '8px' } }, h('b', {}, 'Suggested next steps'), h('ul', {}, o.nextSteps.map((s) => h('li', {}, s))))))
      : h('div', { class: 'card mb' }, 'No specific patterns were flagged.'),
    questionsCard(a.questions),
    narrativeCard(r, narrative),
  );
}

/** "Questions to ask your doctor", grouped by topic and numbered continuously. */
function questionsCard(questions) {
  const groups = [];
  for (const raw of questions || []) {
    const q = typeof raw === 'string' ? { topic: 'General', text: raw } : raw;
    const last = groups[groups.length - 1];
    if (last && last.topic === q.topic) last.items.push(q.text); else groups.push({ topic: q.topic, items: [q.text] });
  }
  let n = 0;
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'Questions to ask your doctor'), h('span', { class: 'spacer' }),
      h('span', { class: 'small muted' }, `${questions.length} questions covering every finding, out-of-range and borderline result, changes since your last report, and tests not done`)),
    groups.map((g) => h('div', { class: 'q-group' }, h('h3', {}, g.topic),
      h('ol', { start: n + 1 }, g.items.map((t) => { n++; return h('li', {}, t); })))));
}

const providerById = (id) => state.aiProviders.find((p) => p.id === id);
const providerReady = (p) => p && (!p.needsKey || p.hasKey);

function narrativeCard(r, narrative) {
  const pid = state.settings.aiProvider || 'pollinations';
  const p = providerById(pid);
  const models = state.aiModelLists[pid] || [];
  const modelInput = h('input', { type: 'text', list: 'ai-models', value: p?.model || '', placeholder: 'model', style: { width: '210px' },
    onchange: (e) => setProviderModel(pid, e.target.value.trim()) });
  const meta = r.narrative;
  return h('div', { class: 'card mt' },
    h('div', { class: 'row' },
      h('h2', { style: { margin: 0 } }, 'AI narrative summary'), h('span', { class: 'spacer' }),
      h('select', { title: 'AI provider', onchange: async (e) => { state.settings = await call(api.setSettings({ aiProvider: e.target.value })); render(); } },
        state.aiProviders.map((x) => h('option', { value: x.id, selected: x.id === pid }, `${x.name}${x.needsKey && !x.hasKey ? ' — add key' : ''}`))),
      modelInput, h('datalist', { id: 'ai-models' }, models.map((m) => h('option', { value: m }))),
      h('button', { class: 'btn small', title: 'Load the models this provider offers', onclick: () => loadModels(pid) }, '↻ Models'),
      h('button', { class: 'btn primary', disabled: !providerReady(p), onclick: (e) => generateNarrative(e.target, pid) }, narrative ? 'Regenerate' : 'Generate')),
    p && !providerReady(p) ? h('p', { class: 'small', style: { color: 'var(--warn)' } }, `${p.name} needs an API key. `,
      h('button', { class: 'link small', onclick: () => setView('settings') }, 'Add it in Settings → AI providers')) : null,
    narrative ? h('div', {},
      h('div', { class: 'ai-text mt' }, narrative),
      meta ? h('div', { class: 'small muted mt' }, `Generated by ${meta.providerName || meta.provider} · ${meta.model} · ${new Date(meta.at).toLocaleString()}`) : null)
      : h('p', { class: 'muted small' }, 'Optional. Sends the de-identified results and RADHA\'s rule-based findings (no name or ID) to the selected AI to write a plain-language summary. The deterministic findings above remain the source of truth. ', p?.note || ''));
}

async function loadProviders() {
  try {
    [state.aiProviders, state.trServices] = await Promise.all([call(api.aiProviders()), call(api.translationServices())]);
  } catch (err) { toast(err.message, true); }
  fillTranslatorSelect();
}

function fillTranslatorSelect() {
  const sel = $('#trSelect');
  sel.replaceChildren(...state.trServices.map((t) => h('option', { value: t.id, selected: t.id === translatorId() },
    t.name.replace(/ — .*/, '') + (t.free ? ' (free)' : '') + (t.needsKey && !t.hasKey ? ' — add key' : ''))));
}

async function setTranslator(id) {
  state.settings = await call(api.setSettings({ translationProvider: id }));
  fillTranslatorSelect();
  await maybeTranslate();
}

function translationCard() {
  const s = state.settings;
  const rows = state.trServices.map((t) => {
    const keyId = `tr_${t.id}`;
    const key = h('input', { type: 'password', placeholder: t.hasKey ? '•••••••• saved — paste to replace' : (t.optionalKey ? 'API key (optional)' : 'Paste API key'), style: { width: '100%' } });
    const saveKey = async () => {
      if (!key.value.trim()) return toast('Paste a key first.', true);
      await call(api.aiSetKey(keyId, key.value.trim())); toast(`${t.name} key saved (encrypted).`);
      await loadProviders(); render();
    };
    const keyField = (t.id === 'google_cloud' || t.id === 'libre') ? h('label', {}, 'API key', h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, key,
      h('button', { class: 'btn small', onclick: saveKey }, 'Save'),
      t.hasKey ? h('button', { class: 'btn small danger', onclick: async () => { await call(api.aiSetKey(keyId, '')); await loadProviders(); render(); } }, 'Remove') : null)) : null;
    const extra = t.id === 'mymemory'
      ? h('label', {}, 'Email (optional — raises the free daily limit to 50,000 characters)', h('input', { type: 'text', value: s.myMemoryEmail || '', placeholder: 'you@example.com',
        onchange: async (e) => { state.settings = await call(api.setSettings({ myMemoryEmail: e.target.value.trim() })); } }))
      : t.id === 'libre'
        ? h('label', {}, 'Server URL', h('input', { type: 'text', value: s.libreUrl || '', placeholder: 'http://localhost:5050',
          onchange: async (e) => { state.settings = await call(api.setSettings({ libreUrl: e.target.value.trim() })); } }))
        : t.id === 'sarvam' ? h('div', { class: 'small muted' }, t.hasKey ? 'Uses the Sarvam key saved above.' : 'Add the Sarvam key in the Sarvam AI card above.')
          : t.id === 'ai' ? h('div', { class: 'small muted' }, `Currently: ${state.aiProviders.find((p) => p.id === s.aiProvider)?.name || s.aiProvider}`) : null;
    const status = t.free ? h('span', { class: 'pill normal' }, 'free · no key') : t.needsKey ? (t.hasKey ? h('span', { class: 'pill normal' }, 'key saved') : h('span', { class: 'pill unknown' }, 'no key')) : null;
    return h('div', { class: 'provider' + (translatorId() === t.id ? ' active' : '') },
      h('div', { class: 'row' }, h('b', {}, t.name), status, h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'Testing…';
          try {
            const [out] = await call(api.translate(['Repeat the HbA1c test in 3 months.'], 'hi-IN', t.id));
            toast(`${t.name} works — Hindi: ${out}`);
          } catch (err) { toast(err.message, true); }
          e.target.disabled = false; e.target.textContent = 'Test';
        } }, 'Test'),
        h('label', { class: 'row small', style: { gap: '4px' } }, h('input', { type: 'radio', name: 'tr-default', checked: translatorId() === t.id,
          onchange: async () => { await setTranslator(t.id); render(); } }), 'Use for translation')),
      h('div', { class: 'small muted', style: { margin: '2px 0 6px' } }, t.note),
      keyField || extra ? h('div', { class: 'form-grid', style: { gridTemplateColumns: keyField && extra ? '1fr 1fr' : '1fr' } }, extra, keyField) : null);
  });
  return h('div', { class: 'card', style: { gridColumn: '1 / -1' } },
    h('h2', {}, 'Translation (Output language)'),
    h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Chooses who translates the findings, questions, calculator interpretations and AI narrative when an output language other than English is selected. Test names, numbers and units always stay as printed. Only these texts are sent — never the patient name or ID. You can also switch service from the top bar.'),
    rows);
}

async function setProviderModel(id, model) {
  state.settings = await call(api.setSettings({ aiModels: { [id]: model } }));
  await loadProviders();
}

async function loadModels(id) {
  try {
    const list = await call(api.aiModels(id));
    state.aiModelLists[id] = list;
    toast(list.length ? `${list.length} models available — pick one in the model box.` : 'No models found.');
    render();
  } catch (err) { toast(err.message, true); }
}

async function generateNarrative(btn, providerId) {
  const r = state.report;
  const p = providerById(providerId);
  btn.disabled = true; btn.textContent = 'Generating…';
  const facts = {
    age: r.patient.age, sex: r.patient.sex,
    results: includedRows(r.rows).map((x) => `${x.name}: ${x.value} ${x.unit} (ref ${fmtRange(x.low, x.high)}) ${x.status}`),
    calculators: r.calc.filter((c) => c.ready).map((c) => `${c.name}: ${c.value} ${c.unit} — ${c.band}`),
    findings: r.analysis.observations.map((o) => `${o.title}: ${o.detail}`),
  };
  try {
    const text = await call(api.aiChat(providerId, p?.model, [
      { role: 'system', content: 'You are a careful clinical communication assistant. Write for a patient preparing to see their doctor. ' +
        'Use only the facts provided; do not add new diagnoses, drug names or doses. Be calm and clear. ' +
        'Structure: 1) Overall picture (2-3 sentences) 2) Key findings in plain language (bullets) 3) What to discuss with the doctor (bullets). ' +
        'End with: "This summary is not a diagnosis. Please follow your doctor\'s advice." Keep under 300 words. Plain text, no markdown headings.' },
      { role: 'user', content: JSON.stringify(facts) },
    ]));
    const narrative = { text, provider: providerId, providerName: p?.name, model: p?.model, at: new Date().toISOString() };
    const saved = await call(api.saveReport({ ...r, narrative }));
    state.report = { ...r, narrative, savedAt: saved.savedAt };
    state.reports = state.reports.map((x) => (x.id === r.id ? state.report : x));
    for (const k of Object.keys(state.translations)) if (k.startsWith(r.id + ':')) delete state.translations[k];
    await maybeTranslate();
  } catch (err) { toast(err.message, true); }
  render();
}

// ------------------------------------------------------------------ trends
function groups() {
  const g = {};
  for (const r of state.reports) {
    const k = groupKey(r);
    const prof = profileOf(r.pid);
    (g[k] ||= { key: k, name: prof?.name || r.patient.name || 'Unnamed patient', patientId: prof?.labIds?.[0] || r.patient.patientId, reports: [] }).reports.push(r);
  }
  for (const x of Object.values(g)) x.reports.sort((a, b) => (a.patient.date || '').localeCompare(b.patient.date || ''));
  return Object.values(g);
}
/**
 * Load saved reports and re-run calculators, rules and questions on each one, so reports saved by an
 * older version of RADHA always get the current analysis (never display a stored analysis as-is).
 */
async function reloadReports() {
  state.patients = await call(api.listPatients());
  state.reports = await call(api.listReports());
  state.reports = state.reports.map((r) => ({ ...r, ...buildReport(r) }));
}

/** The patient's most recent earlier visit (same-day reports merged), for comparison questions. */
function previousVisit(report) {
  if (!report.patient?.date) return null;
  const key = groupKey(report);
  const earlier = (state.reports || []).filter((r) => r.id !== report.id && groupKey(r) === key && r.patient.date && r.patient.date < report.patient.date);
  if (!earlier.length) return null;
  const visits = mergeByDate(earlier.sort((a, b) => a.patient.date.localeCompare(b.patient.date)));
  const v = visits[visits.length - 1];
  return { date: v.patient.date, rows: v.rows };
}

/** Combine reports from the same day (e.g. separate PDFs from one visit) into one trend column. */
function mergeByDate(reports) {
  const byDate = new Map();
  for (const r of reports) {
    const d = r.patient.date || r.id;
    if (!byDate.has(d)) { byDate.set(d, { ...r, rows: [...r.rows], parts: [r] }); continue; }
    const v = byDate.get(d);
    v.parts.push(r);
    for (const row of r.rows) if (!v.rows.some((x) => x.key === row.key && x.include !== false)) v.rows.push(row);
  }
  return [...byDate.values()];
}

function sameGroup(report) { return groups().find((g) => g.key === groupKey(report))?.reports || [report]; }

function viewTrends() {
  const gs = groups();
  if (!gs.length) return h('div', { class: 'empty' }, h('div', { class: 'big' }, '↗'), 'No verified reports yet. Ingest reports from different years to compare them here.');
  if (!state.trendKey || !gs.find((g) => g.key === state.trendKey)) state.trendKey = gs[0].key;
  const g = gs.find((x) => x.key === state.trendKey);
  const files = g.reports;

  const picker = h('div', { class: 'row mb' }, h('span', { class: 'muted' }, 'Patient:'),
    h('select', { onchange: (e) => { state.trendKey = e.target.value; state.trendMarker = null; render(); } },
      gs.map((x) => h('option', { value: x.key, selected: x.key === state.trendKey }, `${x.name}${x.patientId ? ` (${x.patientId})` : ''} — ${x.reports.length} report${x.reports.length > 1 ? 's' : ''}`))));

  const reportList = h('div', { class: 'card mb' }, h('h2', {}, 'Reports on file'),
    h('table', {}, h('tbody', {}, files.map((r) => h('tr', {},
      h('td', {}, fmtDate(r.patient.date)), h('td', { class: 'muted small' }, `${r.source?.fileName || ''} · ${includedRows(r.rows).length} tests`),
      h('td', {}, `${counts(r.rows).low + counts(r.rows).high} out of range`),
      h('td', { style: { textAlign: 'right' } },
        h('button', { class: 'btn small', onclick: () => { state.report = r; state.activePid = r.pid; setView('dashboard'); maybeTranslate(); } }, state.report?.id === r.id ? 'Current' : 'Open'), ' ',
        h('button', { class: 'btn small', onclick: () => editReport(r) }, 'Edit'), ' ',
        h('button', { class: 'btn small danger', onclick: async () => {
          if (!confirm(`Delete the report dated ${fmtDate(r.patient.date)}? This cannot be undone.`)) return;
          await call(api.deleteReport(r.id));
          await reloadReports();
          if (state.report?.id === r.id) state.report = null;
          render();
        } }, 'Delete')))))));

  const reps = mergeByDate(files);
  if (reps.length < 2) {
    return h('div', {}, picker, reportList, h('div', { class: 'card empty' }, 'All reports on file for this patient are from the same date. Add a report from another date to see the comparison and trend charts.'));
  }

  const keys = [];
  for (const r of reps) for (const x of includedRows(r.rows)) if (!keys.includes(x.key)) keys.push(x.key);
  const byKey = (r, k) => includedRows(r.rows).find((x) => x.key === k);
  // Order by panel, keeping markers measured more than once first.
  const multi = (k) => reps.filter((r) => byKey(r, k)).length;
  keys.sort((a, b) => (multi(b) > 1) - (multi(a) > 1) || PANELS.indexOf(panelOf(a, reps)) - PANELS.indexOf(panelOf(b, reps)));
  if (!state.trendMarker || !keys.includes(state.trendMarker)) state.trendMarker = keys.find((k) => multi(k) > 1) || keys[0];

  const rows = keys.map((k) => {
    const cells = [];
    let prev = null;
    let first = null;
    let last = null;
    for (const r of reps) {
      const x = byKey(r, k);
      if (!x) { cells.push(h('td', { class: 'muted' }, '—')); continue; }
      first ??= x; last = x;
      const delta = prev != null && prev.value ? ((x.value - prev.value) / Math.abs(prev.value)) * 100 : null;
      cells.push(h('td', { class: 'num' }, h('span', { style: { color: x.status === 'low' ? 'var(--low)' : x.status === 'high' ? 'var(--high)' : '' }, title: statusLabel(x) }, fmtNum(x.value)),
        delta != null && Math.abs(delta) >= 0.5 ? h('span', { class: `delta ${delta > 0 ? 'up' : 'down'}` }, `${delta > 0 ? '▲' : '▼'}${Math.abs(delta).toFixed(0)}%`) : null));
      prev = x;
    }
    const sample = last || first;
    let trend = '—';
    if (first && last && first !== last) {
      const better = trendDirection(sample, first, last);
      trend = h('span', { style: { color: better === 1 ? 'var(--normal)' : better === -1 ? 'var(--high)' : 'var(--muted)' } }, better === 1 ? 'Improving' : better === -1 ? 'Worsening' : 'Stable');
    }
    return h('tr', { class: 'clickable' + (k === state.trendMarker ? ' selected' : ''), onclick: () => { state.trendMarker = k; render(); } },
      h('td', {}, sample.name), h('td', { class: 'muted small' }, sample.unit === 'ratio' ? '' : sample.unit), ...cells,
      h('td', { class: 'small muted' }, fmtRange(sample.low != null ? fmtNum(sample.low) : null, sample.high != null ? fmtNum(sample.high) : null)), h('td', {}, trend));
  });

  const canvas = h('canvas');
  const node = h('div', {}, picker,
    h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)' } },
      h('div', { class: 'card' }, h('h2', {}, `Trend: ${byKey(reps.find((r) => byKey(r, state.trendMarker)), state.trendMarker)?.name || ''}`), h('div', { class: 'chart-box', style: { height: '280px' } }, canvas)),
      reportList),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Test'), h('th', {}, 'Unit'), reps.map((r) => h('th', {}, fmtDate(r.patient.date))), h('th', {}, 'Reference'), h('th', {}, 'Direction'))),
      h('tbody', {}, rows))),
    h('p', { class: 'small muted' }, 'Click a row to chart it. Percentages compare each report with the previous one. Values are in standard units, so reports from different labs are comparable; reference ranges can still differ between labs.'));

  requestAnimationFrame(() => {
    const pts = reps.map((r) => ({ r, x: byKey(r, state.trendMarker) })).filter((p) => p.x);
    const ref = pts[pts.length - 1]?.x;
    const labels = pts.map((p) => fmtDate(p.r.patient.date));
    const datasets = [{
      label: ref?.name, data: pts.map((p) => p.x.value), borderColor: cssVar('--accent'), backgroundColor: cssVar('--accent'), tension: 0.25, pointRadius: 5,
      pointBackgroundColor: pts.map((p) => cssVar(p.x.status === 'low' ? '--low' : p.x.status === 'high' ? '--high' : '--normal')),
    }];
    if (ref?.low != null) datasets.push({ label: 'Lower limit', data: pts.map(() => ref.low), borderColor: cssVar('--muted'), borderDash: [5, 5], pointRadius: 0, borderWidth: 1 });
    if (ref?.high != null) datasets.push({ label: 'Upper limit', data: pts.map(() => ref.high), borderColor: cssVar('--muted'), borderDash: [5, 5], pointRadius: 0, borderWidth: 1 });
    charts.push(new Chart(canvas, {
      type: 'line', data: { labels, datasets },
      options: { maintainAspectRatio: false, plugins: { legend: { labels: { color: cssVar('--text') } } },
        scales: { x: { ticks: { color: cssVar('--muted') }, grid: { color: cssVar('--border') } }, y: { ticks: { color: cssVar('--muted') }, grid: { color: cssVar('--border') }, title: { display: true, text: ref?.unit, color: cssVar('--muted') } } } },
    }));
  });
  return node;
}

function panelOf(k, reps) {
  for (const r of reps) { const x = r.rows.find((y) => y.key === k); if (x) return x.panel; }
  return 'Other';
}

/** +1 improving, -1 worsening, 0 stable — judged by distance from the reference interval. */
function trendDirection(ref, first, last) {
  const dist = (v) => (ref.low != null && v < ref.low ? ref.low - v : ref.high != null && v > ref.high ? v - ref.high : 0);
  const d0 = dist(first.value);
  const d1 = dist(last.value);
  const tol = Math.max(Math.abs(first.value) * 0.03, 1e-9);
  if (Math.abs(d1 - d0) < tol) return 0;
  return d1 < d0 ? 1 : -1;
}

// ------------------------------------------------------------------ settings
function viewSettings() {
  const s = state.settings;
  const keyInput = h('input', { type: 'password', placeholder: s.hasApiKey ? '•••••••• (saved — enter a new key to replace)' : 'Paste your Sarvam AI API subscription key', style: { width: '100%' } });
  const py = h('input', { type: 'text', value: s.pythonPath || '', placeholder: 'python3 (default)', style: { width: '100%' } });
  const model = h('input', { type: 'text', value: s.sarvamChatModel || 'sarvam-105b', style: { width: '100%' } });
  const parseLang = h('input', { type: 'text', value: s.sarvamParseLanguage || 'en-IN', style: { width: '100%' } });

  const save = async () => {
    const patch = { pythonPath: py.value.trim(), sarvamChatModel: model.value.trim() || 'sarvam-105b', sarvamParseLanguage: parseLang.value.trim() || 'en-IN', defaultEngine: state.engine };
    if (keyInput.value.trim()) patch.apiKey = keyInput.value.trim();
    try {
      state.settings = await call(api.setSettings(patch));
      toast('Settings saved.');
      await refreshPython();
      render();
    } catch (err) { toast(err.message, true); }
  };

  const eng = state.python?.engines || {};
  return h('div', { class: 'grid cols-2' },
    h('div', { class: 'card' }, h('h2', {}, 'Sarvam AI (online)'),
      h('div', { class: 'field' }, 'API subscription key', keyInput),
      h('p', { class: 'small muted' }, 'Stored encrypted with your operating system keychain. Used for online PDF parsing, and for translation / the AI narrative when Sarvam is chosen for them. Get a key at dashboard.sarvam.ai.'),
      s.hasApiKey ? h('button', { class: 'btn small danger', onclick: async () => { state.settings = await call(api.setSettings({ apiKey: '' })); toast('API key removed.'); render(); } }, 'Remove saved key') : null,
      h('div', { class: 'field mt' }, 'Chat model (world-language translation)', model),
      h('div', { class: 'field mt' }, 'Document parse language (BCP-47, e.g. en-IN, hi-IN)', parseLang)),
    localEnginesCard(py),
    aiProvidersCard(),
    translationCard(),
    h('div', { class: 'row', style: { gridColumn: '1 / -1' } }, h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: save }, 'Save settings')),
  );
}

function localEnginesCard(py) {
  const eng = state.python?.engines || {};
  const usage = state.engineInfo?.usage || {};
  const list = state.engineInfo?.list || [];
  const removeOne = async (id) => {
    if (!confirm(`Remove ${engineMeta(id)?.label || id} and its downloaded models?`)) return;
    try { await call(api.removeEngine(id)); toast('Removed.'); } catch (err) { toast(err.message, true); }
    refreshPython();
  };
  const removeAll = async () => {
    if (!confirm(`Remove all local engines installed by RADHA (${fmtMB(usage.totalMB || 0)})?\n\nYour reports and settings are not affected. You can reinstall any time from the Ingest screen.`)) return;
    try { await call(api.removeAllEngines()); toast('All local engines removed.'); } catch (err) { toast(err.message, true); }
    refreshPython();
  };
  return h('div', { class: 'card' }, h('h2', {}, 'Local parsing engines'),
    state.python?.error && !state.python.managed ? h('p', { class: 'small muted' }, 'No local engines installed yet — use the Install buttons on the Ingest screen.') :
      h('table', {}, h('tbody', {},
        h('tr', {}, h('td', {}, 'Python'), h('td', { colspan: 3 }, state.python ? `${state.python.python}${state.python.managed ? ' (RADHA engine environment)' : ` (${state.python.executable})`}` : 'checking…')),
        list.map((m) => h('tr', {},
          h('td', {}, m.label),
          h('td', {}, eng[m.id] ? h('span', { class: 'pill normal' }, 'installed') : h('span', { class: 'pill unknown' }, 'not installed')),
          h('td', { class: 'small muted' }, `≈ ${fmtMB(m.ramMB)} RAM${usage.models?.[m.id] ? ` · models ${fmtMB(usage.models[m.id])}` : ''}`),
          h('td', {}, eng[m.id] && state.python?.managed ? h('button', { class: 'link small', onclick: () => removeOne(m.id) }, 'Remove') : null))))),
    usage.totalMB ? h('p', { class: 'small muted' }, `Disk used by RADHA engines: ${fmtMB(usage.totalMB)} (programs ${fmtMB(usage.packagesMB)}, models ${fmtMB(usage.modelsMB)}).`) : null,
    h('div', { class: 'row mt' },
      h('button', { class: 'btn small', onclick: refreshPython }, 'Re-check'),
      h('button', { class: 'btn small', onclick: () => setView('ingest') }, 'Install / tune engines…'),
      usage.totalMB ? h('button', { class: 'btn small danger', onclick: removeAll }, 'Remove all local engines') : null),
    h('details', { class: 'mt' }, h('summary', { class: 'small' }, 'Advanced: use my own Python instead'),
      h('div', { class: 'field mt' }, 'Python executable (leave empty to use RADHA\'s engine environment)', py),
      h('p', { class: 'small muted' }, 'Only needed if you manage the engines yourself (pip install -r python/requirements.txt). Save settings to apply.')));
}

function aiProvidersCard() {
  const s = state.settings;
  const rows = state.aiProviders.map((p) => {
    const key = h('input', { type: 'password', placeholder: p.hasKey ? '•••••••• saved — paste to replace' : (p.optionalKey ? 'API key (optional)' : 'Paste API key'), style: { width: '100%' } });
    const model = h('input', { type: 'text', list: `models-${p.id}`, value: p.model || '', placeholder: 'model', style: { width: '100%' },
      onchange: (e) => setProviderModel(p.id, e.target.value.trim()) });
    const url = p.id === 'ollama' || p.id === 'custom'
      ? h('input', { type: 'text', value: p.id === 'ollama' ? s.ollamaUrl : s.customBaseUrl, placeholder: p.id === 'ollama' ? 'http://localhost:11434' : 'https://openrouter.ai/api/v1', style: { width: '100%' },
        onchange: async (e) => { state.settings = await call(api.setSettings({ [p.id === 'ollama' ? 'ollamaUrl' : 'customBaseUrl']: e.target.value.trim() })); } })
      : null;
    const status = p.free ? h('span', { class: 'pill normal' }, 'free · no key') : p.local ? h('span', { class: 'pill normal' }, 'local · no key')
      : p.hasKey ? h('span', { class: 'pill normal' }, 'key saved') : h('span', { class: 'pill unknown' }, p.optionalKey ? 'key optional' : 'no key');
    return h('div', { class: 'provider' + (s.aiProvider === p.id ? ' active' : '') },
      h('div', { class: 'row' }, h('b', {}, p.name), status, h('span', { class: 'spacer' }),
        h('label', { class: 'row small', style: { gap: '4px' } }, h('input', { type: 'radio', name: 'ai-default', checked: s.aiProvider === p.id,
          onchange: async () => { state.settings = await call(api.setSettings({ aiProvider: p.id })); render(); } }), 'Use for narrative')),
      h('div', { class: 'small muted', style: { margin: '2px 0 8px' } }, p.note),
      h('div', { class: 'form-grid', style: { gridTemplateColumns: url ? '1.2fr 1fr 1fr' : '1.2fr 1fr' } },
        url ? h('label', {}, p.id === 'ollama' ? 'Ollama server URL' : 'Base URL', url) : null,
        p.needsKey || p.optionalKey ? h('label', {}, 'API key', h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, key,
          h('button', { class: 'btn small', onclick: async () => {
            if (!key.value.trim()) return toast('Paste a key first.', true);
            await call(api.aiSetKey(p.id, key.value.trim())); toast(`${p.name} key saved (encrypted).`);
            if (p.id === 'sarvam') state.settings = await call(api.getSettings());
            await loadProviders(); render();
          } }, 'Save'),
          p.hasKey ? h('button', { class: 'btn small danger', onclick: async () => { await call(api.aiSetKey(p.id, '')); await loadProviders(); render(); } }, 'Remove') : null)) : null,
        h('label', {}, 'Model', h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, model,
          h('datalist', { id: `models-${p.id}` }, (state.aiModelLists[p.id] || []).map((m) => h('option', { value: m }))),
          h('button', { class: 'btn small', onclick: () => loadModels(p.id) }, 'Load models'),
          h('button', { class: 'btn small', onclick: async (e) => {
            e.target.disabled = true; e.target.textContent = 'Testing…';
            try {
              const out = await call(api.aiChat(p.id, model.value.trim(), [{ role: 'user', content: 'Reply with exactly: OK' }]));
              toast(`${p.name} works — replied: ${out.slice(0, 60)}`);
            } catch (err) { toast(err.message, true); }
            e.target.disabled = false; e.target.textContent = 'Test';
          } }, 'Test')))));
  });
  return h('div', { class: 'card', style: { gridColumn: '1 / -1' } },
    h('h2', {}, 'AI providers (narrative summary)'),
    h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Choose which AI writes the optional plain-language summary on the Clinical analysis screen. Keys are stored encrypted in your macOS keychain and are only sent to their own provider. Only de-identified results (no name or ID) are sent. Translation always uses Sarvam AI.'),
    rows);
}

// ------------------------------------------------------------------ patients
const CONDITIONS = [['diabetes', 'Diabetes / prediabetes'], ['hypertension', 'High blood pressure'], ['ckd', 'Kidney disease'],
  ['liver', 'Liver disease'], ['heart', 'Heart disease / stroke'], ['thyroid', 'Thyroid disorder']];

function patientStats(pid) {
  const reps = state.reports.filter((r) => r.pid === pid).sort((a, b) => (a.patient.date || '').localeCompare(b.patient.date || ''));
  return { reps, last: reps[reps.length - 1], first: reps[0] };
}

function viewPatients() {
  const q = state.patientSearch.toLowerCase().trim();
  const unassigned = state.reports.filter((r) => !r.pid || !profileOf(r.pid));
  const list = [...state.patients].sort((a, b) => a.name.localeCompare(b.name))
    .filter((p) => !q || [p.name, p.phone, p.email, ...(p.labIds || [])].join(' ').toLowerCase().includes(q));
  if (!state.patientSel || (!profileOf(state.patientSel) && state.patientSel !== 'unassigned')) state.patientSel = state.activePid || list[0]?.id || null;

  const listEl = h('div', { class: 'lib-list' },
    list.map((p) => {
      const st = patientStats(p.id);
      return h('button', { class: 'lib-item' + (p.id === state.patientSel ? ' active' : ''), onclick: () => { state.patientSel = p.id; render(); } },
        h('div', { class: 'lib-name' }, p.name, p.id === state.activePid ? h('span', { class: 'pill normal', style: { marginLeft: '6px' } }, 'active') : null),
        h('div', { class: 'small muted' }, [p.sex === 'M' ? 'Male' : p.sex === 'F' ? 'Female' : null, p.dob ? `${ageAt(p.dob)} y` : null,
          `${st.reps.length} report${st.reps.length === 1 ? '' : 's'}`, st.last ? `last ${fmtDate(st.last.patient.date)}` : null].filter(Boolean).join(' · ')));
    }),
    unassigned.length ? h('button', { class: 'lib-item' + (state.patientSel === 'unassigned' ? ' active' : ''), onclick: () => { state.patientSel = 'unassigned'; render(); } },
      h('div', { class: 'lib-name' }, 'Unassigned reports'), h('div', { class: 'small muted' }, `${unassigned.length} report(s) without a profile`)) : null,
    !list.length && !unassigned.length ? h('div', { class: 'small muted', style: { padding: '12px' } }, q ? 'No matching patients.' : 'No patients yet. Ingest a report or add a patient.') : null);

  const search = h('input', { type: 'text', placeholder: 'Search name, phone, email or lab ID…', value: state.patientSearch, style: { flex: 1, minWidth: '220px' },
    oninput: (e) => { state.patientSearch = e.target.value; const pos = e.target.selectionStart; render(); const i = $('#view input[type=text]'); i.focus(); i.setSelectionRange(pos, pos); } });

  const detail = state.patientSel === 'unassigned' ? unassignedPanel(unassigned) : profileOf(state.patientSel) ? patientPanel(profileOf(state.patientSel)) :
    h('div', { class: 'card empty' }, h('div', { class: 'big' }, '👤'), 'Select a patient, or add a new one.');

  return h('div', {},
    h('div', { class: 'row mb' }, search,
      h('button', { class: 'btn primary', onclick: newPatientProfile }, '+ New patient'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', title: 'Save all patients and reports to a backup file', onclick: backupData }, '⤓ Backup all data'),
      h('button', { class: 'btn', title: 'Restore patients and reports from a backup file', onclick: restoreData }, '⤒ Restore backup')),
    h('div', { class: 'lib-grid' }, listEl, h('div', { class: 'lib-detail' }, detail)));
}

async function newPatientProfile() {
  const saved = await call(api.savePatient({ name: 'New patient' }));
  await reloadReports();
  state.patientSel = saved.id;
  render();
  requestAnimationFrame(() => document.querySelector('.patient-form input')?.select());
}

function patientPanel(p) {
  const f = structuredClone(p);
  f.conditions ||= {};
  const { reps } = patientStats(p.id);
  const inp = (key, type = 'text', attrs = {}) => h('input', { type, value: f[key] ?? '', ...attrs,
    oninput: (e) => { f[key] = type === 'number' ? (e.target.value === '' ? null : +e.target.value) : e.target.value; } });
  const sel = (key, options) => h('select', { onchange: (e) => { f[key] = e.target.value; } },
    options.map(([v, l]) => h('option', { value: v, selected: (f[key] || '') === v }, l)));
  const area = (key, ph) => h('textarea', { rows: 2, placeholder: ph, oninput: (e) => { f[key] = e.target.value; } }, f[key] || '');
  const field = (label, el) => h('label', {}, label, el);
  const bmi = p.heightCm && p.weightKg ? (p.weightKg / (p.heightCm / 100) ** 2).toFixed(1) : null;

  const save = async () => {
    f.labIds = String(f.labIdsText ?? (p.labIds || []).join(', ')).split(',').map((x) => x.trim()).filter(Boolean);
    delete f.labIdsText;
    if (!f.name?.trim()) return toast('Name is required.', true);
    await call(api.savePatient(f));
    await reloadReports();
    if (state.report) state.report = state.reports.find((r) => r.id === state.report.id) || state.report;
    for (const k of Object.keys(state.translations)) delete state.translations[k];
    toast('Patient profile saved. Calculators and analysis updated for this patient.');
    render();
  };

  const others = state.patients.filter((x) => x.id !== p.id);
  return h('div', {},
    h('div', { class: 'card patient-form' },
      h('div', { class: 'row mb' }, h('h2', { style: { margin: 0 } }, p.name), h('span', { class: 'spacer' }),
        reps.length ? h('button', { class: 'btn', onclick: () => openPatient(p.id) }, 'Open latest report →') : null,
        h('button', { class: 'btn primary', onclick: save }, 'Save profile')),
      h('h3', {}, 'Identity & contact'),
      h('div', { class: 'form-grid' },
        field('Full name', inp('name')),
        field('Sex', sel('sex', [['', '— select —'], ['M', 'Male'], ['F', 'Female']])),
        field('Date of birth', inp('dob', 'date')),
        field('Age', h('input', { type: 'text', disabled: true, value: p.dob ? `${ageAt(p.dob)} years` : '—' })),
        field('Blood group', sel('bloodGroup', [['', '—'], ...['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((x) => [x, x])])),
        field('Phone', inp('phone', 'tel')),
        field('Email', inp('email', 'email')),
        field('Lab / hospital IDs (comma-separated)', h('input', { type: 'text', value: (p.labIds || []).join(', '), oninput: (e) => { f.labIdsText = e.target.value; } }))),
      field('Address', area('address', 'Optional')),
      h('h3', { class: 'mt' }, 'Body & vitals'),
      h('div', { class: 'form-grid' },
        field('Height (cm)', inp('heightCm', 'number', { step: 'any' })),
        field('Weight (kg)', inp('weightKg', 'number', { step: 'any' })),
        field('BMI', h('input', { type: 'text', disabled: true, value: bmi ? `${bmi} kg/m²` : '—' })),
        field('Last measured', h('input', { type: 'text', disabled: true, value: p.measuredOn ? fmtDate(p.measuredOn) : '—' })),
        field('Systolic BP (mmHg)', inp('sbp', 'number')),
        field('Diastolic BP (mmHg)', inp('dbp', 'number')),
        field('Smoking', sel('smoking', [['', '—'], ['never', 'Never'], ['former', 'Former'], ['current', 'Current']])),
        field('Alcohol', sel('alcohol', [['', '—'], ['none', 'None'], ['occasional', 'Occasional'], ['regular', 'Regular']]))),
      h('h3', { class: 'mt' }, 'Medical history'),
      h('div', { class: 'cond-grid' },
        CONDITIONS.map(([k, label]) => h('label', { class: 'row small', style: { gap: '6px' } },
          h('input', { type: 'checkbox', checked: Boolean(f.conditions[k]), onchange: (e) => { f.conditions[k] = e.target.checked; } }), label)),
        h('label', { class: 'row small', style: { gap: '6px' } },
          h('input', { type: 'checkbox', checked: Boolean(f.bpTreated), onchange: (e) => { f.bpTreated = e.target.checked; } }), 'Taking blood-pressure medicine')),
      h('div', { class: 'form-grid', style: { gridTemplateColumns: '1fr 1fr' } },
        field('Other conditions', area('otherConditions', 'e.g. asthma, PCOS')),
        field('Current medicines & supplements', area('medications', 'Name, dose, how often')),
        field('Allergies', area('allergies', 'Medicines, foods…')),
        field('Family history', area('familyHistory', 'e.g. father — heart attack at 55'))),
      field('Notes', area('notes', 'Anything else to remember for consultations')),
      h('p', { class: 'small muted' }, 'Used by the analysis: sex, date of birth, height and weight fill gaps in reports (eGFR, BMI, FIB-4…); known diabetes feeds the fatty-liver scores; blood pressure, BP medicine and smoking pre-fill the ASCVD heart-risk calculator. Stored only on this computer.')),

    h('div', { class: 'card mt' },
      h('div', { class: 'row mb' }, h('h2', { style: { margin: 0 } }, `Reports (${reps.length})`), h('span', { class: 'spacer' }),
        reps.length ? h('button', { class: 'btn small', onclick: () => exportPatientCsv(p, reps) }, '⤓ Results as CSV (Excel)') : null,
        h('button', { class: 'btn small', onclick: () => { state.activePid = p.id; startManual(); } }, '+ Add results manually')),
      reps.length ? reportTable(reps, others) : h('p', { class: 'muted small' }, 'No reports yet. Ingest a PDF or add results manually — choose this patient on the Verify screen.')),

    h('div', { class: 'card mt' }, h('h2', {}, 'Manage profile'),
      h('div', { class: 'row' },
        others.length ? h('select', { id: 'mergeTarget' }, others.map((x) => h('option', { value: x.id }, x.name))) : null,
        others.length ? h('button', { class: 'btn small', onclick: async () => {
          const into = $('#mergeTarget').value;
          if (!confirm(`Move all of ${p.name}'s reports into ${profileOf(into).name} and remove this duplicate profile?`)) return;
          await call(api.mergePatients(p.id, into)); await reloadReports(); state.patientSel = into; toast('Profiles merged.'); render();
        } }, 'Merge into this patient') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small danger', onclick: () => deletePatientFlow(p, reps) }, 'Delete patient…'))));
}

/** Reports saved before the date-of-birth fix may carry the DOB as their date: suggest the real one. */
function suspectDate(r) {
  if (!r.rawText) return null;
  const hdr = extractPatient(cleanText(r.rawText));
  return hdr.dob && hdr.dob === r.patient.date && hdr.date && hdr.date !== r.patient.date ? hdr : null;
}

async function fixReportDate(r, hdr) {
  const patient = { ...r.patient, date: hdr.date, dob: hdr.dob, ...(hdr.age != null ? { age: hdr.age } : {}) };
  await call(api.saveReport({ ...r, patient }));
  const prof = profileOf(r.pid);
  if (prof && !prof.dob && hdr.dob) await call(api.savePatient({ ...prof, dob: hdr.dob }));
  await reloadReports();
  for (const k of Object.keys(state.translations)) delete state.translations[k];
  toast(`Report date corrected to ${fmtDate(hdr.date)}${prof && !prof.dob ? '; date of birth added to the profile' : ''}.`);
  render();
}

function reportTable(reps, others) {
  return h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Source', 'Tests', 'Out of range', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, [...reps].reverse().map((r) => {
      const c = counts(r.rows);
      const sus = suspectDate(r);
      return h('tr', {},
        h('td', {}, fmtDate(r.patient.date), sus ? h('div', { class: 'warn-cell' }, `⚠ this is the date of birth; report dated ${fmtDate(sus.date)} `,
          h('button', { class: 'btn small', onclick: () => fixReportDate(r, sus) }, 'Fix date')) : null),
        h('td', { class: 'small muted' }, `${r.source?.fileName || '—'} · ${r.source?.engine || ''}`),
        h('td', {}, c.total),
        h('td', {}, c.low + c.high ? h('span', { style: { color: 'var(--high)' } }, String(c.low + c.high)) : '0'),
        h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
          h('button', { class: 'btn small', onclick: () => { state.report = r; state.activePid = r.pid; setView('dashboard'); maybeTranslate(); } }, 'Open'), ' ',
          h('button', { class: 'btn small', title: 'Correct values, date or details', onclick: () => editReport(r) }, 'Edit'), ' ',
          others.length ? h('select', { class: 'small', title: 'Move this report to another patient', onchange: async (e) => {
            if (!e.target.value) return;
            await call(api.saveReport({ ...r, pid: e.target.value })); await reloadReports(); toast('Report moved.'); render();
          } }, h('option', { value: '' }, 'Move to…'), others.map((x) => h('option', { value: x.id }, x.name))) : null, ' ',
          h('button', { class: 'btn small danger', onclick: async () => {
            if (!confirm(`Delete the report dated ${fmtDate(r.patient.date)}? This cannot be undone.`)) return;
            await call(api.deleteReport(r.id)); await reloadReports();
            if (state.report?.id === r.id) state.report = null;
            render();
          } }, 'Delete')));
    })));
}

function unassignedPanel(reps) {
  return h('div', { class: 'card' }, h('h2', {}, 'Unassigned reports'),
    h('p', { class: 'small muted' }, 'These reports are not linked to any patient (for example after a profile was deleted). Move each one to a patient.'),
    reportTable(reps, state.patients));
}

function openPatient(pid) {
  const { reps } = patientStats(pid);
  if (!reps.length) return;
  const lastDate = reps[reps.length - 1].patient.date;
  const sameDay = reps.filter((r) => r.patient.date === lastDate);
  state.report = sameDay.reduce((a, b) => (includedRows(b.rows).length > includedRows(a.rows).length ? b : a));
  state.activePid = pid;
  state.trendKey = groupKey(state.report);
  setView('dashboard');
  maybeTranslate();
}

async function deletePatientFlow(p, reps) {
  if (!confirm(`Delete the profile of ${p.name}?${reps.length ? `\n\nThey have ${reps.length} report(s). Next you can choose to delete them too or keep them as unassigned.` : ''}`)) return;
  const deleteReports = reps.length ? confirm(`Also permanently delete ${p.name}'s ${reps.length} report(s)?\n\nOK = delete the reports too\nCancel = keep them as "Unassigned reports"`) : false;
  await call(api.deletePatient(p.id, deleteReports));
  await reloadReports();
  if (state.report && !state.reports.some((r) => r.id === state.report.id)) state.report = null;
  if (state.activePid === p.id) state.activePid = null;
  state.patientSel = null;
  toast(deleteReports ? 'Patient and reports deleted.' : 'Patient deleted; reports kept as unassigned.');
  render();
}

function exportPatientCsv(p, reps) {
  const visits = mergeByDate(reps);
  const keys = [];
  for (const v of visits) for (const r of includedRows(v.rows)) if (!keys.includes(r.key)) keys.push(r.key);
  const q = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const lines = [['Test', 'Unit', 'Reference', ...visits.map((v) => v.patient.date)].map(q).join(',')];
  for (const k of keys) {
    const any = visits.map((v) => v.rows.find((r) => r.key === k)).filter(Boolean).pop();
    lines.push([any.name, any.unit === 'ratio' ? '' : any.unit, fmtRange(any.low, any.high),
      ...visits.map((v) => { const r = v.rows.find((x) => x.key === k && x.include !== false); return r ? `${r.value}${r.status === 'low' ? ' L' : r.status === 'high' ? ' H' : ''}` : ''; })].map(q).join(','));
  }
  const name = p.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
  call(api.saveText('﻿' + lines.join('\n'), `RADHA-${name}-results.csv`, 'CSV (Excel)', ['csv']))
    .then((out) => out && (toast(`Saved ${out.split(/[\\/]/).pop()}`), api.showItem(out))).catch((err) => toast(err.message, true));
}

async function backupData() {
  try {
    const out = await call(api.exportBackup());
    if (out) { toast(`Backup saved: ${out.split(/[\\/]/).pop()}`); api.showItem(out); }
  } catch (err) { toast(err.message, true); }
}

async function restoreData() {
  try {
    const res = await call(api.importBackup());
    if (!res) return;
    await reloadReports();
    toast(`Restored ${res.patients} patient(s) and ${res.reports} report(s).`);
    render();
  } catch (err) { toast('Restore failed: ' + err.message, true); }
}

const VIEWS = { patients: viewPatients, ingest: viewIngest, verify: viewVerify, dashboard: viewDashboard, labs: viewLabs, calculators: viewCalculators, library: viewLibrary, analysis: viewAnalysis, trends: viewTrends, settings: viewSettings };

// ------------------------------------------------------------------ translation
const langName = (code) => LANGUAGES.find((l) => l.code === code)?.name || code;
const translatorId = () => state.settings.translationProvider || 'google_free';
const translatorName = () => state.trServices.find((t) => t.id === translatorId())?.name.replace(/ — .*/, '') || translatorId();
const translationKey = (r) => `${r.id}:${state.lang}:${translatorId()}`;

function currentTranslation() {
  if (!state.report || state.lang === 'en-IN') return null;
  return state.translations[translationKey(state.report)] || null;
}

async function maybeTranslate() {
  const r = state.report;
  if (!r || state.lang === 'en-IN' || state.translations[translationKey(r)]) { render(); return; }
  const svc = state.trServices.find((t) => t.id === translatorId());
  if (svc?.needsKey && !svc.hasKey) { toast(`${svc.name} needs an API key — add it in Settings → Translation, or pick a free service next to Output language.`, true); render(); return; }
  state.translating = true;
  render();
  try {
    const bundle = await translateBundle(r, r.narrative?.text, state.lang, (texts, target) => call(api.translate(texts, target, translatorId())));
    bundle.by = translatorName();
    state.translations[translationKey(r)] = bundle;
  } catch (err) {
    toast('Translation failed: ' + err.message, true);
  } finally {
    state.translating = false;
    render();
  }
}

// ------------------------------------------------------------------ export
async function exportPdf() {
  const r = state.report;
  if (!r) return;
  if (state.lang !== 'en-IN' && !currentTranslation()) {
    if (state.translating) { toast(`Still translating into ${langName(state.lang)} — export again in a moment.`, true); return; }
    if (!confirm(`The ${langName(state.lang)} translation is not available (the translation service may be busy).\n\nExport the summary in English instead?`)) return;
  }
  const btn = $('#exportBtn');
  btn.disabled = true;
  try {
    const chartImg = renderStatusChartImage(counts(r.rows));
    const html = buildExportHtml({ ...r, patient: effectivePatient(r.patient, profileOf(r.pid)) }, { translation: currentTranslation(), narrative: r.narrative, lang: state.lang, langName: langName(state.lang), chartImg, history: mergeByDate(sameGroup(r)) });
    const safeName = (r.patient.name || 'patient').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
    const out = await call(api.exportPdf(html, `RADHA-${safeName}-${r.patient.date || 'report'}.pdf`));
    if (out) { toast(`Saved ${out.split(/[\\/]/).pop()}`); api.showItem(out); }
  } catch (err) { toast('Export failed: ' + err.message, true); }
  btn.disabled = false;
}

// ------------------------------------------------------------------ boot
async function init() {
  document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  // Stop stray drops from navigating the window away.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  const sel = $('#langSelect');
  const groupsL = [['Indian languages', LANGUAGES.filter((l) => l.indic)], ['World languages', LANGUAGES.filter((l) => !l.indic)]];
  sel.append(h('option', { value: 'en-IN' }, 'English'));
  for (const [label, list] of groupsL) sel.append(h('optgroup', { label }, list.filter((l) => l.code !== 'en-IN').map((l) => h('option', { value: l.code }, `${l.native} — ${l.name}`))));
  $('#trSelect').addEventListener('change', (e) => setTranslator(e.target.value));
  sel.addEventListener('change', async () => {
    state.lang = sel.value;
    api.setSettings({ outputLanguage: state.lang });
    await maybeTranslate();
  });
  $('#exportBtn').addEventListener('click', exportPdf);

  try { state.settings = await call(api.getSettings()); } catch (err) { toast(err.message, true); }
  state.engine = state.settings.defaultEngine || 'auto';
  state.lang = state.settings.outputLanguage || 'en-IN';
  sel.value = state.lang;
  try { await reloadReports(); } catch { state.reports = []; }
  await loadProviders();
  if (state.reports.length) {
    const latest = [...state.reports].sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''))[0];
    state.report = latest;
    state.activePid = latest.pid;
    state.trendKey = groupKey(latest);
  }
  render();
  api.onEngineProgress?.(onEngineProgress);
  refreshPython();
  ensureLibrary().then(() => { if (['calculators', 'library'].includes(state.view)) render(); }).catch(() => {});
  if (state.report && state.lang !== 'en-IN') maybeTranslate();
}

init();
