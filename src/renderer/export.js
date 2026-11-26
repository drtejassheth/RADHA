// Builds the standalone HTML that the main process prints to PDF.
import { PANELS, fmtRange } from '../shared/biomarkers.js';
import { RTL } from './translate.js';
import { SECTIONS, FIELDS, getValue, displayValue, derived } from '../shared/caseRecord.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => (v == null || !Number.isFinite(v) ? '—' : String(Math.abs(v) >= 100 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100));
const COLORS = { normal: '#2e8b57', low: '#2f6fcf', high: '#d2552b', critical: '#b3122f', unknown: '#8a94a3' };

/** Render the Normal/Low/High doughnut to a PNG data URL (offscreen, no animation). */
export function renderStatusChartImage(c) {
  const canvas = document.createElement('canvas');
  canvas.width = 520;
  canvas.height = 360;
  const chart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: [`Normal (${c.normal})`, `Low (${c.low})`, `High (${c.high})`, `No range (${c.unknown})`],
      datasets: [{ data: [c.normal, c.low, c.high, c.unknown], backgroundColor: [COLORS.normal, COLORS.low, COLORS.high, COLORS.unknown], borderColor: '#fff', borderWidth: 2 }],
    },
    options: { responsive: false, animation: false, devicePixelRatio: 2, cutout: '60%', plugins: { legend: { position: 'right', labels: { font: { size: 15 }, color: '#1a2230' } } } },
  });
  const url = canvas.toDataURL('image/png');
  chart.destroy();
  return url;
}

function questionsHtml(questions) {
  let html = '';
  let n = 0;
  let topic = null;
  for (const raw of questions || []) {
    const q = typeof raw === 'string' ? { topic: 'General', text: raw } : raw;
    if (q.topic !== topic) {
      if (topic !== null) html += '</ol>';
      topic = q.topic;
      html += `<h3 class="qt">${esc(topic)}</h3><ol start="${n + 1}">`;
    }
    n++;
    html += `<li>${esc(q.text)}</li>`;
  }
  return topic === null ? '' : html + '</ol>';
}

/** Filled clinical-record details of the patient profile, grouped by section, each with its source. */
function clinicalRecordHtml(profile) {
  if (!profile) return '';
  const fmtSrc = (s) => (!s ? '' : s.kind === 'manual' ? 'entered by hand' : `${s.fileName || 'document'}${s.date ? `, ${s.date}` : ''}${s.page ? `, p. ${s.page}` : ''}`);
  const groups = SECTIONS.map(([sec, title]) => {
    const items = FIELDS.filter((f) => f.section === sec).map((f) => [f, getValue(profile, f.key)]).filter(([, v]) => v != null && v !== '');
    if (!items.length) return '';
    return `<tr><th colspan="3">${esc(title)}</th></tr>` + items.map(([f, v]) =>
      `<tr><td>${esc(f.label)}</td><td><b>${esc(displayValue(f.key, v))}</b></td><td class="ref">${esc(fmtSrc(profile.sources?.[f.key]))}</td></tr>`).join('');
  }).join('');
  if (!groups) return '';
  const dv = derived(profile);
  const notes = [dv.diabetesDuration != null ? `Diabetes for about ${dv.diabetesDuration} year(s)` : '', dv.whr != null ? `waist–hip ratio ${dv.whr}` : '', dv.packYears != null ? `${dv.packYears} pack-years` : ''].filter(Boolean).join(' · ');
  return `<h2>Clinical record (from the patient profile)</h2>${notes ? `<p>${esc(notes)}</p>` : ''}<table class="rec"><tbody>${groups}</tbody></table>`;
}

