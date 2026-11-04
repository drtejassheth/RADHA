// Deterministic medical calculators. Inputs are canonical biomarker values (see biomarkers.js)
// plus patient demographics. The router runs every calculator whose required inputs are present.
//
// To add a calculator, append an object to CALCULATORS (or EXTENDED_CALCULATORS):
//   id, name, category, requires: [biomarker keys or 'age' | 'sex' | 'bmi' | 'height' | 'weight'],
//   anyOf?: [[alternatives]],
//   extras?: [{ id, label, type: 'number' | 'bool' | 'select', unit?, options?: [{ value, label }], default?, optional? }]
//            values that are not on a lab report (INR, blood pressure, smoking…), typed in by the user,
//   context?: 'specialist' for condition-specific scores (shown separately from routine results),
//   lib?: [names of the matching entries in the calculator library],
//   compute(v, p, x) -> { value, unit, band, severity, interpretation }   (x = extras)
//   severity: 'ok' | 'mild' | 'moderate' | 'severe'
//   reference: citation shown in the UI.
import { round } from './biomarkers.js';
import { EXTENDED_CALCULATORS } from './calculators-extended.js';

const r1 = (x) => round(x, 1);
const r2 = (x) => round(x, 2);
const band = (x, bands) => bands.find((b) => x < b.lt) || bands[bands.length - 1];

