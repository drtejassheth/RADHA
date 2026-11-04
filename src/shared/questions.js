// "Questions to ask your doctor": a deterministic generator that covers everything in the report —
// critical values, every finding, every other out-of-range or borderline result, flagged calculator
// results, changes since the previous report, common tests that are missing, and general follow-up.
// Each question is { topic, text } so the UI and the PDF can group them.
import { fmtRange, BY_KEY } from './biomarkers.js';

const fmt = (v) => (v == null || !Number.isFinite(v) ? '—' : String(Math.abs(v) >= 100 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100));
const val = (r) => `${fmt(r.value)}${r.unit && r.unit !== 'ratio' ? ' ' + r.unit : ''}`;
const range = (r) => fmtRange(r.low != null ? fmt(r.low) : null, r.high != null ? fmt(r.high) : null);

// Result keys each finding already explains — they don't get a separate per-result question.
const COVERS = {
  anemia: ['hemoglobin', 'mcv', 'mch', 'mchc', 'rdw', 'rbc', 'hematocrit'],
  iron: ['ferritin', 'iron', 'tibc', 'tsat'],
  wbc: ['wbc', 'anc', 'alc', 'neutrophils_pct', 'lymphocytes_pct'],
  platelets: ['platelets'],
  glycemic: ['hba1c', 'glucose_fasting', 'glucose_pp', 'glucose_random', 'insulin_fasting'],
  lipids: ['total_cholesterol', 'ldl', 'hdl', 'triglycerides', 'vldl', 'non_hdl', 'chol_hdl_ratio', 'ldl_hdl_ratio'],
  kidney: ['creatinine', 'uacr', 'urine_microalbumin', 'egfr_reported', 'cystatin_c'],
  urate: ['uric_acid'],
  electrolytes: ['sodium', 'potassium', 'calcium', 'magnesium'],
  liver: ['ast', 'alt', 'ggt', 'alp', 'bilirubin_total', 'bilirubin_direct', 'bilirubin_indirect'],
  thyroid: ['tsh', 'ft4', 't4_total', 'ft3', 't3_total'],
  vitd: ['vitamin_d'],
  b12: ['vitamin_b12', 'homocysteine'],
  inflammation: ['hscrp', 'crp', 'homocysteine'],
};