export function buildExportHtml(report, { translation, narrative, lang, langName, chartImg, history = [], profile = null }) {
  const p = report.patient;
  const a = translation?.analysis || report.analysis;
  const calcT = (id) => translation?.calc?.find((c) => c.id === id);
  const rows = report.rows.filter((r) => r.include !== false && r.value != null);
  const n = { total: rows.length, normal: 0, low: 0, high: 0, unknown: 0, critical: 0 };
  for (const r of rows) { n[r.status]++; if (r.critical) n.critical++; }
  const translatedNote = translation ? `<p class="note">Interpretations and advice translated into ${esc(langName)} by ${esc(translation.by || 'machine translation')} (machine translation — check with your doctor if anything is unclear). Test names, values and units are kept as printed on the lab report.</p>` : '';
  const dir = translation && RTL.has(lang) ? 'rtl' : 'ltr';

  const labRows = PANELS.filter((pn) => rows.some((r) => r.panel === pn)).map((pn) => {
    const items = rows.filter((r) => r.panel === pn);
    return `<tr class="ph"><td colspan="5">${esc(pn)}</td></tr>` + items.map((r) => {
      const st = r.critical ? 'critical' : r.status;
      const label = r.critical ? 'CRITICAL' : { low: 'LOW', high: 'HIGH', normal: 'Normal', unknown: '—' }[r.status];
      return `<tr><td>${esc(r.name)}</td><td class="num"><b style="color:${st === 'normal' ? 'inherit' : COLORS[st]}">${fmt(r.value)}</b></td><td>${esc(r.unit === 'ratio' ? '' : r.unit)}</td><td class="num">${esc(fmtRange(r.low != null ? fmt(r.low) : null, r.high != null ? fmt(r.high) : null))}</td><td><span class="st" style="color:${COLORS[st]}">${label}</span></td></tr>`;
    }).join('');
  }).join('');

  const calcRows = report.calc.filter((c) => c.ready).map((c) => {
    const t = calcT(c.id);
    return `<tr><td><b>${esc(c.name)}</b><div class="ref">${esc(c.reference)}</div></td><td class="num">${esc(c.value ?? '—')} <span class="u">${esc(c.unit)}</span></td><td><b>${esc(t?.band || c.band)}</b><div>${esc(t?.interpretation || c.interpretation)}</div></td></tr>`;
  }).join('');

  const obs = a.observations.map((o, i) => `
    <div class="obs ${o.severity}">
      <h3>${esc(o.title)}</h3>
      <p>${esc(o.detail)}</p>
      <p class="ev"><b>Evidence:</b> ${esc(report.analysis.observations[i].evidence.join(' · '))}</p>
      <ul>${o.nextSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    </div>`).join('');

  let trendHtml = '';
  if (history.length > 1) {
    const reps = history;
    const keys = [...new Set(reps.flatMap((r) => r.rows.filter((x) => x.include !== false).map((x) => x.key)))]
      .filter((k) => reps.filter((r) => r.rows.some((x) => x.key === k)).length > 1);
    if (keys.length) {
      trendHtml = `<h2>Multi-year comparison</h2><table><thead><tr><th>Test</th>${reps.map((r) => `<th>${esc(r.patient.date)}</th>`).join('')}<th>Reference</th></tr></thead><tbody>` +
        keys.map((k) => {
          const any = reps.map((r) => r.rows.find((x) => x.key === k)).filter(Boolean).pop();
          return `<tr><td>${esc(any.name)} <span class="u">${esc(any.unit === 'ratio' ? '' : any.unit)}</span></td>${reps.map((r) => {
            const x = r.rows.find((y) => y.key === k);
            return `<td class="num" style="color:${x && x.status !== 'normal' ? COLORS[x.status] : 'inherit'}">${x ? fmt(x.value) : '—'}</td>`;
          }).join('')}<td class="num">${esc(fmtRange(any.low != null ? fmt(any.low) : null, any.high != null ? fmt(any.high) : null))}</td></tr>`;
        }).join('') + '</tbody></table>';
    }
  }

  const narr = translation?.narrative || narrative?.text;
  const narrBy = narrative ? `Generated by ${narrative.providerName || narrative.provider} (${narrative.model})` : '';
  const caution = `<div class="caution"><b>⚠ Caution — not a medical diagnosis.</b> This summary was generated automatically by RADHA from the values in your lab report, using standard reference ranges and published formulas. It may contain extraction errors and cannot account for your full medical history. <b>Please follow your medical practitioner's advice for treatment and for confirmation of any diagnosis.</b> Do not start, stop or change any medicine based on this document. In an emergency, contact your doctor or local emergency services immediately.</div>`;

  return `<!doctype html><html lang="${esc(translation ? lang : 'en')}" dir="ltr"><head><meta charset="utf-8"><title>RADHA summary</title><style>
  @page { size: A4; }
  body { font-family: -apple-system, "Segoe UI", "Noto Sans", "Noto Sans Devanagari", "Noto Sans Gujarati", "Noto Sans Bengali", "Noto Sans Tamil", "Noto Sans Telugu", sans-serif; color: #1a2230; font-size: 11px; line-height: 1.45; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #0f6b5f; padding-bottom: 8px; margin-bottom: 12px; }
  .logo { display: flex; gap: 10px; align-items: center; }
  .mark { width: 34px; height: 34px; border-radius: 8px; background: #0f6b5f; color: #fff; font-weight: 700; font-size: 19px; display: grid; place-items: center; }
  .brand { font-weight: 800; letter-spacing: .08em; font-size: 16px; } .sub { font-size: 9px; color: #5d6878; }
  h1 { font-size: 15px; margin: 0; } h2 { font-size: 13px; margin: 18px 0 6px; color: #0f6b5f; border-bottom: 1px solid #e2e5ea; padding-bottom: 3px; page-break-after: avoid; }
  h3 { font-size: 12px; margin: 0 0 4px; }
  .caution { border: 1.5px solid #b7791f; background: #fbf1df; border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: center; }
  dl { display: grid; grid-template-columns: 90px 1fr; gap: 3px 8px; margin: 0; } dt { color: #5d6878; } dd { margin: 0; font-weight: 600; }
  .kpis { display: flex; gap: 8px; margin-top: 8px; } .kpi { flex: 1; border: 1px solid #e2e5ea; border-radius: 6px; padding: 6px; text-align: center; }
  .kpi b { display: block; font-size: 18px; }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #e2e5ea; vertical-align: top; }
  th { background: #f0f2f5; font-size: 9.5px; text-transform: uppercase; color: #5d6878; } tr { page-break-inside: avoid; }
  .ph td { background: #e3f2ef; font-weight: 700; color: #0f6b5f; } .num { font-variant-numeric: tabular-nums; white-space: nowrap; } .u, .ref { color: #5d6878; font-size: 9.5px; }
  .st { font-weight: 700; font-size: 9.5px; }
  .obs { border-left: 4px solid #8a94a3; padding: 4px 10px; margin: 8px 0; page-break-inside: avoid; } .obs p { margin: 2px 0; } .obs ul { margin: 3px 0; padding-left: 16px; }
  .obs.urgent { border-color: #b3122f; } .obs.attention { border-color: #d2552b; } .obs.watch { border-color: #b7791f; }
  .ev { color: #5d6878; font-size: 9.5px; } .note { color: #5d6878; font-style: italic; } .tx { direction: ${dir}; }
  .qt { font-size: 11px; margin: 8px 0 2px; color: #233247; } ol { margin: 2px 0 4px; padding-left: 20px; }
  .narr { white-space: pre-wrap; background: #f5f6f8; padding: 8px; border-radius: 6px; }
    table.rec th { text-align: left; background: #eef3f2; font-size: 11px; } table.rec td { font-size: 11px; }
  </style></head><body>
  <header><div class="logo"><div class="mark">R</div><div><div class="brand">RADHA</div><div class="sub">Report Analysis &amp; Deterministic Health Assistant</div></div></div>
  <div style="text-align:right"><h1>Lab Report Summary</h1><div class="sub">Generated ${esc(new Date().toLocaleString())}</div></div></header>
  ${caution}
  <div class="grid">
    <div><h2>Patient profile</h2><dl>
      <dt>Name</dt><dd>${esc(p.name || '—')}</dd><dt>Age / Sex</dt><dd>${esc(p.age ?? '—')} / ${esc(p.sex === 'M' ? 'Male' : p.sex === 'F' ? 'Female' : '—')}</dd>
      <dt>Patient ID</dt><dd>${esc(p.patientId || '—')}</dd><dt>Report date</dt><dd>${esc(p.date || '—')}</dd>
      <dt>Source</dt><dd>${esc(report.source?.fileName || '—')}</dd></dl>
      <div class="kpis"><div class="kpi"><b>${n.total}</b>Tests</div><div class="kpi" style="color:${COLORS.normal}"><b>${n.normal}</b>Normal</div><div class="kpi" style="color:${COLORS.low}"><b>${n.low}</b>Low</div><div class="kpi" style="color:${COLORS.high}"><b>${n.high}</b>High</div><div class="kpi" style="color:${COLORS.critical}"><b>${n.critical}</b>Critical</div></div>
    </div>
    <div>${chartImg ? `<img src="${chartImg}" style="width:100%">` : ''}</div>
  </div>
  ${clinicalRecordHtml(profile)}
  <div class="tx">
  <h2>Clinical analysis &amp; action plan</h2>${translatedNote}
  <p><b>${esc(a.headline)}</b><br>${esc(a.summary)}</p>
  ${obs}
  <h2>Questions to ask your doctor</h2>${questionsHtml(a.questions)}
  ${narr ? `<h2>AI narrative summary</h2><div class="narr">${esc(narr)}</div><p class="note">${esc(narrBy)} from de-identified results.</p>` : ''}
  <h2>Calculator results</h2><table><thead><tr><th style="width:30%">Calculator</th><th style="width:14%">Result</th><th>Interpretation</th></tr></thead><tbody>${calcRows}</tbody></table>
  </div>
  <h2>Lab results</h2><table><thead><tr><th>Test</th><th>Result</th><th>Unit</th><th>Reference range</th><th>Status</th></tr></thead><tbody>${labRows}</tbody></table>
  ${trendHtml}
  <h2>Important</h2>${caution}
  </body></html>`;
}