export const CALCULATORS = [
  {
    id: 'egfr_ckdepi2021',
    name: 'eGFR (CKD-EPI 2021, race-free)',
    category: 'Kidney',
    requires: ['creatinine', 'age', 'sex'],
    reference: 'Inker LA et al. NEJM 2021;385:1737-49',
    compute: ({ creatinine }, { age, sex }) => {
      const f = sex === 'F';
      const k = f ? 0.7 : 0.9;
      const a = f ? -0.241 : -0.302;
      const scr = creatinine / k;
      const egfr = 142 * Math.min(scr, 1) ** a * Math.max(scr, 1) ** -1.2 * 0.9938 ** age * (f ? 1.012 : 1);
      const b = band(egfr, [
        { lt: 15, band: 'G5 — kidney failure', severity: 'severe' },
        { lt: 30, band: 'G4 — severely decreased', severity: 'severe' },
        { lt: 45, band: 'G3b — moderately to severely decreased', severity: 'moderate' },
        { lt: 60, band: 'G3a — mildly to moderately decreased', severity: 'moderate' },
        { lt: 90, band: 'G2 — mildly decreased', severity: 'mild' },
        { lt: Infinity, band: 'G1 — normal or high', severity: 'ok' },
      ]);
      return {
        value: Math.round(egfr), unit: 'mL/min/1.73m²', band: b.band, severity: b.severity,
        interpretation: `Estimated kidney filtration is in KDIGO category ${b.band}. ` +
          (egfr < 60 ? 'A value below 60 sustained for 3 months meets the definition of chronic kidney disease.' :
            egfr < 90 ? 'Mild reductions are common with age; significance depends on urine albumin and history.' :
              'Filtration is within the expected range.'),
      };
    },
  },
  {
    id: 'kdigo_albuminuria',
    name: 'Albuminuria category (KDIGO)',
    category: 'Kidney',
    requires: ['uacr'],
    reference: 'KDIGO 2024 CKD Guideline',
    compute: ({ uacr }) => {
      const b = band(uacr, [
        { lt: 30, band: 'A1 — normal to mildly increased', severity: 'ok' },
        { lt: 300, band: 'A2 — moderately increased', severity: 'moderate' },
        { lt: Infinity, band: 'A3 — severely increased', severity: 'severe' },
      ]);
      return { value: r1(uacr), unit: 'mg/g', band: b.band, severity: b.severity,
        interpretation: `Urine albumin is in category ${b.band}. Persistent albuminuria (≥30 mg/g on 2 of 3 tests) is an early marker of kidney and cardiovascular risk.` };
    },
  },
  {
    id: 'bun_creat_ratio',
    name: 'BUN / Creatinine ratio',
    category: 'Kidney',
    requires: ['creatinine'],
    anyOf: [['bun', 'urea']],
    reference: 'Standard clinical chemistry (BUN = urea ÷ 2.14)',
    compute: ({ bun, urea, creatinine }) => {
      const b = bun ?? urea / 2.14;
      const ratio = b / creatinine;
      const x = band(ratio, [
        { lt: 10, band: 'Low (< 10)', severity: 'mild' },
        { lt: 20.01, band: 'Normal (10–20)', severity: 'ok' },
        { lt: Infinity, band: 'High (> 20)', severity: 'mild' },
      ]);
      return { value: r1(ratio), unit: 'ratio', band: x.band, severity: x.severity,
        interpretation: ratio > 20 ? 'A high ratio can be seen with dehydration, high protein intake or reduced kidney blood flow.' :
          ratio < 10 ? 'A low ratio can be seen with low protein intake or liver disease.' : 'Ratio is within the usual range.' };
    },
  },
  {
    id: 'eag',
    name: 'Estimated Average Glucose (from HbA1c)',
    category: 'Diabetes',
    requires: ['hba1c'],
    reference: 'Nathan DM et al. ADAG study, Diabetes Care 2008',
    compute: ({ hba1c }) => {
      const eag = 28.7 * hba1c - 46.7;
      const x = band(hba1c, [
        { lt: 5.7, band: 'Normal (HbA1c < 5.7%)', severity: 'ok' },
        { lt: 6.5, band: 'Prediabetes range (5.7–6.4%)', severity: 'mild' },
        { lt: 8, band: 'Diabetes range (≥ 6.5%)', severity: 'moderate' },
        { lt: Infinity, band: 'Diabetes range, above common target (≥ 8%)', severity: 'severe' },
      ]);
      return { value: Math.round(eag), unit: 'mg/dL', band: x.band, severity: x.severity,
        interpretation: `HbA1c ${hba1c}% corresponds to an average blood glucose of about ${Math.round(eag)} mg/dL over the last 2–3 months (ADA category: ${x.band}).` };
    },
  },
  {
    id: 'homa_ir',
    name: 'HOMA-IR (insulin resistance)',
    category: 'Diabetes',
    requires: ['glucose_fasting', 'insulin_fasting'],
    reference: 'Matthews DR et al. Diabetologia 1985',
    compute: ({ glucose_fasting, insulin_fasting }) => {
      const v = (glucose_fasting * insulin_fasting) / 405;
      const x = band(v, [
        { lt: 1.0, band: 'Optimal insulin sensitivity', severity: 'ok' },
        { lt: 1.9, band: 'Normal', severity: 'ok' },
        { lt: 2.9, band: 'Early insulin resistance likely', severity: 'mild' },
        { lt: Infinity, band: 'Significant insulin resistance likely', severity: 'moderate' },
      ]);
      return { value: r2(v), unit: 'index', band: x.band, severity: x.severity,
        interpretation: `HOMA-IR of ${r2(v)}: ${x.band.toLowerCase()}. Cut-offs vary by population; values above ~2.5 are often used in Indian adults.` };
    },
  },
  {
    id: 'tyg',
    name: 'TyG index (triglyceride-glucose)',
    category: 'Diabetes',
    requires: ['triglycerides', 'glucose_fasting'],
    reference: 'Simental-Mendía LE et al. Metab Syndr Relat Disord 2008',
    compute: ({ triglycerides, glucose_fasting }) => {
      const v = Math.log((triglycerides * glucose_fasting) / 2);
      const high = v >= 8.5;
      return { value: r2(v), unit: 'index', band: high ? 'Elevated (≥ 8.5)' : 'Not elevated (< 8.5)', severity: high ? 'mild' : 'ok',
        interpretation: high ? 'An elevated TyG index is a surrogate marker of insulin resistance and higher cardiometabolic risk.' : 'TyG index does not suggest insulin resistance.' };
    },
  },
  {
    id: 'ldl_sampson',
    name: 'LDL-C (Sampson/NIH equation 2)',
    category: 'Lipids',
    requires: ['total_cholesterol', 'hdl', 'triglycerides'],
    reference: 'Sampson M et al. JAMA Cardiol 2020;5:540-8',
    compute: ({ total_cholesterol: tc, hdl, triglycerides: tg }) => {
      const nonHdl = tc - hdl;
      const ldl = tc / 0.948 - hdl / 0.971 - (tg / 8.56 + (tg * nonHdl) / 2140 - (tg * tg) / 16100) - 9.44;
      const x = band(ldl, [
        { lt: 100, band: 'Optimal (< 100)', severity: 'ok' },
        { lt: 130, band: 'Near optimal (100–129)', severity: 'ok' },
        { lt: 160, band: 'Borderline high (130–159)', severity: 'mild' },
        { lt: 190, band: 'High (160–189)', severity: 'moderate' },
        { lt: Infinity, band: 'Very high (≥ 190)', severity: 'severe' },
      ]);
      return { value: Math.round(ldl), unit: 'mg/dL', band: x.band, severity: x.severity,
        interpretation: `Calculated LDL ≈ ${Math.round(ldl)} mg/dL (${x.band}). ` + (tg > 800 ? 'Triglycerides above 800 mg/dL make any calculated LDL unreliable — a direct LDL is preferred.' : 'More accurate than Friedewald when triglycerides are high.') };
    },
  },
  {
    id: 'ldl_friedewald',
    name: 'LDL-C (Friedewald)',
    category: 'Lipids',
    requires: ['total_cholesterol', 'hdl', 'triglycerides'],
    reference: 'Friedewald WT et al. Clin Chem 1972',
    compute: ({ total_cholesterol: tc, hdl, triglycerides: tg }) => {
      if (tg >= 400) return { value: null, unit: 'mg/dL', band: 'Not valid', severity: 'ok', interpretation: 'Friedewald is not valid when triglycerides are ≥ 400 mg/dL.' };
      const ldl = tc - hdl - tg / 5;
      return { value: Math.round(ldl), unit: 'mg/dL', band: ldl >= 160 ? 'High' : ldl >= 130 ? 'Borderline high' : ldl >= 100 ? 'Near optimal' : 'Optimal', severity: ldl >= 160 ? 'moderate' : ldl >= 130 ? 'mild' : 'ok',
        interpretation: `Classic estimate: ${Math.round(ldl)} mg/dL. Tends to underestimate LDL when triglycerides are high or LDL is low.` };
    },
  },
  {
    id: 'non_hdl',
    name: 'Non-HDL Cholesterol',
    category: 'Lipids',
    requires: ['total_cholesterol', 'hdl'],
    reference: 'NCEP ATP III; ESC/EAS 2019',
    compute: ({ total_cholesterol: tc, hdl }) => {
      const v = tc - hdl;
      const x = band(v, [
        { lt: 130, band: 'Desirable (< 130)', severity: 'ok' },
        { lt: 160, band: 'Borderline (130–159)', severity: 'mild' },
        { lt: 190, band: 'High (160–189)', severity: 'moderate' },
        { lt: Infinity, band: 'Very high (≥ 190)', severity: 'severe' },
      ]);
      return { value: Math.round(v), unit: 'mg/dL', band: x.band, severity: x.severity, interpretation: `Non-HDL cholesterol captures all atherogenic (plaque-forming) particles: ${x.band}.` };
    },
  },
  {
    id: 'castelli',
    name: 'Castelli Risk Index I & II',
    category: 'Lipids',
    requires: ['total_cholesterol', 'hdl'],
    reference: 'Castelli WP. Am J Med 1984',
    compute: ({ total_cholesterol: tc, hdl, ldl }, { sex }) => {
      const i = tc / hdl;
      const limit = sex === 'F' ? 4.5 : 5.0;
      const ii = ldl != null ? ldl / hdl : null;
      const high = i > limit || (ii != null && ii > 3.5);
      return { value: r2(i), unit: 'TC/HDL', band: high ? 'Above recommended' : 'Within recommended', severity: high ? 'mild' : 'ok',
        interpretation: `TC/HDL = ${r2(i)} (target < ${limit})` + (ii != null ? `; LDL/HDL = ${r2(ii)} (target < 3.5).` : '.') };
    },
  },
  {
    id: 'aip',
    name: 'Atherogenic Index of Plasma',
    category: 'Lipids',
    requires: ['triglycerides', 'hdl'],
    reference: 'Dobiášová M. Clin Biochem 2001',
    compute: ({ triglycerides, hdl }) => {
      const v = Math.log10((triglycerides / 88.57) / (hdl / 38.67));
      const x = band(v, [
        { lt: 0.11, band: 'Low risk (< 0.11)', severity: 'ok' },
        { lt: 0.21, band: 'Intermediate risk (0.11–0.21)', severity: 'mild' },
        { lt: Infinity, band: 'High risk (> 0.21)', severity: 'moderate' },
      ]);
      return { value: r2(v), unit: 'log(TG/HDL)', band: x.band, severity: x.severity, interpretation: `AIP reflects small dense LDL particles: ${x.band}.` };
    },
  },
  {
    id: 'tg_hdl',
    name: 'TG / HDL ratio',
    category: 'Lipids',
    requires: ['triglycerides', 'hdl'],
    reference: 'McLaughlin T et al. Ann Intern Med 2003',
    compute: ({ triglycerides, hdl }) => {
      const v = triglycerides / hdl;
      const high = v >= 3.0;
      return { value: r2(v), unit: 'ratio', band: high ? 'Elevated (≥ 3.0)' : 'Not elevated (< 3.0)', severity: high ? 'mild' : 'ok',
        interpretation: high ? 'A TG/HDL ratio of 3 or more is associated with insulin resistance.' : 'Ratio does not suggest insulin resistance.' };
    },
  },
  {
    id: 'remnant',
    name: 'Remnant Cholesterol',
    category: 'Lipids',
    requires: ['total_cholesterol', 'hdl', 'ldl'],
    reference: 'Varbo A et al. JACC 2013',
    compute: ({ total_cholesterol: tc, hdl, ldl }) => {
      const v = tc - hdl - ldl;
      const high = v >= 30;
      return { value: Math.round(v), unit: 'mg/dL', band: high ? 'Elevated (≥ 30)' : 'Normal (< 30)', severity: high ? 'mild' : 'ok',
        interpretation: high ? 'Raised remnant cholesterol is linked to residual cardiovascular risk even when LDL is controlled.' : 'Remnant cholesterol is not raised.' };
    },
  },
  {
    id: 'de_ritis',
    name: 'De Ritis ratio (AST/ALT)',
    category: 'Liver',
    requires: ['ast', 'alt'],
    reference: 'De Ritis F. 1957; Botros M. Clin Biochem Rev 2013',
    compute: ({ ast, alt }) => {
      const v = ast / alt;
      const x = band(v, [
        { lt: 1, band: '< 1 (hepatocellular pattern)', severity: 'ok' },
        { lt: 2, band: '1–2', severity: 'mild' },
        { lt: Infinity, band: '> 2', severity: 'moderate' },
      ]);
      return { value: r2(v), unit: 'ratio', band: x.band, severity: ast > 40 || alt > 40 ? x.severity : 'ok',
        interpretation: ast <= 40 && alt <= 40 ? 'Both enzymes are within range, so the ratio has little meaning on its own.' :
          v < 1 ? 'ALT predominance is typical of fatty liver and viral/drug causes.' :
            v >= 2 ? 'A ratio above 2 is classically associated with alcohol-related liver injury.' : 'A ratio above 1 may suggest more advanced liver fibrosis.' };
    },
  },
  {
    id: 'fib4',
    name: 'FIB-4 (liver fibrosis)',
    category: 'Liver',
    requires: ['age', 'ast', 'alt', 'platelets'],
    reference: 'Sterling RK et al. Hepatology 2006; AASLD 2023',
    compute: ({ ast, alt, platelets }, { age }) => {
      const v = (age * ast) / (platelets * Math.sqrt(alt));
      const lowCut = age >= 65 ? 2.0 : 1.3;
      const x = v < lowCut ? { band: `Low risk (< ${lowCut})`, severity: 'ok' } : v <= 2.67 ? { band: 'Indeterminate (needs elastography)', severity: 'mild' } : { band: 'High risk (> 2.67)', severity: 'severe' };
      return { value: r2(v), unit: 'score', band: x.band, severity: x.severity,
        interpretation: `FIB-4 ${r2(v)}: ${x.band}. ` + (age < 35 ? 'Less reliable under 35 years of age.' : 'Used to triage the need for FibroScan or specialist referral.') };
    },
  },
  {
    id: 'apri',
    name: 'APRI (AST to Platelet Ratio Index)',
    category: 'Liver',
    requires: ['ast', 'platelets'],
    reference: 'Wai CT et al. Hepatology 2003',
    compute: ({ ast, platelets }) => {
      const v = ((ast / 40) / platelets) * 100;
      const x = band(v, [
        { lt: 0.5, band: 'Significant fibrosis unlikely', severity: 'ok' },
        { lt: 1.5, band: 'Indeterminate', severity: 'mild' },
        { lt: Infinity, band: 'Significant fibrosis likely', severity: 'severe' },
      ]);
      return { value: r2(v), unit: 'score', band: x.band, severity: x.severity, interpretation: `APRI ${r2(v)} (AST upper limit taken as 40 U/L): ${x.band}.` };
    },
  },
  {
    id: 'nfs',
    name: 'NAFLD Fibrosis Score',
    category: 'Liver',
    requires: ['age', 'bmi', 'ast', 'alt', 'platelets', 'albumin'],
    reference: 'Angulo P et al. Hepatology 2007',
    compute: ({ ast, alt, platelets, albumin }, { age, bmi, diabetes }) => {
      const v = -1.675 + 0.037 * age + 0.094 * bmi + 1.13 * (diabetes ? 1 : 0) + 0.99 * (ast / alt) - 0.013 * platelets - 0.66 * albumin;
      const x = v < -1.455 ? { band: 'F0–F2 likely (< −1.455)', severity: 'ok' } : v <= 0.676 ? { band: 'Indeterminate', severity: 'mild' } : { band: 'F3–F4 likely (> 0.676)', severity: 'severe' };
      return { value: r2(v), unit: 'score', band: x.band, severity: x.severity, interpretation: `NAFLD fibrosis score ${r2(v)}: ${x.band}. Uses the diabetes/IFG flag from the patient profile.` };
    },
  },
  {
    id: 'hsi',
    name: 'Hepatic Steatosis Index',
    category: 'Liver',
    requires: ['bmi', 'ast', 'alt', 'sex'],
    reference: 'Lee JH et al. Dig Liver Dis 2010',
    compute: ({ ast, alt }, { bmi, sex, diabetes }) => {
      const v = 8 * (alt / ast) + bmi + (sex === 'F' ? 2 : 0) + (diabetes ? 2 : 0);
      const x = v < 30 ? { band: 'Fatty liver unlikely (< 30)', severity: 'ok' } : v > 36 ? { band: 'Fatty liver likely (> 36)', severity: 'moderate' } : { band: 'Indeterminate (30–36)', severity: 'mild' };
      return { value: r1(v), unit: 'score', band: x.band, severity: x.severity, interpretation: `HSI ${r1(v)}: ${x.band}.` };
    },
  },
  {
    id: 'nlr',
    name: 'Neutrophil-Lymphocyte Ratio',
    category: 'Blood',
    anyOf: [['anc', 'neutrophils_pct'], ['alc', 'lymphocytes_pct']],
    requires: [],
    reference: 'Forget P et al. BMC Res Notes 2017',
    compute: ({ anc, alc, neutrophils_pct, lymphocytes_pct }) => {
      const v = anc != null && alc != null ? anc / alc : neutrophils_pct / lymphocytes_pct;
      const x = band(v, [
        { lt: 0.78, band: 'Low (< 0.78)', severity: 'mild' },
        { lt: 3.53, band: 'Normal (0.78–3.53)', severity: 'ok' },
        { lt: 6, band: 'Mildly raised', severity: 'mild' },
        { lt: Infinity, band: 'Markedly raised (≥ 6)', severity: 'moderate' },
      ]);
      return { value: r2(v), unit: 'ratio', band: x.band, severity: x.severity, interpretation: `NLR is a non-specific marker of systemic inflammation or physiological stress: ${x.band}.` };
    },
  },
  {
    id: 'plr',
    name: 'Platelet-Lymphocyte Ratio',
    category: 'Blood',
    requires: ['platelets', 'alc'],
    reference: 'Gasparyan AY et al. Ann Lab Med 2019',
    compute: ({ platelets, alc }) => {
      const v = platelets / alc;
      const high = v > 200;
      return { value: Math.round(v), unit: 'ratio', band: high ? 'Raised (> 200)' : 'Typical (< 200)', severity: high ? 'mild' : 'ok', interpretation: 'PLR is a non-specific inflammatory marker best interpreted with the clinical picture.' };
    },
  },
  {
    id: 'mentzer',
    name: 'Mentzer Index',
    category: 'Blood',
    requires: ['mcv', 'rbc'],
    reference: 'Mentzer WC. Lancet 1973',
    compute: ({ mcv, rbc }) => {
      const v = mcv / rbc;
      if (mcv >= 80) return { value: r1(v), unit: 'index', band: 'Not applicable (MCV ≥ 80)', severity: 'ok', interpretation: 'Mentzer index applies only to microcytic (small-cell) anemia.' };
      const thal = v < 13;
      return { value: r1(v), unit: 'index', band: thal ? '< 13 — thalassemia trait favored' : '> 13 — iron deficiency favored', severity: 'mild',
        interpretation: (thal ? 'Small red cells with a high RBC count favor thalassemia trait; HbA2 electrophoresis can confirm.' : 'Small red cells with a low RBC count favor iron deficiency; ferritin confirms.') };
    },
  },
  {
    id: 'corrected_calcium',
    name: 'Albumin-corrected Calcium',
    category: 'Electrolytes',
    requires: ['calcium', 'albumin'],
    reference: 'Payne RB et al. BMJ 1973',
    compute: ({ calcium, albumin }) => {
      const v = calcium + 0.8 * (4 - albumin);
      const x = v < 8.6 ? { band: 'Low', severity: 'mild' } : v > 10.3 ? { band: 'High', severity: v > 12 ? 'severe' : 'moderate' } : { band: 'Normal (8.6–10.3)', severity: 'ok' };
      return { value: r2(v), unit: 'mg/dL', band: x.band, severity: x.severity, interpretation: `Calcium adjusted for albumin: ${r2(v)} mg/dL (${x.band}).` };
    },
  },
  {
    id: 'anion_gap',
    name: 'Anion Gap',
    category: 'Electrolytes',
    requires: ['sodium', 'chloride', 'bicarbonate'],
    reference: 'Kraut JA, Madias NE. CJASN 2007',
    compute: ({ sodium, chloride, bicarbonate, albumin }) => {
      const ag = sodium - (chloride + bicarbonate);
      const corr = albumin != null ? ag + 2.5 * (4 - albumin) : ag;
      const x = corr > 12 ? { band: 'High (> 12)', severity: 'moderate' } : corr < 3 ? { band: 'Low (< 3)', severity: 'mild' } : { band: 'Normal (3–12)', severity: 'ok' };
      return { value: r1(corr), unit: 'mmol/L', band: x.band, severity: x.severity, interpretation: `Anion gap ${r1(ag)}${albumin != null ? `, albumin-corrected ${r1(corr)}` : ''} mmol/L: ${x.band}.` };
    },
  },
  {
    id: 'osmolality',
    name: 'Calculated Serum Osmolality',
    category: 'Electrolytes',
    requires: ['sodium', 'glucose_fasting'],
    anyOf: [['bun', 'urea']],
    reference: '2·Na + Glucose/18 + BUN/2.8',
    compute: ({ sodium, glucose_fasting, bun, urea }) => {
      const b = bun ?? urea / 2.14;
      const v = 2 * sodium + glucose_fasting / 18 + b / 2.8;
      const x = v < 275 ? { band: 'Low (< 275)', severity: 'mild' } : v > 295 ? { band: 'High (> 295)', severity: 'mild' } : { band: 'Normal (275–295)', severity: 'ok' };
      return { value: Math.round(v), unit: 'mOsm/kg', band: x.band, severity: x.severity, interpretation: `Calculated osmolality ${Math.round(v)} mOsm/kg (${x.band}).` };
    },
  },
  {
    id: 'tsat_calc',
    name: 'Transferrin Saturation (calculated)',
    category: 'Iron',
    requires: ['iron', 'tibc'],
    reference: 'Serum iron ÷ TIBC × 100',
    compute: ({ iron, tibc, ferritin }) => {
      const v = (iron / tibc) * 100;
      const x = v < 20 ? { band: 'Low (< 20%)', severity: 'mild' } : v > 45 ? { band: 'High (> 45%)', severity: 'mild' } : { band: 'Normal (20–45%)', severity: 'ok' };
      return { value: r1(v), unit: '%', band: x.band, severity: x.severity,
        interpretation: v < 20 ? `Low iron saturation${ferritin != null && ferritin < 30 ? ' together with low ferritin strongly suggests iron deficiency' : ' suggests reduced iron available for red cell production'}.` : v > 45 ? 'High saturation can indicate iron overload and may warrant repeat fasting testing.' : 'Iron saturation is within range.' };
    },
  },
  {
    id: 'bmi',
    name: 'Body Mass Index (Asian cut-offs)',
    category: 'Body',
    requires: ['height', 'weight'],
    reference: 'WHO Expert Consultation, Lancet 2004 (Asian BMI)',
    compute: (_v, { bmi }) => {
      const x = band(bmi, [
        { lt: 18.5, band: 'Underweight (< 18.5)', severity: 'mild' },
        { lt: 23, band: 'Normal (18.5–22.9)', severity: 'ok' },
        { lt: 25, band: 'Overweight (23–24.9)', severity: 'mild' },
        { lt: 30, band: 'Obese I (25–29.9)', severity: 'moderate' },
        { lt: Infinity, band: 'Obese II (≥ 30)', severity: 'severe' },
      ]);
      return { value: r1(bmi), unit: 'kg/m²', band: x.band, severity: x.severity, interpretation: `BMI ${r1(bmi)} kg/m² — ${x.band} using Asia-Pacific cut-offs.` };
    },
  },
];

