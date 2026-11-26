// RADHA web demo: the desktop app's shared modules, run in the browser on pasted text.
import { extractReport } from './shared/extractor.js';
import { runCalculators } from './shared/calculators.js';
import { analyze } from './shared/analysis.js';
import { fmtRange } from './shared/biomarkers.js';
import { extractProfileFacts, FIELD, SECTIONS, displayValue } from './shared/caseRecord.js';
import { DEMO_REPORTS } from './shared/demo.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (v == null || !Number.isFinite(v) ? '—' : String(Math.abs(v) >= 100 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100));
const SEV = { urgent: ['crit', 'Discuss promptly'], attention: ['high', 'Discuss soon'], watch: ['watch', 'Keep an eye on'], info: ['normal', 'Info'] };

let result = null;
let tab = 'values';

const PLACEHOLDER = { age: 'years', height: 'cm', weight: 'kg' };
function resetInputs() {
  for (const [id, ph] of Object.entries(PLACEHOLDER)) { $('#' + id).value = ''; $('#' + id).placeholder = ph; }
  $('#sex').value = '';
}

function loadDemo(i) {
  $('#text').value = DEMO_REPORTS[i].text;
  resetInputs();
  run();
}

function run() {
  const text = $('#text').value;
  if (!text.trim()) { $('#out').hidden = true; return; }
  const ex = extractReport(text);
  const facts = extractProfileFacts(text);
  const f = Object.fromEntries(facts.map((x) => [x.key, x.value]));
  const p = { ...ex.patient };
  // Typed-in values win; then the report header; then details found in a clinical document.
  const age = $('#age').value; const sex = $('#sex').value; const ht = $('#height').value; const wt = $('#weight').value;
  if (age) p.age = +age; if (sex) p.sex = sex;
  p.heightCm = ht ? +ht : p.heightCm || f.heightCm || null;
  p.weightKg = wt ? +wt : p.weightKg || f.weightKg || null;
  if (!age && p.age) $('#age').placeholder = `${p.age} (from report)`;
  if (!sex && p.sex) $('#sex').value = p.sex;
  if (!ht && p.heightCm) $('#height').placeholder = `${p.heightCm} (from text)`;
  if (!wt && p.weightKg) $('#weight').placeholder = `${p.weightKg} (from text)`;
  if (f.diabetesType || f.diabetesYear) p.diabetes = true;
  const inputs = {};
  if (f.bpSitting) inputs.ascvd_pce = { sbp: +String(f.bpSitting).split('/')[0], smoker: f.smokingStatus === 'yes' ? 'yes' : 'no' };
  const calc = runCalculators(ex.rows, p, inputs);
  const analysis = ex.rows.length ? analyze(ex.rows, p, calc.filter((c) => c.ready), null) : null;
  result = { ex, p, facts, calc, analysis };
  if (!ex.rows.length && facts.length) tab = 'profile';
  else if (tab === 'profile' && !facts.length) tab = 'values';
  render();
  $('#out').hidden = false;
  $('#out').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function pill(status, critical) {
  const cls = critical ? 'crit' : status === 'low' ? 'low' : status === 'high' ? 'high' : status === 'normal' ? 'normal' : 'unknown';
  return `<span class="pill ${cls}">${critical ? 'Critical' : status ? status[0].toUpperCase() + status.slice(1) : '—'}</span>`;
}

function render() {
  const { ex, p, facts, calc, analysis } = result;
  const rows = ex.rows;
  const low = rows.filter((r) => r.status === 'low').length;
  const high = rows.filter((r) => r.status === 'high').length;
  const ready = calc.filter((c) => c.ready);
  $('#kpis').innerHTML = [
    [rows.length, 'tests read'], [rows.length - low - high, 'normal'], [low, 'low'], [high, 'high'],
    [ready.length, `of ${calc.length} calculators ran`], [analysis?.observations.length ?? 0, 'observations'], [facts.length, 'profile details'],
  ].map(([v, l], i) => `<div class="kpi k${i}"><b>${v}</b><span>${l}</span></div>`).join('');

  const tabs = [['values', `Values (${rows.length})`], ['calcs', `Calculators (${ready.length})`], ['obs', `Observations (${analysis?.observations.length ?? 0})`],
    ['questions', `Questions for the doctor (${analysis?.questions.length ?? 0})`], ...(facts.length ? [['profile', `Profile details (${facts.length})`]] : [])];
  $('#tabs').innerHTML = tabs.map(([k, l]) => `<button role="tab" class="${k === tab ? 'active' : ''}" data-tab="${k}">${esc(l)}</button>`).join('');

  const who = [p.name, p.age ? `${p.age} y` : null, p.sex === 'M' ? 'Male' : p.sex === 'F' ? 'Female' : null, p.date ? `report ${p.date}` : null].filter(Boolean).join(' · ');
  const head = who ? `<p class="muted small">${esc(who)}</p>` : '';
  let html = '';
  if (tab === 'values') {
    html = rows.length ? `<p class="small muted">Read from the text and converted to standard units. In the desktop app you check and correct every row before anything is analysed.</p>
      <div class="table"><table><thead><tr><th>Test</th><th>As printed</th><th>Standard value</th><th>Reference</th><th>Status</th></tr></thead><tbody>${rows.map((r) => `
      <tr class="${r.status === 'low' || r.status === 'high' ? 'abn' : ''}"><td><b>${esc(r.name)}</b>${r.rawName && r.rawName.toLowerCase() !== r.name.toLowerCase() ? `<div class="small muted">“${esc(r.rawName)}”</div>` : ''}<div class="small muted">${esc(r.panel)}</div></td>
      <td>${esc(num(r.rawValue))} ${esc(r.rawUnit || '')}</td><td><b>${esc(num(r.value))}</b> ${esc(r.unit === 'ratio' ? '' : r.unit)}${r.converted ? '<div class="small accent">converted</div>' : ''}</td>
      <td>${esc(fmtRange(r.low != null ? num(r.low) : null, r.high != null ? num(r.high) : null))}${r.rangeSource === 'default' ? ' <span class="small muted">(default)</span>' : ''}</td><td>${pill(r.status, r.critical)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">No lab tests found in this text. If it is a clinical document, see Profile details.</p>';
  } else if (tab === 'calcs') {
    const need = calc.filter((c) => !c.ready);
    html = `<p class="small muted">Implemented from the source publications and checked against published worked examples. ${need.length} more need values not in this text (for example height, weight or blood pressure).</p>
      <div class="calcs">${ready.map((c) => `<div class="calc"><div class="cname">${esc(c.name)}</div><div class="cval">${esc(c.value ?? '—')} <span class="small muted">${esc(c.unit || '')}</span></div>
      ${c.band ? `<div class="cband sev-${esc(c.severity || '')}">${esc(c.band)}</div>` : ''}${c.interpretation ? `<div class="small">${esc(c.interpretation)}</div>` : ''}<div class="small muted">${esc(c.reference || '')}</div></div>`).join('')}</div>`;
  } else if (tab === 'obs') {
    html = analysis ? `<div class="disclaimer"><b>Not a diagnosis.</b> Observations come from fixed rules applied to the values above, to help prepare for a consultation.</div>
      <h3>${esc(analysis.headline)}</h3><p>${esc(analysis.summary)}</p>${analysis.observations.map((o) => `
      <div class="obs ${SEV[o.severity]?.[0] || ''}"><div class="row"><h4>${esc(o.title)}</h4><span class="spacer"></span><span class="pill ${SEV[o.severity]?.[0] || ''}">${SEV[o.severity]?.[1] || ''}</span></div>
      <p>${esc(o.detail)}</p><p class="small"><b>Evidence:</b> ${esc(o.evidence.join(' · '))}</p><b class="small">Suggested next steps</b><ul>${o.nextSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`).join('')}` : '<p class="muted">No lab values to analyse.</p>';
  } else if (tab === 'questions') {
    const groups = [];
    for (const q of analysis?.questions || []) { let g = groups.find((x) => x.topic === q.topic); if (!g) groups.push((g = { topic: q.topic, items: [] })); g.items.push(q.text); }
    let n = 0;
    html = groups.length ? `<p class="small muted">Written by rules from the findings, out-of-range values and calculator results. Take them to your appointment.</p>${groups.map((g) => `<div class="qgroup"><h4>${esc(g.topic)}</h4><ol start="${n + 1}">${g.items.map((t) => { n++; return `<li>${esc(t)}</li>`; }).join('')}</ol></div>`).join('')}` : '<p class="muted">No questions.</p>';
  } else if (tab === 'profile') {
    html = `<p class="small muted">Patient details read from the document for the patient profile, each with the line it came from. In the desktop app they are saved to the profile with a link back to the document.</p>
      ${SECTIONS.map(([sec, title]) => { const items = facts.filter((x) => FIELD[x.key]?.section === sec); return items.length ? `<h4>${esc(title)}</h4><div class="table"><table><tbody>${items.map((x) => `<tr><td>${esc(FIELD[x.key].label)}</td><td><b>${esc(displayValue(x.key, x.value))}</b></td><td class="printed">“${esc(x.printed)}”${x.page ? ` <span class="muted">· p. ${x.page}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''; }).join('')}`;
  }
  $('#panel').innerHTML = head + html;
}

document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-demo]'); if (d) loadDemo(+d.dataset.demo);
  const t = e.target.closest('[data-tab]'); if (t) { tab = t.dataset.tab; render(); }
});
$('#run').addEventListener('click', run);
$('#clear').addEventListener('click', () => { $('#text').value = ''; $('#out').hidden = true; resetInputs(); });
for (const id of ['age', 'sex', 'height', 'weight']) $('#' + id).addEventListener('change', () => { if (result) run(); });
loadDemo(2);
