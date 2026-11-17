// Interactive panel for the calculator library: every one of the ~2,000 library calculators can be
// filled in, and a result is shown in one of three ways —
//   1. RADHA's own verified implementation (deterministic, reuses calculators.js),
//   2. a points score read from the calculator's published points table (deterministic, built by
//      scripts/calculator_scoring.py; each answer's points are shown so they can be checked),
//   3. otherwise, an optional AI calculation from the calculator's formula and the entered values,
//      clearly labelled as not verified.
// Values from the open report (age, sex, height, weight, lab results) are filled in automatically
// and can be edited.
import { BIOMARKERS, BY_KEY, toCanonical } from '../shared/biomarkers.js';
import { CALCULATORS, buildContext } from '../shared/calculators.js';

const SEV_COLOR = { ok: 'var(--normal)', mild: 'var(--warn)', moderate: 'var(--high)', severe: 'var(--crit)' };
export const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const fnum = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/** replaceChildren that skips empty (null/false) parts. */
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const UNIT_PREF = ['mmHg', 'mm Hg', 'yr', 'years', 'Degrees C', 'degC', 'Cel', '%', 'kg', 'cm', 'mg/dL', 'meters', 'm', 'mL', 'min'];
const defaultUnit = (units, dflt) => (dflt != null && Math.abs(dflt) <= 1 && units.find((u) => /^(fraction|ratio)$/i.test(u))) || UNIT_PREF.find((u) => units.includes(u)) || units[0];
const defaultValue = (inp) => inp.help?.match(/^default\s+(-?[\d.]+)$/)?.[1];
const fmt = (x) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100));

// ------------------------------------------------------------------ patient facts from the open report
export function patientFacts(report) {
  const p = report?.patient || {};
  const rows = (report?.rows || []).filter((r) => r.include !== false && r.value != null && Number.isFinite(r.value));
  const heightCm = fnum(p.heightCm); const weightKg = fnum(p.weightKg);
  return {
    has: Boolean(report), age: fnum(p.age), sex: p.sex === 'M' || p.sex === 'F' ? p.sex : null, heightCm, weightKg,
    bmi: heightCm && weightKg ? weightKg / (heightCm / 100) ** 2 : null,
    byKey: Object.fromEntries(rows.map((r) => [r.key, r])), patient: p, rows,
  };
}

const MARKER_RX = BIOMARKERS.map((b) => ({ b, rx: new RegExp(`^(?:${[b.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ...b.aliases].join('|')})$`, 'i') }));
function markerFor(text) {
  const t = stripTags(text).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/,.*$/, '').replace(/^(serum|plasma|blood|total|fasting)\s+/, '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return MARKER_RX.find((m) => m.rx.test(t))?.b || null;
}

const AGE_LABEL = /^(patient'?s? )?age\b(?!.*(gestation|onset|diagnos|menarche|first))/i;
const cmp = (op, a, b) => ({ '>': a > b, '<': a < b, '≥': a >= b, '>=': a >= b, '≤': a <= b, '<=': a <= b }[op]);

/** Parse an age-bracket option ("<65", "65-74 years", "≥75 Years", "18–39") into [lo, hi] (inclusive). */
function ageRange(o) {
  const s = stripTags(o).toLowerCase().replace(/years?( old)?|yrs?|y\b/g, '').replace(/–|—/g, '-').trim();
  let m;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/))) return [+m[1], +m[2]];
  if ((m = s.match(/^(≥|>=|>)\s*(\d+(?:\.\d+)?)$/))) return [m[1] === '>' ? +m[2] + 1e-9 : +m[2], Infinity];
  if ((m = s.match(/^(≤|<=|<)\s*(\d+(?:\.\d+)?)$/))) return [-Infinity, m[1] === '<' ? +m[2] - 1e-9 : +m[2]];
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*\+$/))) return [+m[1], Infinity];
  return null;
}