// Library entries describing the built-in calculators above.
const BASE_LIB = {
  egfr_ckdepi2021: ['Glomerular Filtration Rate Estimation (eGFR) by CKD-EPI Equation with Creatinine, without Race (2021)', 'CKD-EPI Equations for Glomerular Filtration Rate (GFR)'],
  kdigo_albuminuria: ['Albuminuria'],
  bun_creat_ratio: ['BUN Creatinine Ratio'],
  eag: ['Estimated Average Glucose (eAG) From HbA1C', 'eAG Calculator'],
  homa_ir: ['HOMA-IR (Homeostatic Model Assessment for Insulin Resistance)', 'HOMA Formula: Homeostasis Model Assessment of Insulin Resistance', 'HOMA-IR Calculator'],
  tyg: ['TyG Index Calculator', 'Triglyceride-Glucose Index'],
  ldl_sampson: ['Sampson Equation for Low Density Lipoprotein (LDL-C)'],
  ldl_friedewald: ['Friedewald Equation for Low Density Lipoprotein (LDL-C)', 'LDL Calculator', 'LDL Calculated'],
  non_hdl: ['Non-HDL Cholesterol Calculator'],
  castelli: ['Cholesterol Ratio Calculator', 'Castelli Risk Index'],
  aip: ['Atherogenic Index of Plasma Calculator', 'Atherogenic Index of Plasma'],
  tg_hdl: ['Triglyceride to HDL Ratio Calculator', 'TG/HDL Ratio'],
  remnant: ['Remnant Cholesterol Calculator'],
  de_ritis: ['AST/ALT Ratio Calculator', 'De Ritis Ratio'],
  fib4: ['Fibrosis-4 (FIB-4) Index for Liver Fibrosis', 'FIB-4 Calculator'],
  apri: ['AST to Platelet Ratio Index (APRI)', 'APRI (AST to Platelet Ratio Index)'],
  nfs: ['NAFLD (Non-Alcoholic Fatty Liver Disease) Fibrosis Score', 'NAFLD Fibrosis Score Calculator'],
  hsi: ['Hepatic Steatosis Index'],
  nlr: ['Neutrophil-Lymphocyte Ratio (NLR) Calculator', 'Neutrophil to Lymphocyte Ratio (NLR)', 'NLR Calculator'],
  plr: ['Platelet to Lymphocyte Ratio Calculator', 'Platelet-Lymphocyte Ratio'],
  mentzer: ['Mentzer Index'],
  corrected_calcium: ['Calcium Correction for Hypoalbuminemia', 'Corrected Calcium Calculator', 'Calcium Correction for Hypoalbuminemia and Hyperalbuminemia'],
  anion_gap: ['Anion Gap Calculator', 'Serum Anion Gap'],
  osmolality: ['Serum Osmolality/Osmolarity', 'Osmolality Estimator (serum)', 'Plasma Osmolality Calculator'],
  tsat_calc: ['Transferrin Saturation Calculator'],
  bmi: ['BMI Calculator', 'Body Mass Index (BMI) and Body Surface Area (BSA)'],
};
for (const c of CALCULATORS) c.lib = BASE_LIB[c.id] || [];
CALCULATORS.push(...EXTENDED_CALCULATORS);

