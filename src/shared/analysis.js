// Deterministic clinical analysis: turns verified values + calculator outputs into structured,
// patient-friendly observations and next steps. Every statement is rule-based and traceable to
// the evidence listed with it. It never diagnoses; it prepares the patient for a consultation.
import { BY_KEY, fmtRange } from './biomarkers.js';
import { buildQuestions } from './questions.js';

const SEV_ORDER = { urgent: 0, attention: 1, watch: 2, info: 3 };

function index(rows) {
  const m = {};
  for (const r of rows) if (r.include !== false && r.value != null) m[r.key] = r;
  return m;
}

const ev = (r) => (r ? `${r.name}: ${r.value} ${r.unit === 'ratio' ? '' : r.unit} (ref ${fmtRange(r.low, r.high)}) — ${r.status.toUpperCase()}`.replace(/\s+/g, ' ') : null);

const RULES = [
  // ---- urgent: critical values
  (m) => {
    const crit = Object.values(m).filter((r) => r.critical);
    if (!crit.length) return null;
    return {
      id: 'critical', panel: 'All', severity: 'urgent', title: 'Values in a critical range',
      detail: 'One or more results are far outside the usual range. Laboratories usually phone the doctor for values like these.',
      evidence: crit.map(ev),
      nextSteps: ['Contact your doctor today, or seek urgent care if you feel unwell.', 'Ask whether a repeat test is needed to confirm the value.'],
    };
  },

  // ---- blood
  (m) => {
    const hb = m.hemoglobin;
    if (!hb || hb.status !== 'low') return null;
    const mcv = m.mcv?.value;
    let type = 'normocytic (normal-sized red cells)';
    const steps = ['Discuss the cause of anemia with your doctor.'];
    if (mcv != null && mcv < 80) {
      type = 'microcytic (small red cells)';
      steps.push(m.ferritin ? 'Ferritin is available — see the iron observation.' : 'Ask about iron studies (ferritin, iron, TIBC).');
      steps.push('If iron is normal, hemoglobin electrophoresis (HbA2) can check for thalassemia trait.');
    } else if (mcv != null && mcv > 100) {
      type = 'macrocytic (large red cells)';
      steps.push('Ask about Vitamin B12, folate, thyroid and liver tests.');
    }
    return {
      id: 'anemia', panel: 'Complete Blood Count', severity: hb.value < 10 ? 'attention' : 'watch',
      title: `Low hemoglobin — ${type} pattern`,
      detail: `Hemoglobin carries oxygen. A ${hb.value < 10 ? 'moderate' : 'mild'} reduction is present with a ${type} pattern, which helps narrow down the cause.`,
      evidence: [ev(hb), ev(m.mcv), ev(m.mch), ev(m.rdw)].filter(Boolean),
      nextSteps: steps,
    };
  },
  (m) => {
    const f = m.ferritin;
    const tsat = m.tsat || (m.iron && m.tibc ? { value: (m.iron.value / m.tibc.value) * 100 } : null);
    if (!(f && f.value < 30) && !(tsat && tsat.value < 20)) return null;
    return {
      id: 'iron', panel: 'Vitamins & Iron', severity: 'attention', title: 'Body iron reserves appear low',
      detail: 'Ferritin below 30 ng/mL and/or transferrin saturation below 20% indicate depleted iron stores, even before anemia appears.',
      evidence: [ev(f), ev(m.iron), ev(m.tibc), tsat && !m.tsat ? `Transferrin saturation (calculated): ${tsat.value.toFixed(1)}%` : ev(m.tsat)].filter(Boolean),
      nextSteps: ['Ask your doctor whether iron supplementation is appropriate and for how long.', 'Ask whether the cause of iron loss (diet, menstruation, gut) should be investigated.'],
    };
  },
  (m) => {
    const w = m.wbc;
    if (!w || w.status === 'normal' || w.status === 'unknown') return null;
    return {
      id: 'wbc', panel: 'Complete Blood Count', severity: w.critical ? 'urgent' : 'watch',
      title: w.status === 'high' ? 'Raised white cell count' : 'Low white cell count',
      detail: w.status === 'high' ? 'A raised WBC is most often due to infection or inflammation, but can have other causes.' : 'A low WBC can follow viral illness or medicines, and sometimes needs further review.',
      evidence: [ev(w), ev(m.anc), ev(m.alc), ev(m.neutrophils_pct)].filter(Boolean),
      nextSteps: ['Mention any recent fever, infection or new medicines to your doctor.', 'A repeat CBC in a few weeks is commonly advised.'],
    };
  },
  (m) => {
    const p = m.platelets;
    if (!p || p.status === 'normal' || p.status === 'unknown') return null;
    return {
      id: 'platelets', panel: 'Complete Blood Count', severity: p.critical ? 'urgent' : 'watch',
      title: p.status === 'low' ? 'Low platelet count' : 'High platelet count',
      detail: p.status === 'low' ? 'Platelets help blood clot. Low counts can follow viral infections (e.g. dengue), medicines, or liver conditions.' : 'High platelets are often reactive (infection, inflammation, iron deficiency).',
      evidence: [ev(p)],
      nextSteps: p.status === 'low' ? ['Report any unusual bruising or bleeding promptly.', 'Ask whether a repeat count or peripheral smear is needed.'] : ['Ask whether a repeat count is needed after any infection has settled.'],
    };
  },

  // ---- glycemic
  (m, calc) => {
    const a1c = m.hba1c?.value;
    const fpg = m.glucose_fasting?.value;
    const pp = m.glucose_pp?.value;
    const diabetes = (a1c != null && a1c >= 6.5) || (fpg != null && fpg >= 126) || (pp != null && pp >= 200);
    const pre = !diabetes && ((a1c != null && a1c >= 5.7) || (fpg != null && fpg >= 100) || (pp != null && pp >= 140));
    if (!diabetes && !pre) return null;
    const homa = calc.find((c) => c.id === 'homa_ir' && c.ready);
    return {
      id: 'glycemic', panel: 'Diabetes / Glycemic', severity: diabetes ? 'attention' : 'watch',
      title: diabetes ? 'Blood sugar in the diabetes range' : 'Blood sugar in the prediabetes range',
      detail: diabetes
        ? 'By ADA criteria, these values fall in the diabetes range. A diagnosis needs confirmation by your doctor, usually with a repeat test.'
        : 'These values are above normal but below the diabetes threshold (prediabetes). This stage is often reversible with lifestyle change.',
      evidence: [ev(m.hba1c), ev(m.glucose_fasting), ev(m.glucose_pp), homa ? `HOMA-IR: ${homa.value} — ${homa.band}` : null].filter(Boolean),
      nextSteps: diabetes
        ? ['Book a consultation to confirm the diagnosis and discuss treatment.', 'Ask about kidney (urine albumin), eye and foot checks that are recommended with diabetes.']
        : ['Repeat HbA1c or fasting glucose in 3–6 months.', 'Ask about a structured diet and activity plan.'],
    };
  },

  // ---- lipids
  (m, calc) => {
    const ldl = m.ldl?.value ?? calc.find((c) => c.id === 'ldl_sampson' && c.ready)?.value;
    const tg = m.triglycerides;
    const hdl = m.hdl;
    const issues = [];
    if (ldl != null && ldl >= 130) issues.push(`LDL ${ldl >= 160 ? 'high' : 'borderline high'}`);
    if (tg && tg.value >= 150) issues.push('triglycerides raised');
    if (hdl && hdl.status === 'low') issues.push('HDL low');
    if (!issues.length) return null;
    const aip = calc.find((c) => c.id === 'aip' && c.ready);
    return {
      id: 'lipids', panel: 'Lipid Profile', severity: (ldl != null && ldl >= 190) || (tg && tg.value >= 500) ? 'attention' : 'watch',
      title: 'Cholesterol pattern raises cardiovascular risk',
      detail: `Findings: ${issues.join(', ')}. Treatment decisions depend on overall heart risk (age, blood pressure, smoking, diabetes, family history), not on these numbers alone.`,
      evidence: [ev(m.total_cholesterol), ev(m.ldl), ev(hdl), ev(tg), aip ? `Atherogenic index: ${aip.value} — ${aip.band}` : null].filter(Boolean),
      nextSteps: ['Ask your doctor to estimate your 10-year cardiovascular risk.', tg && tg.value >= 500 ? 'Very high triglycerides need prompt review because of pancreatitis risk.' : 'Repeat the lipid profile after 8–12 weeks of lifestyle change.'],
    };
  },

  // ---- kidney
  (m, calc) => {
    const egfr = calc.find((c) => c.id === 'egfr_ckdepi2021' && c.ready);
    const uacr = m.uacr;
    const low = egfr && egfr.value < 60;
    const alb = uacr && uacr.value >= 30;
    if (!low && !alb) return null;
    return {
      id: 'kidney', panel: 'Kidney Function', severity: egfr && egfr.value < 30 ? 'urgent' : 'attention',
      title: low ? 'Reduced kidney filtration' : 'Protein (albumin) leaking into urine',
      detail: 'Kidney findings need to be confirmed on a repeat test after about 3 months before chronic kidney disease can be diagnosed.',
      evidence: [egfr ? `eGFR (CKD-EPI 2021): ${egfr.value} mL/min/1.73m² — ${egfr.band}` : null, ev(m.creatinine), ev(uacr)].filter(Boolean),
      nextSteps: ['Repeat creatinine and urine albumin-creatinine ratio in 3 months.', 'Review blood pressure, blood sugar and any pain-killer (NSAID) use with your doctor.'],
    };
  },
  (m) => {
    const u = m.uric_acid;
    if (!u || u.status !== 'high') return null;
    return {
      id: 'urate', panel: 'Kidney Function', severity: 'watch', title: 'Raised uric acid',
      detail: 'High uric acid can cause gout and kidney stones, and is linked with metabolic syndrome. Many people with raised levels have no symptoms.',
      evidence: [ev(u)],
      nextSteps: ['Mention any past joint pain/swelling or kidney stones to your doctor.'],
    };
  },
  (m) => {
    const bad = ['sodium', 'potassium', 'calcium', 'magnesium'].map((k) => m[k]).filter((r) => r && (r.status === 'low' || r.status === 'high'));
    if (!bad.length) return null;
    return {
      id: 'electrolytes', panel: 'Electrolytes & Minerals', severity: bad.some((r) => r.critical) ? 'urgent' : 'watch',
      title: 'Electrolyte/mineral outside range',
      detail: 'Electrolytes are affected by fluids, kidney function, hormones and many medicines (e.g. diuretics).',
      evidence: bad.map(ev),
      nextSteps: ['Share your current medicine list with your doctor.', 'A repeat test is commonly advised to confirm.'],
    };
  },

  // ---- liver
  (m, calc) => {
    const raised = ['ast', 'alt', 'ggt', 'alp', 'bilirubin_total'].map((k) => m[k]).filter((r) => r && r.status === 'high');
    if (!raised.length) return null;
    const fib4 = calc.find((c) => c.id === 'fib4' && c.ready);
    const ratio = calc.find((c) => c.id === 'de_ritis' && c.ready);
    return {
      id: 'liver', panel: 'Liver Function', severity: fib4 && fib4.severity === 'severe' ? 'attention' : 'watch',
      title: 'Liver enzymes raised',
      detail: 'Mildly raised liver enzymes are most often due to fatty liver, alcohol, or medicines. Fibrosis scores help decide who needs further liver assessment.',
      evidence: [...raised.map(ev), ratio ? `AST/ALT ratio: ${ratio.value}` : null, fib4 ? `FIB-4: ${fib4.value} — ${fib4.band}` : null].filter(Boolean),
      nextSteps: ['Ask whether a liver ultrasound or FibroScan is appropriate.', 'Review alcohol intake and all medicines/supplements with your doctor.', 'Ask about hepatitis B and C screening if not done before.'],
    };
  },

  // ---- thyroid
  (m) => {
    const tsh = m.tsh;
    if (!tsh || tsh.status === 'normal' || tsh.status === 'unknown') return null;
    const ft4 = m.ft4 || m.t4_total;
    let title; let detail;
    if (tsh.status === 'high') {
      const overt = ft4 && ft4.status === 'low';
      title = overt ? 'Pattern consistent with an underactive thyroid' : 'TSH raised with normal thyroid hormone (subclinical pattern)';
      detail = overt ? 'High TSH with low T4 suggests the thyroid is underactive (hypothyroidism).'
        : 'A raised TSH with normal T4 is called subclinical hypothyroidism. It is often re-checked before any treatment decision.';
    } else {
      const overt = ft4 && ft4.status === 'high';
      title = overt ? 'Pattern consistent with an overactive thyroid' : 'Low TSH';
      detail = overt ? 'Low TSH with high T4 suggests an overactive thyroid (hyperthyroidism).' : 'A low TSH can be due to thyroid over-activity, medicines, or recent illness.';
    }
    return {
      id: 'thyroid', panel: 'Thyroid', severity: tsh.critical ? 'attention' : 'watch', title, detail,
      evidence: [ev(tsh), ev(m.ft4), ev(m.t4_total), ev(m.ft3), ev(m.t3_total)].filter(Boolean),
      nextSteps: ['Repeat TSH with Free T4 in 6–12 weeks.', 'Ask whether thyroid antibodies (anti-TPO) should be tested.'],
    };
  },

  // ---- vitamins
  (m) => {
    const d = m.vitamin_d;
    if (!d || d.value >= 30) return null;
    const deficient = d.value < 20;
    return {
      id: 'vitd', panel: 'Vitamins & Iron', severity: d.value < 12 ? 'attention' : 'watch',
      title: deficient ? 'Vitamin D deficiency' : 'Vitamin D insufficiency',
      detail: `Vitamin D below ${deficient ? '20 ng/mL is classed as deficiency' : '30 ng/mL is classed as insufficiency'} (Endocrine Society). It matters for bone and muscle health.`,
      evidence: [ev(d), ev(m.calcium)].filter(Boolean),
      nextSteps: ['Ask your doctor about the right supplement dose and duration.', 'Re-check after about 3 months of supplementation.'],
    };
  },
  (m) => {
    const b = m.vitamin_b12;
    if (!b || b.status !== 'low') return null;
    return {
      id: 'b12', panel: 'Vitamins & Iron', severity: b.value < 150 ? 'attention' : 'watch', title: 'Low Vitamin B12',
      detail: 'B12 is needed for nerves and red blood cells. Low levels are common with vegetarian diets and with long-term metformin or antacid use.',
      evidence: [ev(b), ev(m.mcv), ev(m.homocysteine)].filter(Boolean),
      nextSteps: ['Mention numbness, tingling or memory changes to your doctor.', 'Ask about supplementation (oral or injection).'],
    };
  },
  (m) => {
    const h = m.hscrp || m.crp;
    const hc = m.homocysteine;
    const items = [h && h.status === 'high' ? h : null, hc && hc.status === 'high' ? hc : null].filter(Boolean);
    if (!items.length) return null;
    return {
      id: 'inflammation', panel: 'Inflammation & Cardiac', severity: 'watch', title: 'Inflammation / vascular risk markers raised',
      detail: 'hs-CRP and homocysteine are non-specific markers. They can be raised by a recent infection, and are used as add-on cardiovascular risk markers.',
      evidence: items.map(ev),
      nextSteps: ['Repeat hs-CRP after 2 weeks if you had a recent infection.', 'Raised homocysteine often responds to correcting B12/folate deficiency.'],
    };
  },
];