function findingQuestions(o, m) {
  const has = (k) => m[k] != null;
  switch (o.id) {
    case 'critical': return [
      'Do any of my critical values need urgent treatment today, or should they be repeated first?',
      'Should I go to an emergency department, or can this wait for a clinic visit?',
      'Which symptoms should make me seek help immediately?',
    ];
    case 'anemia': return [
      `What is the most likely cause of my low hemoglobin (${val(m.hemoglobin)}), given the red-cell pattern described in my report?`,
      has('ferritin') ? 'Do my iron results explain the anaemia, or are other causes possible?' : 'Do I need iron studies (ferritin, iron, TIBC), Vitamin B12 or folate tests?',
      'Could hidden blood loss (heavy periods, stomach or bowel bleeding) be a cause, and should it be checked?',
      'Would a hemoglobin electrophoresis test (for thalassemia trait) be useful for me?',
      'How quickly should my hemoglobin improve with treatment, and when should it be rechecked?',
    ];
    case 'iron': return [
      'Should I take iron tablets? Which form, what dose, and for how long?',
      'What could be causing my low iron (diet, blood loss, poor absorption), and does it need investigation?',
      'Is intravenous iron an option if tablets upset my stomach or don\'t work?',
      'When should ferritin and hemoglobin be rechecked?',
    ];
    case 'wbc': return m.wbc?.status === 'high' ? [
      `What could explain my raised white cell count (${val(m.wbc)}) — infection, inflammation, stress or medicines?`,
      'Do I need a peripheral blood smear or a repeat count?',
    ] : [
      `What could explain my low white cell count (${val(m.wbc)}) — a recent viral illness, medicines or something else?`,
      'Am I at higher risk of infections, and do I need any precautions?',
      'Do I need a peripheral blood smear or a repeat count?',
    ];
    case 'platelets': return m.platelets?.status === 'low' ? [
      `What could be causing my low platelet count (${val(m.platelets)})?`,
      'Should I avoid any medicines (such as aspirin or pain killers) because of my platelet count?',
      'Do I need a repeat count or a peripheral smear?',
    ] : [
      `What could be causing my high platelet count (${val(m.platelets)})?`,
      'Should it be repeated after any infection or iron deficiency has been treated?',
    ];
    case 'glycemic': return /\bin the diabetes range/i.test(o.title) ? [
      'Do these results confirm diabetes, or do I need a repeat test to confirm it?',
      'What HbA1c and fasting glucose targets should I aim for?',
      'Do I need medicine now, or can I start with diet and exercise changes?',
      'Which complication checks (eyes, kidneys, feet, heart) should I have, and how often?',
      'Should I monitor my blood sugar at home? If so, how often?',
    ] : [
      'Am I in the prediabetes range, and what is my risk of developing diabetes?',
      'Would an oral glucose tolerance test (OGTT) add useful information?',
      'How often should I repeat HbA1c or fasting glucose?',
      'Which changes would help most to bring my sugar back to normal?',
    ];
    case 'lipids': return [
      'What is my 10-year risk of heart attack or stroke, taking these lipid results into account?',
      'What LDL and non-HDL cholesterol targets are right for me?',
      'Do I need a statin or other cholesterol medicine, or can I try lifestyle changes first?',
      m.hdl?.status === 'low' ? `My HDL ("good") cholesterol is low (${val(m.hdl)}). What can raise it, and how much does it matter?` : null,
      m.triglycerides?.status === 'high' ? `My triglycerides are high (${val(m.triglycerides)}). What is causing this, and how should it be treated?` : null,
      'Should Lipoprotein(a) or ApoB be measured to refine my heart risk?',
      'When should the lipid profile be repeated, and should it be done fasting?',
    ].filter(Boolean);
    case 'kidney': return [
      'Is my kidney function stable or getting worse, and which CKD stage does it suggest?',
      'Should I see a kidney specialist (nephrologist)?',
      'Do any of my current medicines (pain killers, metformin, blood-pressure tablets) need a dose change?',
      'What blood pressure target should I keep for my kidneys?',
      'When should creatinine and the urine albumin test be repeated?',
    ];
    case 'urate': return [
      `Is my uric acid (${val(m.uric_acid)}) high enough to need treatment, or just monitoring?`,
      'Could any of my medicines (e.g. diuretics, low-dose aspirin) be raising it?',
      'Am I at risk of gout or kidney stones, and what should I watch for?',
    ];
    case 'electrolytes': return [
      'What is causing my electrolyte result(s) to be out of range?',
      'Could any of my medicines (such as diuretics) be responsible?',
      'Do I need a repeat test, and how soon?',
    ];
    case 'liver': return [
      'What is the most likely cause of my raised liver enzymes (fatty liver, alcohol, medicines, viral hepatitis)?',
      'Should I have a liver ultrasound or FibroScan?',
      'Do I need hepatitis B and hepatitis C tests?',
      'Should I stop or change any medicines, herbal products or supplements?',
      'When should my liver tests be repeated?',
    ];
    case 'thyroid': return [
      'Do I need thyroid medicine now, or should the test be repeated first?',
      has('ft4') ? null : 'Should Free T4 be measured along with TSH?',
      'Should thyroid antibodies (anti-TPO) be checked?',
      'Could symptoms such as tiredness, weight change, or hair and skin changes be related to my thyroid?',
      'When should my thyroid tests be repeated?',
    ].filter(Boolean);
    case 'vitd': return [
      `What dose of Vitamin D should I take for my level of ${val(m.vitamin_d)}, and for how long?`,
      'When should my Vitamin D level be rechecked?',
      'Do my bones need any further checks (calcium, bone density)?',
    ];
    case 'b12': return [
      `Should I take B12 tablets or injections for my level of ${val(m.vitamin_b12)}, and for how long?`,
      'Could any of my medicines (e.g. metformin, acid-reducing tablets) be lowering my B12?',
      'Do symptoms such as numbness, tingling or memory problems need further evaluation?',
    ];
    case 'inflammation': return [
      'Could a recent infection explain my raised inflammation markers, and should they be repeated?',
      'Do these markers change my heart-risk assessment?',
    ];
    default: return [];
  }
}

const SCREENING = [
  { keys: ['hemoglobin'], name: 'a complete blood count (CBC)' },
  { keys: ['hba1c', 'glucose_fasting', 'glucose_random'], name: 'diabetes screening (HbA1c or fasting glucose)' },
  { keys: ['total_cholesterol', 'ldl'], name: 'a lipid profile (cholesterol)' },
  { keys: ['creatinine'], name: 'kidney function (creatinine / eGFR)' },
  { keys: ['alt', 'ast'], name: 'liver function tests' },
  { keys: ['tsh'], name: 'thyroid function (TSH)' },
  { keys: ['vitamin_d'], name: 'Vitamin D' },
  { keys: ['vitamin_b12'], name: 'Vitamin B12' },
];

/**
 * @param m        verified results by key (included rows only)
 * @param observations  output of the analysis rules
 * @param calc     ready calculator results
 * @param patient  profile ({ age, sex, ... })
 * @param previous optional earlier report for the same patient ({ date, rows })
 */