const DEMOGRAPHICS = new Set(['age', 'sex', 'height', 'weight', 'bmi']);

/** Build the value map and derived demographics used by every calculator. */
export function buildContext(rows, patient) {
  const v = {};
  const ranges = {};
  for (const r of rows) {
    if (r.include !== false && r.value != null && Number.isFinite(r.value)) { v[r.key] = r.value; ranges[r.key] = { low: r.low, high: r.high }; }
  }
  const p = { ...patient };
  if (p.heightCm && p.weightKg) p.bmi = p.weightKg / (p.heightCm / 100) ** 2;
  p.height = p.heightCm; p.weight = p.weightKg;
  // IFG/diabetes flag used by the NAFLD scores: explicit profile flag, or lab evidence.
  if (p.diabetes == null || p.diabetes === '') p.diabetes = (v.glucose_fasting >= 110) || (v.hba1c >= 6.5);
  p.ranges = ranges;
  return { v, p };
}

function has(ctx, k) {
  return DEMOGRAPHICS.has(k) ? ctx.p[k] != null && ctx.p[k] !== '' : ctx.v[k] != null;
}

/** Current values of a calculator's typed-in inputs (saved values over defaults). */
export function extrasFor(c, saved = {}) {
  const x = {};
  for (const e of c.extras || []) {
    const val = saved[e.id] ?? e.default;
    x[e.id] = e.type === 'number' && val !== '' && val != null ? Number(val) : val;
  }
  return x;
}