/**
 * Run all rules. `calc` is the output of runCalculators() (ready results); `previous` is the
 * patient's earlier report ({ date, rows }) used for "changes since last report" questions.
 */
export function analyze(rows, patient, calc = [], previous = null) {
  const m = index(rows);
  const observations = RULES.map((rule) => rule(m, calc)).filter(Boolean)
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);

  const counts = { total: 0, normal: 0, low: 0, high: 0, unknown: 0 };
  for (const r of Object.values(m)) { counts.total++; counts[r.status] = (counts[r.status] || 0) + 1; }
  const abnormal = counts.low + counts.high;

  const name = patient?.name ? patient.name.split(' ')[0] : 'This report';
  let summary;
  if (!counts.total) summary = 'No verified results to analyse yet.';
  else if (!observations.length) summary = `${counts.total} results were reviewed. ${abnormal ? `${abnormal} are slightly outside the reference range but do not form a pattern that needs specific attention.` : 'All results are within their reference ranges.'} Continue routine health check-ups.`;
  else {
    const urgent = observations.filter((o) => o.severity === 'urgent').length;
    summary = `${counts.total} results were reviewed; ${abnormal} are outside the reference range. ` +
      `RADHA identified ${observations.length} area${observations.length > 1 ? 's' : ''} to discuss with a doctor` +
      (urgent ? `, including ${urgent} that should be raised promptly` : '') +
      `: ${observations.map((o) => o.title).join('; ')}.`;
  }

  const questions = counts.total ? buildQuestions(m, observations, calc, patient, previous) : [];

  return {
    headline: observations.length ? `${name}: ${observations.length} area${observations.length > 1 ? 's' : ''} to discuss` : `${name}: no major concerns flagged`,
    summary,
    counts,
    observations,
    questions,
    generatedAt: new Date().toISOString(),
  };
}

export { BY_KEY };