export function buildQuestions(m, observations, calc, patient, previous) {
  const q = [];
  const add = (topic, text) => { if (text) q.push({ topic, text }); };

  // 1. Every finding, most urgent first.
  for (const o of observations) for (const t of findingQuestions(o, m)) add(o.id === 'critical' ? 'Urgent' : o.title, t);

  // 2. Every other out-of-range result.
  const covered = new Set(observations.flatMap((o) => COVERS[o.id] || []));
  if (observations.some((o) => o.id === 'critical')) for (const r of Object.values(m)) if (r.critical) covered.add(r.key);
  for (const r of Object.values(m)) {
    if (covered.has(r.key) || (r.status !== 'low' && r.status !== 'high')) continue;
    add('Other results outside the reference range',
      `My ${r.name} is ${val(r)}, which is ${r.status === 'low' ? 'below' : 'above'} the reference range (${range(r)}). What could cause this, and does it need follow-up?`);
  }

  // 3. Results inside the range but close to a limit.
  const borderline = Object.values(m).filter((r) => {
    if (r.status !== 'normal' || r.low == null || r.high == null || r.high <= r.low) return false;
    const pos = (r.value - r.low) / (r.high - r.low);
    return pos >= 0.92 || (pos <= 0.08 && r.low > 0);
  }).slice(0, 6);
  for (const r of borderline) {
    const upper = (r.value - r.low) / (r.high - r.low) >= 0.5;
    add('Results close to a limit', `My ${r.name} (${val(r)}) is within range but close to the ${upper ? 'upper' : 'lower'} limit (${range(r)}). Is this worth watching or retesting?`);
  }

  // 4. Calculator results that were flagged (routine scores only).
  // Skip calculators whose area a finding above already discusses.
  const CALC_AREA = { Kidney: ['kidney'], Diabetes: ['glycemic'], Lipids: ['lipids'], Liver: ['liver'], Blood: ['anemia', 'iron', 'wbc', 'platelets'], Thyroid: ['thyroid'], Inflammation: ['inflammation'], Electrolytes: ['electrolytes'], Iron: ['iron', 'anemia'] };
  const found = new Set(observations.map((o) => o.id));
  const flagged = calc.filter((c) => c.ready && c.context !== 'specialist' && c.severity && c.severity !== 'ok' && c.value != null &&
    !(CALC_AREA[c.category] || []).some((id) => found.has(id))).slice(0, 8);
  for (const c of flagged) add('Calculator results', `The ${c.name} came out at ${c.value}${c.unit && !/index|ratio|score|points/.test(c.unit) ? ' ' + c.unit : ''} (${c.band}). What does this mean for me, and does it change my plan?`);

  // 5. Changes since the previous report.
  if (previous?.rows?.length) {
    const prev = {};
    for (const r of previous.rows) if (r.include !== false && r.value != null) prev[r.key] = r;
    const changes = [];
    for (const r of Object.values(m)) {
      const p = prev[r.key];
      if (!p || !p.value) continue;
      const pct = ((r.value - p.value) / Math.abs(p.value)) * 100;
      const statusChanged = p.status !== r.status && p.status !== 'unknown' && r.status !== 'unknown';
      if (statusChanged || (r.status !== 'normal' && Math.abs(pct) >= 15)) changes.push({ r, p, pct, statusChanged });
    }
    changes.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    const when = previous.date ? ` on ${previous.date}` : '';
    for (const { r, p, statusChanged } of changes.slice(0, 8)) {
      if (statusChanged && r.status === 'normal') {
        add('Changes since my last report', `My ${r.name} is back in the normal range (${fmt(p.value)} → ${val(r)}). Can any treatment for it be reduced or stopped?`);
      } else {
        add('Changes since my last report', `My ${r.name} changed from ${fmt(p.value)}${when} to ${val(r)}${statusChanged ? `, and is now ${r.status === 'low' ? 'below' : 'above'} the range` : ''}. Is this change meaningful, and what explains it?`);
      }
    }
  }

  // 6. Common tests this report does not include.
  for (const s of SCREENING) if (!s.keys.some((k) => m[k])) add('Tests not in this report', `This report does not include ${s.name}. Should I have it tested?`);
  const hasMetabolic = observations.some((o) => ['glycemic', 'kidney'].includes(o.id));
  if (hasMetabolic && !m.uacr && !m.urine_microalbumin) add('Tests not in this report', 'Should I have a urine albumin-creatinine ratio (UACR) test to check my kidneys?');
  if (patient?.sex === 'M' && patient?.age >= 50 && !m.psa) add('Tests not in this report', 'Should I discuss prostate (PSA) screening at my age?');

  // 7. General follow-up.
  const anyAbnormal = Object.values(m).some((r) => r.status === 'low' || r.status === 'high');
  add('General', anyAbnormal ? 'Which of these results matter most, and what should I do first?' : 'All my results are within range — how often should I repeat these tests?');
  add('General', 'Could any of my current medicines, supplements or recent illness have affected these results?');
  if (m.glucose_fasting || m.triglycerides || m.total_cholesterol) add('General', 'Was I properly fasting for these tests, and does that change how they should be read?');
  add('General', 'Do my family history, blood pressure or lifestyle change how these results should be interpreted?');
  add('General', 'Labs use different reference ranges — are my results normal by your standards too?');
  add('General', 'Which tests should be repeated, and when should I have my next full check-up?');

  return q;
}

export { BY_KEY };