/**
 * Route: decide which calculators can run and execute them.
 * `calcInputs` holds the user's typed-in extras per calculator: { [calcId]: { [extraId]: value } }.
 * Result status: ready (ran) · needsInput (report has the labs; only typed-in values missing) · missing (labs absent).
 */
export function runCalculators(rows, patient, calcInputs = {}) {
  const ctx = buildContext(rows, patient);
  return CALCULATORS.map((c) => {
    const base = { id: c.id, name: c.name, category: c.category, reference: c.reference, context: c.context || 'routine', lib: c.lib || [], requires: c.requires, extras: c.extras || [] };
    const missing = c.requires.filter((k) => !has(ctx, k));
    for (const group of c.anyOf || []) if (!group.some((k) => has(ctx, k))) missing.push(group.join(' or '));
    const x = extrasFor(c, calcInputs[c.id]);
    const missingExtras = (c.extras || []).filter((e) => !e.optional && !(e.fromLab && ctx.v[e.fromLab] != null) && (x[e.id] == null || x[e.id] === '' || (e.type === 'number' && !Number.isFinite(x[e.id]))));
    base.inputs = x;
    if (missing.length) return { ...base, ready: false, missing };
    if (missingExtras.length) return { ...base, ready: false, needsInput: true, missing: [], missingExtras: missingExtras.map((e) => e.id) };
    try {
      const out = c.compute(ctx.v, ctx.p, x);
      if (out.value != null && !Number.isFinite(out.value)) throw new Error('result is not a number — check the inputs');
      return { ...base, ready: true, ...out };
    } catch (err) {
      return { ...base, ready: false, missing: [], error: err.message || String(err) };
    }
  });
}