const YES = /^(yes|present|true|positive)$/i;
const NO = /^(no|absent|false|negative)$/i;

/**
 * Suggest a value for a library input from the report: { value, from } or null.
 * Choice inputs return the option index; number inputs return { value, unit }.
 */
export function suggest(input, f) {
  if (!f.has) return null;
  const label = stripTags(input.label);
  const opts = (input.options || []).map(stripTags);
  if (input.type === 'choice') {
    // Sex / gender
    const mi = opts.findIndex((o) => /^male\b/i.test(o)); const fi = opts.findIndex((o) => /^female\b/i.test(o));
    if (f.sex && mi >= 0 && fi >= 0 && (/sex|gender/i.test(label) || opts.length === 2)) return { value: f.sex === 'M' ? mi : fi, from: f.sex === 'M' ? 'Male' : 'Female' };
    // Age brackets
    if (f.age != null && AGE_LABEL.test(label)) {
      const ranges = opts.map(ageRange);
      if (ranges.every(Boolean)) {
        const i = ranges.findIndex(([lo, hi]) => f.age >= lo && f.age <= hi);
        if (i >= 0) return { value: i, from: `age ${f.age}` };
      }
    }
    // Yes/No thresholds: "Age ≥60 years", "Creatinine >2.0 mg/dL", "WBC >12.0 × 10⁹/µL"
    const yi = opts.findIndex((o) => YES.test(o)); const ni = opts.findIndex((o) => NO.test(o));
    if (yi >= 0 && ni >= 0 && opts.length === 2) {
      const m = label.match(/^(.+?)\s*(≥|≤|>=|<=|>|<)\s*([\d.,]+)\s*([^()]*?)(\s*\(.*)?$/);
      if (m) {
        const [, name, op, numText, unitText] = m;
        const thr = Number(numText.replace(/,/g, ''));
        if (Number.isFinite(thr)) {
          if (AGE_LABEL.test(name) && f.age != null && (!unitText || /^(years?|yrs?|y)\b/i.test(unitText.trim()))) {
            return { value: cmp(op, f.age, thr) ? yi : ni, from: `age ${f.age}` };
          }
          const b = markerFor(name);
          const row = b && f.byKey[b.key];
          if (row && unitText.trim()) {
            const unit = unitText.trim().replace(/×\s*10⁹\s*\/\s*l/i, '10^9/L').replace(/x\s*10\s*9\s*\/\s*l/i, '10^9/L');
            const c = toCanonical(b.key, thr, unit);
            if (c.unitKnown) return { value: cmp(op, row.value, c.value) ? yi : ni, from: `${row.name} ${fmt(row.value)} ${row.unit === 'ratio' ? '' : row.unit}`.trim() };
          }
        }
      }
    }
    return null;
  }
  // Numbers
  if (AGE_LABEL.test(label) && f.age != null && !(input.units || []).length) return { value: f.age, unit: 'years', from: 'report' };
  if (AGE_LABEL.test(label) && f.age != null) return { value: f.age, unit: (input.units || []).find((u) => /^y/i.test(u)) || 'years', from: 'report' };
  if (/^(body )?height\b/i.test(label) && f.heightCm) return { value: f.heightCm, unit: 'cm', from: 'profile' };
  if (/^(body |actual |current )?weight\b/i.test(label) && f.weightKg) return { value: f.weightKg, unit: 'kg', from: 'profile' };
  if (/^(bmi|body mass index)\b/i.test(label) && f.bmi) return { value: Math.round(f.bmi * 10) / 10, unit: 'kg/m²', from: 'profile' };
  const b = markerFor(label);
  const row = b && f.byKey[b.key];
  if (row) return { value: row.value, unit: row.unit === 'ratio' ? '' : row.unit, from: 'report' };
  return null;
}

// ------------------------------------------------------------------ which version / mode
export function pickVersion(entry) {
  const vs = entry.versions.map((v, i) => ({ v, i })).filter(({ v }) => v.inputs?.length);
  return (vs.find(({ v }) => v.score) || vs.sort((a, b) => b.v.inputs.length - a.v.inputs.length)[0])?.i ?? 0;
}

function formulaText(v) {
  return [v.formula && `Formula:\n${v.formula}`, v.equations?.length && `Equations:\n${v.equations.join('\n')}`,
    v.interpretation && `Interpretation:\n${v.interpretation}`, v.results?.length && `Results to report: ${v.results.join(', ')}`,
    !v.formula && !v.equations?.length && v.about && `About:\n${v.about}`, v.notes && `Notes:\n${v.notes}`].filter(Boolean).join('\n\n');
}

// ------------------------------------------------------------------ panel
/**
 * ctx: { h, report, implId, store (object kept across renders), ai: { provider, name, ask(messages) → text } , onOpenCalculators }
 */
export function calcPanel(entry, ctx) {
  const { h } = ctx;
  const root = h('div', { class: 'lc card' });
  const f = patientFacts(ctx.report);
  const st = (ctx.store[entry.id] ||= { version: null, vals: {}, ai: null });

  const draw = () => {
    const impl = ctx.implId && CALCULATORS.find((c) => c.id === ctx.implId);
    const withInputs = entry.versions.map((v, i) => ({ v, i })).filter(({ v }) => v.inputs?.length);
    if (st.version == null) st.version = pickVersion(entry);
    const v = entry.versions[st.version] || entry.versions[0];
    let body;
    if (impl && st.mode !== 'library') body = implForm(impl);
    else if (v.score) body = scoreForm(v);
    else if (v.inputs?.length) body = aiForm(v);
    else body = h('p', { class: 'small muted' }, 'This entry has no input list, so it cannot be calculated here. See the formula and description below.');

    const versionPick = !(impl && st.mode !== 'library') && withInputs.length > 1
      ? h('div', { class: 'tabs lc-vers' }, withInputs.map(({ v: x, i }) => h('button', { class: i === st.version ? 'active' : '', onclick: () => { st.version = i; st.ai = null; draw(); } },
        `Version ${i + 1}${x.score ? ' · auto-scored' : ''}`)))
      : null;
    const kind = impl && st.mode !== 'library' ? ['verified', '✓ Verified RADHA calculator — runs instantly']
      : v.score ? ['scored', 'Σ Auto-scored from the published points table — updates as you answer']
        : ['ai', '✎ Enter the values — RADHA can compute this one with your AI provider'];
    put(root, 
      h('div', { class: 'row lc-head' }, h('h3', {}, 'Calculate'), h('span', { class: `lc-kind ${kind[0]}` }, kind[1]), h('span', { class: 'spacer' }),
        impl ? h('button', { class: 'link small', onclick: () => { st.mode = st.mode === 'library' ? null : 'library'; draw(); } }, st.mode === 'library' ? 'Use RADHA\'s calculator' : 'Show the library form') : null),
      f.has ? h('div', { class: 'small muted' }, 'Values marked ', h('span', { class: 'lc-from' }, 'report'), ' were filled in from the open report — change any of them.')
        : h('div', { class: 'small muted' }, 'Open a report to fill in age, sex and lab values automatically.'),
      versionPick, body);
  };

  // ---------- 1. RADHA's own implementation
  function implForm(c) {
    const keys = [...new Set([...c.requires, ...(c.anyOf || []).flat()])];
    const vals = (st.implVals ||= {});
    const p0 = f.patient;
    const initial = {
      age: f.age, sex: f.sex, height: f.heightCm, weight: f.weightKg,
      ...Object.fromEntries(keys.filter((k) => BY_KEY[k]).map((k) => [k, f.byKey[k]?.value])),
      ...(ctx.report?.calcInputs?.[c.id] || {}),
    };
    const get = (k) => (k in vals ? vals[k] : initial[k] ?? '');
    const out = h('div', { class: 'lc-result' });
    const demo = new Set(keys.flatMap((k) => (k === 'bmi' ? ['height', 'weight'] : ['age', 'sex', 'height', 'weight'].includes(k) ? [k] : [])));
    const fields = [];
    const numField = (k, label, unit, fromReport) => h('label', {}, h('span', {}, label, unit ? h('span', { class: 'muted' }, ` (${unit})`) : null, fromReport ? h('span', { class: 'lc-from' }, 'report') : null),
      h('input', { type: 'number', step: 'any', value: get(k), oninput: (e) => { vals[k] = e.target.value; compute(); } }));
    for (const k of ['age', 'sex', 'height', 'weight']) {
      if (!demo.has(k)) continue;
      if (k === 'sex') fields.push(h('label', {}, h('span', {}, 'Sex', initial.sex && !('sex' in vals) ? h('span', { class: 'lc-from' }, 'report') : null),
        h('select', { onchange: (e) => { vals.sex = e.target.value; compute(); } }, h('option', { value: '' }, '— select —'),
          h('option', { value: 'M', selected: get('sex') === 'M' }, 'Male'), h('option', { value: 'F', selected: get('sex') === 'F' }, 'Female'))));
      else fields.push(numField(k, { age: 'Age', height: 'Height', weight: 'Weight' }[k], { age: 'years', height: 'cm', weight: 'kg' }[k], initial[k] != null && initial[k] !== ''));
    }
    for (const k of keys) if (BY_KEY[k]) fields.push(numField(k, BY_KEY[k].name, BY_KEY[k].unit === 'ratio' ? '' : BY_KEY[k].unit, f.byKey[k] != null));
    for (const e of c.extras || []) {
      if (e.fromLab && keys.includes(e.fromLab)) continue;
      const cur = get('x:' + e.id) === '' ? (initial[e.id] ?? e.default ?? '') : get('x:' + e.id);
      fields.push(h('label', {}, h('span', {}, e.label, e.unit ? h('span', { class: 'muted' }, ` (${e.unit})`) : null, e.optional ? h('span', { class: 'muted' }, ' — optional') : null),
        e.type === 'select' || e.type === 'bool'
          ? h('select', { onchange: (ev) => { vals['x:' + e.id] = ev.target.value; compute(); } }, h('option', { value: '' }, '— select —'),
            (e.options || [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]).map((o) => h('option', { value: o.value, selected: String(cur) === String(o.value) }, o.label)))
          : h('input', { type: 'number', step: 'any', value: cur, oninput: (ev) => { vals['x:' + e.id] = ev.target.value; compute(); } })));
    }
    function compute() {
      const rows = keys.filter((k) => BY_KEY[k] && fnum(get(k)) != null).map((k) => ({ key: k, value: fnum(get(k)), include: true, ...(f.byKey[k] ? { low: f.byKey[k].low, high: f.byKey[k].high } : {}) }));
      const patient = { ...p0, age: fnum(get('age')), sex: get('sex') || null, heightCm: fnum(get('height')), weightKg: fnum(get('weight')) };
      const { v, p } = buildContext(rows, patient);
      const has = (k) => (['age', 'sex', 'height', 'weight', 'bmi'].includes(k) ? p[k] != null && p[k] !== '' && !Number.isNaN(p[k]) : v[k] != null);
      const missing = c.requires.filter((k) => !has(k)).concat((c.anyOf || []).filter((g) => !g.some(has)).map((g) => g.join(' or ')));
      const x = {};
      for (const e of c.extras || []) {
        const raw = get('x:' + e.id) === '' ? (initial[e.id] ?? e.default ?? '') : get('x:' + e.id);
        x[e.id] = e.type === 'number' ? (raw === '' || raw == null ? null : Number(raw)) : e.type === 'bool' ? (raw === '' ? null : raw === true || raw === 'true') : raw;
      }
      const needX = (c.extras || []).filter((e) => !e.optional && !(e.fromLab && v[e.fromLab] != null) && (x[e.id] == null || x[e.id] === '' || (e.type === 'number' && !Number.isFinite(x[e.id]))));
      if (missing.length || needX.length) {
        put(out, h('div', { class: 'small muted' }, 'Fill in: ', [...missing.map((k) => BY_KEY[k]?.name || k), ...needX.map((e) => e.label)].join(', ')));
        return;
      }
      try {
        const r = c.compute(v, p, x);
        if (r.value != null && !Number.isFinite(r.value)) throw new Error('result is not a number — check the inputs');
        put(out, 
          h('div', { class: 'lc-value' }, r.value ?? '—', ' ', h('small', {}, r.value == null ? '' : r.unit || '')),
          h('div', { class: 'lc-band', style: { color: SEV_COLOR[r.severity] } }, r.band),
          r.interpretation ? h('div', { class: 'small' }, r.interpretation) : null,
          h('div', { class: 'small muted', style: { marginTop: '6px' } }, c.reference));
      } catch (err) { put(out, h('div', { class: 'small', style: { color: 'var(--crit)' } }, 'Could not calculate: ', err.message)); }
    }
    compute();
    return h('div', {}, h('div', { class: 'form-grid lc-grid' }, fields), out,
      ctx.report && ctx.onOpenCalculators ? h('button', { class: 'link small', onclick: () => ctx.onOpenCalculators(c.id) }, 'Open in Calculators (saves typed values with the report) →') : null);
  }

  // ---------- 2. points score
  function scoreForm(v) {
    const vals = (st.vals[st.version] ||= {});
    const auto = {};
    v.inputs.forEach((inp, i) => { const s = suggest(inp, f); if (s && s.value != null) auto[i] = s; });
    const out = h('div', { class: 'lc-result' });
    const rows = v.score.items.map((it) => {
      const inp = v.inputs[it.input];
      const chips = h('div', { class: 'lc-chips' });
      const drawChips = () => {
        const cur = it.input in vals ? vals[it.input] : auto[it.input]?.value;
        put(chips, ...inp.options.map((o, oi) => h('button', {
          class: 'lc-chip' + (cur === oi ? ' on' : ''),
          onclick: () => { vals[it.input] = cur === oi ? null : oi; drawChips(); total(); },
        }, stripTags(o), h('b', {}, `${it.points[oi] > 0 ? '+' : ''}${fmt(it.points[oi])}`))));
      };
      drawChips();
      const a = auto[it.input];
      return h('div', { class: 'lc-q' }, h('div', { class: 'lc-qlabel' }, stripTags(inp.label), a && !(it.input in vals) ? h('span', { class: 'lc-from', title: `From ${a.from}` }, 'report') : null,
        inp.help && inp.help !== 'optional' ? h('div', { class: 'small muted' }, stripTags(inp.help)) : null), chips);
    });
    function total() {
      let sum = 0; let answered = 0;
      for (const it of v.score.items) {
        const cur = it.input in vals ? vals[it.input] : auto[it.input]?.value;
        if (cur != null) { sum += it.points[cur]; answered++; }
      }
      sum = Math.round(sum * 100) / 100;
      const n = v.score.items.length;
      const b = v.score.bands;
      const match = b && answered === n ? b.rows.find(({ range: [lo, hi, strict] }) => (lo == null || (strict === 'gt' ? sum > lo : sum >= lo)) && (hi == null || (strict === 'lt' ? sum < hi : sum <= hi))) : null;
      put(out, 
        h('div', { class: 'row' }, h('div', { class: 'lc-value' }, fmt(sum), ' ', h('small', {}, 'points')), h('span', { class: 'spacer' }),
          h('span', { class: 'small muted' }, answered === n ? 'All items answered' : `${answered} of ${n} answered — the total counts answered items only`),
          h('button', { class: 'link small', onclick: () => { for (const it of v.score.items) vals[it.input] = null; draw(); } }, 'Clear')),
        match ? h('table', { class: 'lib-table lc-band-table' }, h('tbody', {}, b.head.map((hd, i) => h('tr', {}, h('td', { class: 'muted' }, stripTags(hd)), h('td', {}, h('b', {}, stripTags(match.cells[i]))))))) : null,
        b && answered === n && !match ? h('div', { class: 'small muted' }, 'This total is outside the interpretation table below — read the interpretation section.') : null,
        !b && v.interpretation ? h('div', { class: 'small muted' }, 'See the interpretation section below for what this score means.') : null);
    }
    total();
    return h('div', {}, h('div', { class: 'lc-qs' }, rows), out,
      h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Points for each answer are taken from the published table shown under Formula below. Check them before relying on the result.'));
  }

  // ---------- 3. any other calculator: editable inputs + AI calculation
  function aiForm(v) {
    const vals = (st.vals[st.version] ||= {});
    const fields = v.inputs.map((inp, i) => {
      const s = suggest(inp, f);
      if (!(i in vals) && s) vals[i] = inp.type === 'choice' ? { value: s.value, auto: true, from: s.from } : { value: s.value, unit: s.unit, auto: true };
      else if (!(i in vals) && defaultValue(inp) != null) vals[i] = { value: defaultValue(inp) };
      if (inp.units?.length && vals[i] && !inp.units.includes(vals[i].unit)) vals[i] = { ...vals[i], unit: defaultUnit(inp.units, defaultValue(inp)) };
      if (inp.units?.length && !vals[i]) vals[i] = { unit: defaultUnit(inp.units, defaultValue(inp)) };
      const cur = vals[i] || {};
      const lbl = h('span', {}, stripTags(inp.label), cur.auto ? h('span', { class: 'lc-from', title: cur.from ? `From ${cur.from}` : '' }, 'report') : null,
        inp.help && inp.help !== 'optional' && !defaultValue(inp) ? h('span', { class: 'muted' }, ` — ${stripTags(inp.help)}`) : null, inp.help === 'optional' ? h('span', { class: 'muted' }, ' — optional') : null);
      if (inp.type === 'choice') {
        return h('label', {}, lbl, h('select', { onchange: (e) => { vals[i] = e.target.value === '' ? {} : { value: Number(e.target.value) }; } },
          h('option', { value: '' }, '— select —'), inp.options.map((o, oi) => h('option', { value: oi, selected: cur.value === oi }, stripTags(o)))));
      }
      return h('label', {}, lbl, h('div', { class: 'row lc-numunit' },
        h('input', { type: 'number', step: 'any', value: cur.value ?? '', oninput: (e) => { vals[i] = { ...vals[i], value: e.target.value, auto: false }; } }),
        inp.units?.length
          ? h('select', { onchange: (e) => { vals[i] = { ...vals[i], unit: e.target.value }; } }, inp.units.map((u) => h('option', { value: u, selected: (cur.unit || defaultUnit(inp.units, defaultValue(inp))) === u }, u)))
          : h('input', { type: 'text', placeholder: 'unit', value: cur.unit || '', style: { width: '90px' }, oninput: (e) => { vals[i] = { ...vals[i], unit: e.target.value }; } })));
    });
    const out = h('div', { class: 'lc-result' });
    const showAi = () => {
      if (!st.ai) { put(out, ); return; }
      if (st.ai.busy) { put(out, h('div', { class: 'small' }, h('span', { class: 'spinner' }), ' Calculating with ', st.ai.provider, '…')); return; }
      if (st.ai.error) { put(out, h('div', { class: 'small', style: { color: 'var(--crit)' } }, st.ai.error)); return; }
      const m = st.ai.text.match(/^\s*result\s*:\s*(.+)$/im);
      put(out, 
        m ? h('div', { class: 'lc-value lc-ai-value' }, m[1].trim()) : null,
        h('div', { class: 'lib-text small lc-ai' }, st.ai.text.replace(/^\s*result\s*:.*$/im, '').trim()),
        h('div', { class: 'lc-warn small' }, `Calculated by AI (${st.ai.provider}) from this calculator's formula — not verified by RADHA. Check the working before relying on it.`));
    };
    const run = async () => {
      const entered = v.inputs.map((inp, i) => {
        const x = vals[i];
        if (!x || x.value === '' || x.value == null) return `- ${stripTags(inp.label)}: (not entered)`;
        return `- ${stripTags(inp.label)}: ${inp.type === 'choice' ? stripTags(inp.options[x.value]) : `${x.value}${x.unit ? ' ' + x.unit : ''}`}`;
      });
      if (!entered.some((l) => !l.endsWith('(not entered)'))) { st.ai = { error: 'Enter at least one value first.' }; showAi(); return; }
      const prov = ctx.ai.providers.find((p) => p.id === ctx.ai.current());
      if (prov.needs) { st.ai = { error: `${prov.name} needs ${prov.needs} — add it in Settings → AI providers, or pick another provider.` }; showAi(); return; }
      st.ai = { busy: true, provider: prov.name }; showAi();
      try {
        const text = await ctx.ai.ask(prov.id, [
          { role: 'system', content: 'You are a precise medical calculator. Compute the named calculator using ONLY the documentation and the input values given. ' +
            'Reply in plain text, no markdown. First line exactly: "Result: <value with unit or points> — <category/interpretation if the documentation gives one>". ' +
            'Then "Working:" with a short step-by-step calculation (points per item, or the formula with the numbers substituted). ' +
            'If a required value is missing or the documentation does not contain enough to compute it, the first line must be "Result: cannot be calculated" followed by what is missing. ' +
            'Never invent coefficients or point values that are not in the documentation. Keep it under 180 words.' },
          { role: 'user', content: `Calculator: ${entry.name}\n\n${formulaText(v).slice(0, 9000)}\n\nInput values:\n${entered.join('\n')}` },
        ]);
        st.ai = { text, provider: prov.model ? `${prov.name} · ${prov.model}` : prov.name };
      } catch (err) { st.ai = { error: err.message }; }
      showAi();
    };
    showAi();
    const canCompute = Boolean(v.formula || v.equations?.length);
    const aiRow = h('div', { class: 'lc-airow' });
    const drawAiRow = () => {
      if (!ctx.ai) { put(aiRow, h('span', { class: 'small muted' }, 'AI providers could not be loaded.')); return; }
      const cur = ctx.ai.providers.find((p) => p.id === ctx.ai.current());
      put(aiRow,
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
          h('button', { class: 'btn primary small', onclick: run, disabled: Boolean(cur.needs) }, `Calculate with ${cur.name}`),
          h('label', { class: 'row small', style: { gap: '6px' } }, 'AI provider',
            h('select', { onchange: async (e) => { await ctx.ai.choose(e.target.value); st.ai = null; showAi(); drawAiRow(); } },
              ctx.ai.providers.map((p) => h('option', { value: p.id, selected: p.id === cur.id }, `${p.label}${p.needs ? ` (needs ${p.needs})` : ''}`)))),
          cur.needs ? h('button', { class: 'link small', onclick: ctx.ai.openSettings }, `Add ${cur.needs} in Settings →`) : null),
        h('div', { class: 'small muted' }, cur.note, ' ', canCompute ? 'Only the calculator\'s formula and the values above are sent — no name or report.' : 'This entry has no formula text; the AI may not be able to compute it.'));
    };
    drawAiRow();
    return h('div', {},
      h('div', { class: 'form-grid lc-grid' }, fields),
      aiRow,
      out);
  }

  draw();
  return root;
}
