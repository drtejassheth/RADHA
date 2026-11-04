// Extended calculator set: every calculator in the library whose inputs can be fed from a lab
// report (plus age/sex/height/weight), implemented from the primary publications.
// Values arrive in canonical units (biomarkers.js); `x` holds values the user types in.
// See calculators.js for the definition format.
import { round } from './biomarkers.js';

const r1 = (x) => round(x, 1);
const r2 = (x) => round(x, 2);
const r3 = (x) => round(x, 3);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const band = (x, bands) => bands.find((b) => x < b.lt) || bands[bands.length - 1];
const NA = (why, unit = '') => ({ value: null, unit, band: `Not applicable — ${why}`, severity: 'ok', interpretation: `This calculator does not apply here: ${why}.` });

const BILI_UMOL = 17.1; // mg/dL -> µmol/L
const UREA_MMOL = 6.006; // urea mg/dL -> mmol/L

const YESNO = [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }];
const INR_EXTRA = { id: 'inr', label: 'INR (if not on the report)', type: 'number', unit: '', fromLab: 'inr' };

/** Value from the report, else from a typed-in extra of the same name. */
const lab = (v, x, key) => (v[key] != null ? v[key] : x?.[key]);
const bunOf = (v) => (v.bun != null ? v.bun : v.urea / 2.14);

/** Total body water (L) — Watson-style fractions of body weight used by the electrolyte calculators. */
function tbw(p) {
  const old = p.age >= 65;
  const f = p.sex === 'F' ? (old ? 0.45 : 0.5) : (old ? 0.5 : 0.6);
  return p.weight * f;
}

function ibwKg(p) {
  const inches = p.height / 2.54;
  return (p.sex === 'F' ? 45.5 : 50) + 2.3 * (inches - 60);
}

const egfr2021 = (cr, age, sex) => {
  const f = sex === 'F';
  const k = f ? 0.7 : 0.9;
  const s = cr / k;
  return 142 * Math.min(s, 1) ** (f ? -0.241 : -0.302) * Math.max(s, 1) ** -1.2 * 0.9938 ** age * (f ? 1.012 : 1);
};

const kdigoG = (e) => band(e, [
  { lt: 15, band: 'G5 — kidney failure', severity: 'severe' },
  { lt: 30, band: 'G4 — severely decreased', severity: 'severe' },
  { lt: 45, band: 'G3b — moderately to severely decreased', severity: 'moderate' },
  { lt: 60, band: 'G3a — mildly to moderately decreased', severity: 'moderate' },
  { lt: 90, band: 'G2 — mildly decreased', severity: 'mild' },
  { lt: Infinity, band: 'G1 — normal or high', severity: 'ok' },
]);

function microcytic(v, calc) {
  if (v.mcv >= 80) return NA('MCV is 80 fL or more; thalassemia-trait indices are for microcytic (small-cell) blood counts', 'index');
  return calc();
}

function thalIndex(name, value, cutoff, below, unit = 'index') {
  const thal = below ? value < cutoff : value > cutoff;
  return {
    value, unit, severity: 'mild',
    band: thal ? `Favors β-thalassemia trait (${below ? '<' : '>'} ${cutoff})` : `Favors iron deficiency (${below ? '≥' : '≤'} ${cutoff})`,
    interpretation: `${name} ${value}. ${thal ? 'Suggests thalassemia trait; hemoglobin electrophoresis (HbA2) confirms.' : 'Suggests iron deficiency; ferritin and iron studies confirm.'} Discriminant indices screen only — they do not diagnose.`,
  };
}

export const EXTENDED_CALCULATORS = [
  // =================================================================== Kidney
  {
    id: 'egfr_ckdepi2009', name: 'eGFR (CKD-EPI 2009, creatinine)', category: 'Kidney',
    requires: ['creatinine', 'age', 'sex'], reference: 'Levey AS et al. Ann Intern Med 2009;150:604-12',
    lib: ['Glomerular Filtration Rate Estimation (eGFR) by CKD-EPI Equation (2009)'],
    compute: ({ creatinine: cr }, { age, sex }) => {
      const f = sex === 'F';
      const k = f ? 0.7 : 0.9;
      const e = 141 * Math.min(cr / k, 1) ** (f ? -0.329 : -0.411) * Math.max(cr / k, 1) ** -1.209 * 0.993 ** age * (f ? 1.018 : 1);
      const b = kdigoG(e);
      return { value: Math.round(e), unit: 'mL/min/1.73m²', band: b.band, severity: b.severity, interpretation: `Older CKD-EPI equation (race coefficient omitted). Superseded by the 2021 race-free equation; shown for comparison with older reports.` };
    },
  },
  {
    id: 'egfr_mdrd', name: 'eGFR (MDRD, IDMS-traceable)', category: 'Kidney',
    requires: ['creatinine', 'age', 'sex'], reference: 'Levey AS et al. Clin Chem 2007;53:766-72',
    lib: ['Glomerular Filtration Rate Estimation (eGFR) by the IDMS-Traceable MDRD Study Equation', 'MDRD GFR Equation', 'eGFR using Updated MDRD Equation (2006)', 'MDRD eGFR'],
    compute: ({ creatinine: cr }, { age, sex }) => {
      const e = 175 * cr ** -1.154 * age ** -0.203 * (sex === 'F' ? 0.742 : 1);
      const b = kdigoG(e);
      return { value: Math.round(e), unit: 'mL/min/1.73m²', band: b.band, severity: b.severity, interpretation: 'MDRD underestimates GFR above 60 mL/min/1.73m², so values above 60 should be read as "≥ 60".' };
    },
  },
  {
    id: 'egfr_cys2012', name: 'eGFR (CKD-EPI 2012, cystatin C)', category: 'Kidney',
    requires: ['cystatin_c', 'age', 'sex'], reference: 'Inker LA et al. NEJM 2012;367:20-9',
    lib: ['Glomerular Filtration Rate Estimation (eGFR) by CKD-EPI Equation with Cystatin C, without Race (2012)'],
    compute: ({ cystatin_c: cys }, { age, sex }) => {
      const s = cys / 0.8;
      const e = 133 * Math.min(s, 1) ** -0.499 * Math.max(s, 1) ** -1.328 * 0.996 ** age * (sex === 'F' ? 0.932 : 1);
      const b = kdigoG(e);
      return { value: Math.round(e), unit: 'mL/min/1.73m²', band: b.band, severity: b.severity, interpretation: 'Cystatin C is less affected by muscle mass than creatinine.' };
    },
  },
  {
    id: 'egfr_crcys2021', name: 'eGFR (CKD-EPI 2021, creatinine + cystatin C)', category: 'Kidney',
    requires: ['creatinine', 'cystatin_c', 'age', 'sex'], reference: 'Inker LA et al. NEJM 2021;385:1737-49',
    lib: ['Glomerular Filtration Rate Estimation (eGFR) by CKD-EPI Equation with Creatinine and Cystatin C, without Race (2021)', 'eGFR using CKD-EPI (Creatinine-Cystatin C) Equation (2021)'],
    compute: ({ creatinine: cr, cystatin_c: cys }, { age, sex }) => {
      const f = sex === 'F';
      const k = f ? 0.7 : 0.9;
      const e = 135 * Math.min(cr / k, 1) ** (f ? -0.219 : -0.144) * Math.max(cr / k, 1) ** -0.544 *
        Math.min(cys / 0.8, 1) ** -0.323 * Math.max(cys / 0.8, 1) ** -0.778 * 0.9961 ** age * (f ? 0.963 : 1);
      const b = kdigoG(e);
      return { value: Math.round(e), unit: 'mL/min/1.73m²', band: b.band, severity: b.severity, interpretation: 'The combined equation is the most accurate eGFR and is recommended to confirm CKD.' };
    },
  },
  {
    id: 'cockcroft_gault', name: 'Creatinine Clearance (Cockcroft-Gault)', category: 'Kidney',
    requires: ['creatinine', 'age', 'sex', 'weight'], reference: 'Cockcroft DW, Gault MH. Nephron 1976;16:31-41',
    lib: ['Creatinine Clearance (Cockcroft-Gault Equation)', 'Creatinine Clearance Estimate by Cockcroft-Gault Equation'],
    compute: ({ creatinine: cr }, p) => {
      const v = ((140 - p.age) * p.weight * (p.sex === 'F' ? 0.85 : 1)) / (72 * cr);
      return { value: Math.round(v), unit: 'mL/min', band: v < 30 ? '< 30 mL/min' : v < 60 ? '30–59 mL/min' : '≥ 60 mL/min', severity: v < 30 ? 'severe' : v < 60 ? 'moderate' : 'ok',
        interpretation: 'Uses actual body weight. Used mainly for drug-dose adjustment; may overestimate clearance in obesity.' };
    },
  },
  {
    id: 'cockcroft_gault_ibw', name: 'Creatinine Clearance (Cockcroft-Gault, ideal body weight)', category: 'Kidney',
    requires: ['creatinine', 'age', 'sex', 'height'], reference: 'Cockcroft DW, Gault MH. Nephron 1976; Devine BJ. Drug Intell Clin Pharm 1974',
    lib: ['Creatinine Clearance Estimate by Cockcroft-Gault Equation with Ideal Body Weight'],
    compute: ({ creatinine: cr }, p) => {
      const w = ibwKg(p);
      const v = ((140 - p.age) * w * (p.sex === 'F' ? 0.85 : 1)) / (72 * cr);
      return { value: Math.round(v), unit: 'mL/min', band: v < 30 ? '< 30 mL/min' : v < 60 ? '30–59 mL/min' : '≥ 60 mL/min', severity: v < 30 ? 'severe' : v < 60 ? 'moderate' : 'ok',
        interpretation: `Uses ideal body weight (${r1(w)} kg from height).` };
    },
  },
  {
    id: 'kfre4', name: 'Kidney Failure Risk Equation (4-variable)', category: 'Kidney', context: 'specialist',
    requires: ['creatinine', 'uacr', 'age', 'sex'], reference: 'Tangri N et al. JAMA 2016;315:164-74 (non-North American calibration)',
    lib: ['Kidney Failure Risk Equation (4 Variable)', 'Kidney Failure Risk Calculator'],
    compute: ({ creatinine, uacr }, { age, sex }) => {
      const e = egfr2021(creatinine, age, sex);
      if (e >= 60) return NA('the equation is validated for eGFR below 60 (CKD stage G3–G5)', '% at 5 y');
      const lp = -0.2201 * (age / 10 - 7.036) + 0.2467 * ((sex === 'M' ? 1 : 0) - 0.5642) - 0.5567 * (e / 5 - 7.222) + 0.4510 * (Math.log(uacr) - 5.137);
      const y2 = (1 - 0.9832 ** Math.exp(lp)) * 100;
      const y5 = (1 - 0.9365 ** Math.exp(lp)) * 100;
      return { value: r1(y5), unit: '% at 5 y', band: `2-year ${r1(y2)}% · 5-year ${r1(y5)}%`, severity: y5 >= 15 ? 'severe' : y5 >= 5 ? 'moderate' : 'mild',
        interpretation: `Estimated risk of needing dialysis or transplant: ${r1(y2)}% in 2 years, ${r1(y5)}% in 5 years. A 5-year risk above 3–5% is commonly used for nephrology referral.` };
    },
  },
  {
    id: 'fena', name: 'Fractional Excretion of Sodium (FENa)', category: 'Kidney', context: 'specialist',
    requires: ['sodium', 'creatinine'], reference: 'Espinel CH. JAMA 1976;236:579-81',
    lib: ['Fractional Excretion of Sodium (FENa)', 'FENa Calculator (Fractional Excretion of Sodium)'],
    extras: [{ id: 'urine_na', label: 'Urine sodium', type: 'number', unit: 'mmol/L' }, { id: 'urine_cr', label: 'Urine creatinine', type: 'number', unit: 'mg/dL' }],
    compute: ({ sodium, creatinine }, _p, x) => {
      const v = ((x.urine_na * creatinine) / (sodium * x.urine_cr)) * 100;
      return { value: r2(v), unit: '%', band: v < 1 ? '< 1% — prerenal pattern' : v > 2 ? '> 2% — intrinsic renal pattern' : '1–2% — indeterminate', severity: 'mild',
        interpretation: 'Interpret only in acute kidney injury with low urine output; unreliable on diuretics (use FEUrea instead).' };
    },
  },
  {
    id: 'feurea', name: 'Fractional Excretion of Urea (FEUrea)', category: 'Kidney', context: 'specialist',
    requires: ['creatinine'], anyOf: [['bun', 'urea']], reference: 'Carvounis CP et al. Kidney Int 2002;62:2223-9',
    lib: ['Fractional Excretion of Urea (FEUrea)', 'FEUrea Calculator — Acute Kidney Injury Cause Differentiation'],
    extras: [{ id: 'urine_urea_n', label: 'Urine urea nitrogen', type: 'number', unit: 'mg/dL' }, { id: 'urine_cr', label: 'Urine creatinine', type: 'number', unit: 'mg/dL' }],
    compute: (v, _p, x) => {
      const val = ((x.urine_urea_n * v.creatinine) / (bunOf(v) * x.urine_cr)) * 100;
      return { value: r1(val), unit: '%', band: val <= 35 ? '≤ 35% — prerenal pattern' : val > 50 ? '> 50% — intrinsic renal pattern' : '35–50% — indeterminate', severity: 'mild',
        interpretation: 'Useful in acute kidney injury when the patient is on diuretics.' };
    },
  },
  {
    id: 'ca_phos', name: 'Calcium × Phosphate Product', category: 'Kidney',
    requires: ['calcium', 'phosphorus'], reference: 'KDOQI Bone Metabolism Guideline 2003',
    lib: [],
    compute: ({ calcium, phosphorus }) => {
      const v = calcium * phosphorus;
      return { value: r1(v), unit: 'mg²/dL²', band: v > 55 ? 'High (> 55)' : 'Normal (≤ 55)', severity: v > 55 ? 'moderate' : 'ok',
        interpretation: v > 55 ? 'A high product raises the risk of vascular calcification, mainly relevant in CKD.' : 'Within the recommended target.' };
    },
  },

  // =================================================================== Electrolytes
  {
    id: 'na_corr_katz', name: 'Sodium corrected for glucose (Katz)', category: 'Electrolytes',
    requires: ['sodium'], anyOf: [['glucose_fasting', 'glucose_random', 'glucose_pp']], reference: 'Katz MA. NEJM 1973;289:843-4',
    lib: ['Sodium Correction in Hyperglycemia (Katz 1973)', 'Corrected Sodium in Hyperglycemia', 'Sodium Correction for Hyperglycemia'],
    compute: (v) => {
      const g = v.glucose_fasting ?? v.glucose_random ?? v.glucose_pp;
      const na = v.sodium + 0.016 * (g - 100);
      return { value: r1(na), unit: 'mmol/L', band: na < 135 ? 'Low' : na > 145 ? 'High' : 'Normal (135–145)', severity: na < 130 || na > 150 ? 'moderate' : na < 135 || na > 145 ? 'mild' : 'ok',
        interpretation: g <= 200 ? 'Glucose is not high enough to change sodium meaningfully.' : 'High glucose draws water into the blood and lowers measured sodium; this is the expected sodium once glucose normalises.' };
    },
  },
  {
    id: 'na_corr_hillier', name: 'Sodium corrected for glucose (Hillier)', category: 'Electrolytes',
    requires: ['sodium'], anyOf: [['glucose_fasting', 'glucose_random', 'glucose_pp']], reference: 'Hillier TA et al. Am J Med 1999;106:399-403',
    lib: ['Sodium Correction in Hyperglycemia (Hillier 1999)', 'Sodium Correction Calculator'],
    compute: (v) => {
      const g = v.glucose_fasting ?? v.glucose_random ?? v.glucose_pp;
      const na = v.sodium + 0.024 * (g - 100);
      return { value: r1(na), unit: 'mmol/L', band: na < 135 ? 'Low' : na > 145 ? 'High' : 'Normal (135–145)', severity: na < 130 || na > 150 ? 'moderate' : na < 135 || na > 145 ? 'mild' : 'ok',
        interpretation: 'Uses 2.4 mmol/L per 100 mg/dL glucose, which is more accurate when glucose is above 400 mg/dL.' };
    },
  },
  {
    id: 'free_water_deficit', name: 'Free Water Deficit', category: 'Electrolytes', context: 'specialist',
    requires: ['sodium', 'age', 'sex', 'weight'], reference: 'Adrogué HJ, Madias NE. NEJM 2000;342:1493-9',
    lib: ['Free Water Deficit in Hypernatremia', 'Free Water Deficit Calculator'],
    compute: ({ sodium }, p) => {
      if (sodium <= 145) return NA('sodium is not raised (≤ 145 mmol/L)', 'L');
      const v = tbw(p) * (sodium / 140 - 1);
      return { value: r1(v), unit: 'L', band: `Deficit ${r1(v)} L`, severity: 'moderate', interpretation: 'Estimated water needed to bring sodium to 140 mmol/L. Correction is normally limited to about 10 mmol/L per day.' };
    },
  },
  {
    id: 'sodium_deficit', name: 'Sodium Deficit in Hyponatremia', category: 'Electrolytes', context: 'specialist',
    requires: ['sodium', 'age', 'sex', 'weight'], reference: 'Adrogué HJ, Madias NE. NEJM 2000;342:1581-9',
    lib: ['Sodium Deficit in Hyponatremia', 'Sodium Deficit Calculator'],
    extras: [{ id: 'target_na', label: 'Target sodium', type: 'number', unit: 'mmol/L', default: 140 }],
    compute: ({ sodium }, p, x) => {
      if (sodium >= 135) return NA('sodium is not low (≥ 135 mmol/L)', 'mmol');
      const v = tbw(p) * (x.target_na - sodium);
      return { value: Math.round(v), unit: 'mmol', band: `Deficit ${Math.round(v)} mmol Na`, severity: 'moderate', interpretation: 'Total sodium needed to reach the target. Rapid correction is dangerous; specialist supervision required.' };
    },
  },
  {
    id: 'delta_ratio', name: 'Delta Ratio (delta-delta)', category: 'Electrolytes', context: 'specialist',
    requires: ['sodium', 'chloride', 'bicarbonate'], reference: 'Rastegar A. JASN 2007;18:2429-31',
    lib: ['Anion Gap Delta Delta Ratio Multicalc', 'Anion Gap Delta Delta Gradient Multicalc'],
    compute: ({ sodium, chloride, bicarbonate }) => {
      const ag = sodium - chloride - bicarbonate;
      if (ag <= 12 || bicarbonate >= 24) return NA('there is no raised-anion-gap acidosis', 'ratio');
      const v = (ag - 12) / (24 - bicarbonate);
      const b = v < 0.4 ? 'Hyperchloremic normal-gap acidosis' : v < 1 ? 'Mixed high-gap + normal-gap acidosis' : v <= 2 ? 'Pure high-anion-gap acidosis' : 'High-gap acidosis + metabolic alkalosis';
      return { value: r2(v), unit: 'ratio', band: b, severity: 'moderate', interpretation: `Delta ratio ${r2(v)}: ${b.toLowerCase()}.` };
    },
  },
  {
    id: 'winters', name: "Winters' Formula (expected pCO₂)", category: 'Electrolytes', context: 'specialist',
    requires: ['bicarbonate'], reference: 'Albert MS, Dell RB, Winters RW. Ann Intern Med 1967;66:312-22',
    lib: ["Winters' Formula for Metabolic Acidosis Compensation", "Winters' Formula for Expected PCO2", "Winters' Formula Calculator"],
    compute: ({ bicarbonate }) => {
      if (bicarbonate >= 22) return NA('bicarbonate is not low (no metabolic acidosis)', 'mmHg');
      const v = 1.5 * bicarbonate + 8;
      return { value: r1(v), unit: 'mmHg', band: `Expected pCO₂ ${r1(v - 2)}–${r1(v + 2)}`, severity: 'mild', interpretation: 'If the measured arterial pCO₂ is higher, there is also respiratory acidosis; if lower, respiratory alkalosis.' };
    },
  },
  {
    id: 'bicarb_deficit', name: 'Bicarbonate Deficit', category: 'Electrolytes', context: 'specialist',
    requires: ['bicarbonate', 'weight'], reference: 'Fernandez PC et al. Kidney Int 1989;36:747-52',
    lib: ['Bicarbonate Deficit', 'Bicarbonate Deficit Calculator'],
    extras: [{ id: 'target_hco3', label: 'Target bicarbonate', type: 'number', unit: 'mmol/L', default: 24 }],
    compute: ({ bicarbonate }, p, x) => {
      if (bicarbonate >= x.target_hco3) return NA('bicarbonate is already at or above the target', 'mmol');
      const v = 0.4 * p.weight * (x.target_hco3 - bicarbonate);
      return { value: Math.round(v), unit: 'mmol', band: `Deficit ${Math.round(v)} mmol`, severity: 'moderate', interpretation: 'Uses a bicarbonate distribution volume of 0.4 × body weight.' };
    },
  },
  {
    id: 'osmolal_gap', name: 'Osmolal Gap', category: 'Electrolytes', context: 'specialist',
    requires: ['sodium', 'glucose_fasting'], anyOf: [['bun', 'urea']], reference: 'Kraut JA, Xing SX. Am J Kidney Dis 2011;58:480-4',
    lib: ['Osmolal Gap Calculator', 'Osmolal Gap'],
    extras: [{ id: 'measured_osm', label: 'Measured serum osmolality', type: 'number', unit: 'mOsm/kg' }],
    compute: (v, _p, x) => {
      const calc = 2 * v.sodium + v.glucose_fasting / 18 + bunOf(v) / 2.8;
      const gap = x.measured_osm - calc;
      return { value: r1(gap), unit: 'mOsm/kg', band: gap > 10 ? 'Raised (> 10)' : 'Normal (≤ 10)', severity: gap > 10 ? 'moderate' : 'ok',
        interpretation: gap > 10 ? 'A raised gap suggests unmeasured osmoles (e.g. alcohols, toxic alcohols, mannitol).' : 'No unmeasured osmoles suggested.' };
    },
  },

  // =================================================================== Liver
  {
    id: 'albi', name: 'ALBI (Albumin-Bilirubin) Grade', category: 'Liver', context: 'specialist',
    requires: ['albumin', 'bilirubin_total'], reference: 'Johnson PJ et al. J Clin Oncol 2015;33:550-8',
    lib: ['ALBI (Albumin-Bilirubin) Grade for Hepatocellular Carcinoma (HCC)', 'Albumin-bilirubin (ALBI) grade estimate of survival of adults with hepatocellular carcinoma (conventional and SI units)'],
    compute: ({ albumin, bilirubin_total }) => {
      const v = Math.log10(bilirubin_total * BILI_UMOL) * 0.66 + albumin * 10 * -0.085;
      const g = v <= -2.6 ? 1 : v <= -1.39 ? 2 : 3;
      return { value: r2(v), unit: 'score', band: `Grade ${g}`, severity: g === 1 ? 'ok' : g === 2 ? 'moderate' : 'severe',
        interpretation: `ALBI grade ${g} (1 best, 3 worst). An objective measure of liver function, mainly used in liver cancer and cirrhosis.` };
    },
  },
  {
    id: 'meld', name: 'MELD (original, pre-2016)', category: 'Liver', context: 'specialist',
    requires: ['creatinine', 'bilirubin_total'], reference: 'Kamath PS et al. Hepatology 2001;33:464-70',
    lib: ['MELD Score (Original, Pre-2016, Model for End-Stage Liver Disease)', 'MELD Calculator (Model for End-Stage Liver Disease)'],
    extras: [INR_EXTRA, { id: 'dialysis', label: 'Dialysis ≥ 2× in past week', type: 'select', options: YESNO, default: 'no' }],
    compute: (v, _p, x) => {
      const inr = lab(v, x, 'inr');
      const cr = x.dialysis === 'yes' ? 4 : clamp(v.creatinine, 1, 4);
      const m = 10 * (0.957 * Math.log(cr) + 0.378 * Math.log(Math.max(v.bilirubin_total, 1)) + 1.12 * Math.log(Math.max(inr, 1)) + 0.643);
      const s = Math.min(40, Math.round(m));
      return { value: s, unit: 'points', band: meldBand(s), severity: s >= 20 ? 'severe' : s >= 10 ? 'moderate' : 'mild', interpretation: `MELD ${s}. ${meldMortality(s)} For people with known cirrhosis only.` };
    },
  },
  {
    id: 'meld_na', name: 'MELD-Na (UNOS 2016)', category: 'Liver', context: 'specialist',
    requires: ['creatinine', 'bilirubin_total', 'sodium'], reference: 'Kim WR et al. NEJM 2008;359:1018-26; OPTN 2016',
    lib: ['MELD Na (UNOS/OPTN)', 'MELDNa/MELD-Na Score for Liver Cirrhosis', 'MELD/MELDNa scores (2016)'],
    extras: [INR_EXTRA, { id: 'dialysis', label: 'Dialysis ≥ 2× in past week', type: 'select', options: YESNO, default: 'no' }],
    compute: (v, _p, x) => {
      const inr = lab(v, x, 'inr');
      const cr = x.dialysis === 'yes' ? 4 : clamp(v.creatinine, 1, 4);
      let m = Math.round((0.957 * Math.log(cr) + 0.378 * Math.log(Math.max(v.bilirubin_total, 1)) + 1.12 * Math.log(Math.max(inr, 1)) + 0.643) * 10 * 10) / 10;
      const na = clamp(v.sodium, 125, 137);
      if (m > 11) m = m + 1.32 * (137 - na) - 0.033 * m * (137 - na);
      const s = Math.min(40, Math.round(m));
      return { value: s, unit: 'points', band: meldBand(s), severity: s >= 20 ? 'severe' : s >= 10 ? 'moderate' : 'mild', interpretation: `MELD-Na ${s}. ${meldMortality(s)} For people with known cirrhosis only.` };
    },
  },
  {
    id: 'meld3', name: 'MELD 3.0 (with albumin)', category: 'Liver', context: 'specialist',
    requires: ['creatinine', 'bilirubin_total', 'sodium', 'albumin', 'sex'], reference: 'Kim WR et al. Gastroenterology 2021;161:1887-95',
    lib: ['MELD 3.0 Score Including Serum Albumin'],
    extras: [INR_EXTRA, { id: 'dialysis', label: 'Dialysis ≥ 2× in past week', type: 'select', options: YESNO, default: 'no' }],
    compute: (v, p, x) => {
      const inr = Math.max(lab(v, x, 'inr'), 1);
      const bili = Math.max(v.bilirubin_total, 1);
      const cr = x.dialysis === 'yes' ? 3 : clamp(v.creatinine, 1, 3);
      const na = clamp(v.sodium, 125, 137);
      const alb = clamp(v.albumin, 1.5, 3.5);
      const m = 1.33 * (p.sex === 'F' ? 1 : 0) + 4.56 * Math.log(bili) + 0.82 * (137 - na) - 0.24 * (137 - na) * Math.log(bili) +
        9.09 * Math.log(inr) + 11.14 * Math.log(cr) + 1.85 * (3.5 - alb) - 1.83 * (3.5 - alb) * Math.log(cr) + 6;
      const s = Math.min(40, Math.round(m));
      return { value: s, unit: 'points', band: meldBand(s), severity: s >= 20 ? 'severe' : s >= 10 ? 'moderate' : 'mild', interpretation: `MELD 3.0 ${s}. Current US liver-allocation score; adds sex and albumin. For people with known cirrhosis only.` };
    },
  },
  {
    id: 'child_pugh', name: 'Child-Pugh Score', category: 'Liver', context: 'specialist',
    requires: ['bilirubin_total', 'albumin'], reference: 'Pugh RN et al. Br J Surg 1973;60:646-9',
    lib: ['Child-Pugh Score for Cirrhosis Mortality', 'Child Pugh Score', 'Child Pugh Calculator'],
    extras: [INR_EXTRA,
      { id: 'ascites', label: 'Ascites', type: 'select', options: [{ value: '1', label: 'Absent' }, { value: '2', label: 'Slight' }, { value: '3', label: 'Moderate' }] },
      { id: 'enceph', label: 'Encephalopathy', type: 'select', options: [{ value: '1', label: 'None' }, { value: '2', label: 'Grade 1–2' }, { value: '3', label: 'Grade 3–4' }] }],
    compute: (v, _p, x) => {
      const inr = lab(v, x, 'inr');
      const b = v.bilirubin_total < 2 ? 1 : v.bilirubin_total <= 3 ? 2 : 3;
      const a = v.albumin > 3.5 ? 1 : v.albumin >= 2.8 ? 2 : 3;
      const i = inr < 1.7 ? 1 : inr <= 2.3 ? 2 : 3;
      const s = b + a + i + Number(x.ascites) + Number(x.enceph);
      const cls = s <= 6 ? 'A' : s <= 9 ? 'B' : 'C';
      const surv = { A: '1-year survival ≈ 100%, 2-year ≈ 85%', B: '1-year ≈ 80%, 2-year ≈ 60%', C: '1-year ≈ 45%, 2-year ≈ 35%' }[cls];
      return { value: s, unit: 'points', band: `Class ${cls}`, severity: cls === 'A' ? 'mild' : cls === 'B' ? 'moderate' : 'severe', interpretation: `Child-Pugh class ${cls} (${s} points): ${surv}. For known cirrhosis.` };
    },
  },
  {
    id: 'maddrey', name: "Maddrey's Discriminant Function", category: 'Liver', context: 'specialist',
    requires: ['bilirubin_total', 'pt'], reference: 'Maddrey WC et al. Gastroenterology 1978;75:193-9',
    lib: ["Maddrey's Discriminant Function for Alcoholic Hepatitis", "Maddrey's Discriminant Function Calculator", 'Discriminant Function (Alcoholic Hepatitis)'],
    extras: [{ id: 'pt_control', label: 'Control (reference) PT', type: 'number', unit: 'sec', default: 12 }],
    compute: ({ bilirubin_total, pt }, _p, x) => {
      const v = 4.6 * (pt - x.pt_control) + bilirubin_total;
      return { value: r1(v), unit: 'points', band: v >= 32 ? 'Severe (≥ 32)' : 'Not severe (< 32)', severity: v >= 32 ? 'severe' : 'mild',
        interpretation: v >= 32 ? 'In alcoholic hepatitis, ≥ 32 indicates high short-term mortality; steroid treatment is considered.' : 'Lower short-term mortality in alcoholic hepatitis.' };
    },
  },
  {
    id: 'lille', name: 'Lille Model (alcoholic hepatitis, day 7)', category: 'Liver', context: 'specialist',
    requires: ['age', 'albumin', 'bilirubin_total', 'creatinine', 'pt'], reference: 'Louvet A et al. Hepatology 2007;45:1348-54',
    lib: ['Lille Model for Alcoholic Hepatitis', 'Lille Score Calculator'],
    extras: [{ id: 'bili_d7', label: 'Bilirubin on day 7 of steroids', type: 'number', unit: 'mg/dL' }],
    compute: ({ albumin, bilirubin_total, creatinine, pt }, { age }, x) => {
      const b0 = bilirubin_total * BILI_UMOL;
      const b7 = x.bili_d7 * BILI_UMOL;
      const R = 3.19 - 0.101 * age + 0.147 * albumin * 10 + 0.0165 * (b0 - b7) - 0.206 * (creatinine > 1.3 ? 1 : 0) - 0.0065 * b0 - 0.0096 * pt;
      const v = Math.exp(-R) / (1 + Math.exp(-R));
      return { value: r3(v), unit: 'score', band: v >= 0.45 ? 'Non-responder (≥ 0.45)' : 'Responder (< 0.45)', severity: v >= 0.45 ? 'severe' : 'mild',
        interpretation: v >= 0.45 ? 'Poor response to steroids; 6-month survival about 25%. Stopping steroids is usually considered.' : 'Good response to steroids; 6-month survival about 85%.' };
    },
  },
  {
    id: 'gahs', name: 'Glasgow Alcoholic Hepatitis Score', category: 'Liver', context: 'specialist',
    requires: ['age', 'wbc', 'bilirubin_total'], anyOf: [['urea', 'bun']], reference: 'Forrest EH et al. Gut 2005;54:1174-9',
    lib: ['Glasgow Alcoholic Hepatitis Score'],
    extras: [INR_EXTRA],
    compute: (v, { age }, x) => {
      const inr = lab(v, x, 'inr');
      const ureaMmol = v.urea != null ? v.urea / UREA_MMOL : v.bun / 2.801;
      const bili = v.bilirubin_total * BILI_UMOL;
      const s = (age < 50 ? 1 : 2) + (v.wbc < 15 ? 1 : 2) + (ureaMmol < 5 ? 1 : 2) + (inr < 1.5 ? 1 : inr <= 2 ? 2 : 3) + (bili < 125 ? 1 : bili <= 250 ? 2 : 3);
      return { value: s, unit: 'points', band: s >= 9 ? 'High risk (≥ 9)' : 'Lower risk (< 9)', severity: s >= 9 ? 'severe' : 'mild',
        interpretation: s >= 9 ? 'In alcoholic hepatitis, a score of 9 or more predicts poor 28-day survival without steroids.' : 'Better short-term survival in alcoholic hepatitis.' };
    },
  },
  {
    id: 'abic', name: 'ABIC Score (alcoholic hepatitis)', category: 'Liver', context: 'specialist',
    requires: ['age', 'bilirubin_total', 'creatinine'], reference: 'Dominguez M et al. Am J Gastroenterol 2008;103:2747-56',
    lib: ['ABIC Score for Alcoholic Hepatitis'],
    extras: [INR_EXTRA],
    compute: (v, { age }, x) => {
      const inr = lab(v, x, 'inr');
      const s = age * 0.1 + v.bilirubin_total * 0.08 + v.creatinine * 0.3 + inr * 0.8;
      const b = s < 6.71 ? { band: 'Low risk (< 6.71)', severity: 'mild', m: '90-day survival ≈ 100%' } : s < 9 ? { band: 'Intermediate (6.71–9)', severity: 'moderate', m: '90-day survival ≈ 70%' } : { band: 'High risk (≥ 9)', severity: 'severe', m: '90-day survival ≈ 25%' };
      return { value: r2(s), unit: 'score', band: b.band, severity: b.severity, interpretation: `${b.m} in alcoholic hepatitis.` };
    },
  },
  {
    id: 'r_factor', name: 'R Factor (pattern of liver injury)', category: 'Liver',
    requires: ['alt', 'alp'], reference: 'Bénichou C. J Hepatol 1990;11:272-6',
    lib: ['R Factor for Liver Injury'],
    compute: ({ alt, alp }, p) => {
      const altUln = p.ranges.alt?.high || 40;
      const alpUln = p.ranges.alp?.high || 129;
      if (alt <= altUln && alp <= alpUln) return NA('ALT and ALP are both within range, so there is no liver injury pattern to classify', 'ratio');
      const v = (alt / altUln) / (alp / alpUln);
      const b = v >= 5 ? 'Hepatocellular (≥ 5)' : v <= 2 ? 'Cholestatic (≤ 2)' : 'Mixed (2–5)';
      return { value: r2(v), unit: 'ratio', band: b, severity: 'mild', interpretation: `Pattern of liver enzyme rise: ${b.toLowerCase()} (upper limits ALT ${altUln}, ALP ${alpUln} U/L from the report).` };
    },
  },
  {
    id: 'bard', name: 'BARD Score (NAFLD fibrosis)', category: 'Liver',
    requires: ['ast', 'alt', 'bmi'], reference: 'Harrison SA et al. Gut 2008;57:1441-7',
    lib: ['BARD Score for NAFLD Fibrosis'],
    compute: ({ ast, alt }, { bmi, diabetes }) => {
      const s = (bmi >= 28 ? 1 : 0) + (ast / alt >= 0.8 ? 2 : 0) + (diabetes ? 1 : 0);
      return { value: s, unit: 'points', band: s >= 2 ? 'Advanced fibrosis not excluded (2–4)' : 'Advanced fibrosis unlikely (0–1)', severity: s >= 2 ? 'mild' : 'ok',
        interpretation: 'A score of 0–1 has a high negative predictive value (~96%) for advanced fibrosis in fatty liver disease.' };
    },
  },

  // =================================================================== Diabetes / metabolic
  {
    id: 'ada_status', name: 'Diabetes screening category (ADA)', category: 'Diabetes',
    requires: [], anyOf: [['hba1c', 'glucose_fasting', 'glucose_pp']], reference: 'ADA Standards of Care in Diabetes 2025, section 2',
    lib: ['Screening For And Diagnosing Diabetes - A1c and Fasting Plasma Glucose', 'Screening For And Diagnosing Diabetes - 75g Oral Glucose Tolerance Test (OGTT)'],
    compute: ({ hba1c, glucose_fasting: fpg, glucose_pp: pp }) => {
      const dm = (hba1c >= 6.5) || (fpg >= 126) || (pp >= 200);
      const pre = !dm && ((hba1c >= 5.7) || (fpg >= 100) || (pp >= 140));
      const used = [hba1c != null && `HbA1c ${hba1c}%`, fpg != null && `FPG ${fpg} mg/dL`, pp != null && `2-h PG ${pp} mg/dL`].filter(Boolean).join(', ');
      return { value: null, unit: '', band: dm ? 'Diabetes range' : pre ? 'Prediabetes range' : 'Normal', severity: dm ? 'moderate' : pre ? 'mild' : 'ok',
        interpretation: `${used}. ${dm ? 'Meets a diabetes threshold; a diagnosis needs confirmation with a second abnormal test.' : pre ? 'Prediabetes thresholds: HbA1c 5.7–6.4%, FPG 100–125, 2-h 140–199 mg/dL.' : 'Below prediabetes thresholds.'} Post-prandial values are not identical to a formal 75 g OGTT.` };
    },
  },
  {
    id: 'quicki', name: 'QUICKI (insulin sensitivity)', category: 'Diabetes',
    requires: ['glucose_fasting', 'insulin_fasting'], reference: 'Katz A et al. J Clin Endocrinol Metab 2000;85:2402-10',
    lib: ['QUICKI Formula for Insulin Resistance', 'QUICKI Calculator'],
    compute: ({ glucose_fasting, insulin_fasting }) => {
      const v = 1 / (Math.log10(insulin_fasting) + Math.log10(glucose_fasting));
      return { value: r3(v), unit: 'index', band: v < 0.339 ? 'Insulin resistance (< 0.339)' : 'Normal sensitivity (≥ 0.339)', severity: v < 0.339 ? 'mild' : 'ok', interpretation: 'Lower values mean lower insulin sensitivity.' };
    },
  },
  {
    id: 'homa_b', name: 'HOMA-%β (beta-cell function)', category: 'Diabetes',
    requires: ['glucose_fasting', 'insulin_fasting'], reference: 'Matthews DR et al. Diabetologia 1985;28:412-9',
    lib: ['HOMA Formula: Homeostasis Model Assessment of Insulin Resistance'],
    compute: ({ glucose_fasting, insulin_fasting }) => {
      if (glucose_fasting <= 63) return NA('fasting glucose must be above 63 mg/dL for this formula', '%');
      const v = (360 * insulin_fasting) / (glucose_fasting - 63);
      return { value: Math.round(v), unit: '%', band: v < 50 ? 'Reduced beta-cell function' : 'Adequate', severity: v < 50 ? 'mild' : 'ok', interpretation: '100% is the reference for normal-weight adults under 35. Interpret with HOMA-IR.' };
    },
  },
  {
    id: 'mets_ir', name: 'METS-IR (metabolic score for insulin resistance)', category: 'Diabetes',
    requires: ['glucose_fasting', 'triglycerides', 'hdl', 'bmi'], reference: 'Bello-Chavolla OY et al. Eur J Endocrinol 2018;178:533-44',
    lib: ['Metabolic Score for Insulin Resistance (METS-IR)'],
    compute: ({ glucose_fasting: g, triglycerides: tg, hdl }, { bmi }) => {
      const v = (Math.log(2 * g + tg) * bmi) / Math.log(hdl);
      return { value: r2(v), unit: 'score', band: v > 50.39 ? 'High (> 50.39)' : 'Not high (≤ 50.39)', severity: v > 50.39 ? 'mild' : 'ok', interpretation: 'Higher values reflect more insulin resistance and visceral fat; > 50.39 was linked to higher type 2 diabetes risk in the derivation study.' };
    },
  },
  {
    id: 'tyg_bmi', name: 'TyG-BMI', category: 'Diabetes',
    requires: ['triglycerides', 'glucose_fasting', 'bmi'], reference: 'Er LK et al. PLoS One 2016;11:e0149731',
    lib: [],
    compute: ({ triglycerides, glucose_fasting }, { bmi }) => {
      const v = Math.log((triglycerides * glucose_fasting) / 2) * bmi;
      return { value: Math.round(v), unit: 'index', band: v >= 213 ? 'Elevated (≥ 213)' : 'Not elevated', severity: v >= 213 ? 'mild' : 'ok', interpretation: 'Combines the TyG index with BMI; higher values indicate greater insulin resistance.' };
    },
  },

  // =================================================================== Lipids
  {
    id: 'vldl_calc', name: 'VLDL Cholesterol (calculated)', category: 'Lipids',
    requires: ['triglycerides'], reference: 'Friedewald WT et al. Clin Chem 1972',
    lib: ['Very Low Density Lipoprotein (VLDL)', 'VLDL Calculator'],
    compute: ({ triglycerides }) => {
      if (triglycerides >= 400) return NA('triglycerides are 400 mg/dL or more', 'mg/dL');
      const v = triglycerides / 5;
      return { value: r1(v), unit: 'mg/dL', band: v > 30 ? 'High (> 30)' : 'Normal (≤ 30)', severity: v > 30 ? 'mild' : 'ok', interpretation: 'VLDL estimated as triglycerides ÷ 5.' };
    },
  },
  {
    id: 'ascvd_pce', name: 'ASCVD 10-year risk (Pooled Cohort Equations)', category: 'Lipids',
    requires: ['total_cholesterol', 'hdl', 'age', 'sex'], reference: 'Goff DC et al. Circulation 2014;129:S49-73',
    lib: ['ASCVD (Atherosclerotic Cardiovascular Disease) 2013 Risk Calculator from AHA/ACC'],
    extras: [
      { id: 'sbp', label: 'Systolic blood pressure', type: 'number', unit: 'mmHg' },
      { id: 'bp_treated', label: 'On blood-pressure medicine', type: 'select', options: YESNO, default: 'no' },
      { id: 'smoker', label: 'Current smoker', type: 'select', options: YESNO, default: 'no' },
      { id: 'race', label: 'Equation set', type: 'select', options: [{ value: 'other', label: 'White / other (incl. South Asian)' }, { value: 'aa', label: 'African American' }], default: 'other' },
    ],
    compute: ({ total_cholesterol: tc, hdl }, { age, sex, diabetes }, x) => {
      if (age < 40 || age > 79) return NA('the equations are validated for ages 40–79', '%');
      const la = Math.log(age); const lt = Math.log(tc); const lh = Math.log(hdl); const ls = Math.log(x.sbp);
      const trt = x.bp_treated === 'yes'; const sm = x.smoker === 'yes' ? 1 : 0; const dm = diabetes ? 1 : 0;
      let sum; let s0; let mean;
      if (x.race === 'aa' && sex === 'F') {
        sum = 17.114 * la + 0.94 * lt - 18.92 * lh + 4.475 * la * lh + (trt ? 29.291 * ls - 6.432 * la * ls : 27.82 * ls - 6.087 * la * ls) + 0.691 * sm + 0.874 * dm;
        s0 = 0.9533; mean = 86.61;
      } else if (x.race === 'aa') {
        sum = 2.469 * la + 0.302 * lt - 0.307 * lh + (trt ? 1.916 : 1.809) * ls + 0.549 * sm + 0.645 * dm;
        s0 = 0.8954; mean = 19.54;
      } else if (sex === 'F') {
        sum = -29.799 * la + 4.884 * la * la + 13.54 * lt - 3.114 * la * lt - 13.578 * lh + 3.149 * la * lh + (trt ? 2.019 : 1.957) * ls + 7.574 * sm - 1.665 * la * sm + 0.661 * dm;
        s0 = 0.9665; mean = -29.18;
      } else {
        sum = 12.344 * la + 11.853 * lt - 2.664 * la * lt - 7.99 * lh + 1.769 * la * lh + (trt ? 1.797 : 1.764) * ls + 7.837 * sm - 1.795 * la * sm + 0.658 * dm;
        s0 = 0.9144; mean = 61.18;
      }
      const risk = (1 - s0 ** Math.exp(sum - mean)) * 100;
      const b = band(risk, [
        { lt: 5, band: 'Low (< 5%)', severity: 'ok' },
        { lt: 7.5, band: 'Borderline (5–7.4%)', severity: 'mild' },
        { lt: 20, band: 'Intermediate (7.5–19.9%)', severity: 'moderate' },
        { lt: Infinity, band: 'High (≥ 20%)', severity: 'severe' },
      ]);
      return { value: r1(risk), unit: '%', band: b.band, severity: b.severity,
        interpretation: `Estimated 10-year risk of heart attack or stroke: ${r1(risk)}%. Diabetes status comes from the patient profile/labs. These equations may underestimate risk in South Asians.` };
    },
  },

  // =================================================================== Blood
  {
    id: 'anc_calc', name: 'Absolute Neutrophil Count (calculated)', category: 'Blood',
    requires: ['wbc', 'neutrophils_pct'], reference: 'Standard haematology formula',
    lib: ['Absolute Neutrophil Count (ANC)', 'ANC Calculator — Absolute Neutrophil Count'],
    extras: [{ id: 'bands', label: 'Band forms (if reported)', type: 'number', unit: '%', default: 0, optional: true }],
    compute: ({ wbc, neutrophils_pct }, _p, x) => {
      const v = (wbc * 1000 * (neutrophils_pct + (x.bands || 0))) / 100;
      const b = band(v, [
        { lt: 500, band: 'Severe neutropenia (< 500)', severity: 'severe' },
        { lt: 1000, band: 'Moderate neutropenia (500–999)', severity: 'moderate' },
        { lt: 1500, band: 'Mild neutropenia (1000–1499)', severity: 'mild' },
        { lt: Infinity, band: 'Normal (≥ 1500)', severity: 'ok' },
      ]);
      return { value: Math.round(v), unit: 'cells/µL', band: b.band, severity: b.severity, interpretation: `ANC = WBC × (neutrophils% + bands%). ${b.band}.` };
    },
  },
  {
    id: 'alc_calc', name: 'Absolute Lymphocyte Count (calculated)', category: 'Blood',
    requires: ['wbc', 'lymphocytes_pct'], reference: 'Standard haematology formula',
    lib: ['Absolute Lymphocyte Count (ALC)'],
    compute: ({ wbc, lymphocytes_pct }) => {
      const v = (wbc * 1000 * lymphocytes_pct) / 100;
      return { value: Math.round(v), unit: 'cells/µL', band: v < 1000 ? 'Lymphopenia (< 1000)' : v > 4000 ? 'Lymphocytosis (> 4000)' : 'Normal (1000–4000)', severity: v < 500 ? 'moderate' : v < 1000 || v > 4000 ? 'mild' : 'ok', interpretation: 'ALC = WBC × lymphocytes%.' };
    },
  },
  {
    id: 'aec_calc', name: 'Absolute Eosinophil Count (calculated)', category: 'Blood',
    requires: ['wbc', 'eosinophils_pct'], reference: 'Standard haematology formula',
    lib: ['Absolute Eosinophil Count Calculator'],
    compute: ({ wbc, eosinophils_pct }) => {
      const v = (wbc * 1000 * eosinophils_pct) / 100;
      const b = band(v, [
        { lt: 500, band: 'Normal (< 500)', severity: 'ok' },
        { lt: 1500, band: 'Mild eosinophilia (500–1499)', severity: 'mild' },
        { lt: 5000, band: 'Moderate eosinophilia (1500–4999)', severity: 'moderate' },
        { lt: Infinity, band: 'Severe eosinophilia (≥ 5000)', severity: 'severe' },
      ]);
      return { value: Math.round(v), unit: 'cells/µL', band: b.band, severity: b.severity, interpretation: 'Raised eosinophils are commonly due to allergy or parasitic infection.' };
    },
  },
  {
    id: 'sii', name: 'Systemic Immune-Inflammation Index (SII)', category: 'Blood',
    requires: ['platelets', 'anc', 'alc'], reference: 'Hu B et al. Clin Cancer Res 2014;20:6212-22',
    lib: [],
    compute: ({ platelets, anc, alc }) => {
      const v = (platelets * anc) / alc;
      return { value: Math.round(v), unit: '×10⁹/L', band: v > 600 ? 'Raised (> 600)' : 'Typical (≤ 600)', severity: v > 600 ? 'mild' : 'ok', interpretation: 'Platelets × neutrophils ÷ lymphocytes. A non-specific marker of systemic inflammation; cut-offs vary between studies.' };
    },
  },
  {
    id: 'england_fraser', name: 'England & Fraser Index', category: 'Blood',
    requires: ['mcv', 'rbc', 'hemoglobin'], reference: 'England JM, Fraser PM. Lancet 1973;1:449-52',
    lib: ['England Fraser Index for Differentiating Beta-thalassemia Trait from Iron-deficiency'],
    compute: (v) => microcytic(v, () => thalIndex('England & Fraser index', r1(v.mcv - v.rbc - 5 * v.hemoglobin - 3.4), 0, true)),
  },
  {
    id: 'green_king', name: 'Green & King Index', category: 'Blood',
    requires: ['mcv', 'rdw', 'hemoglobin'], reference: 'Green R, King R. Blood Cells 1989;15:481-91',
    lib: ['Green King Index for Differentiating Beta-thalassemia Trait from Iron-deficiency'],
    compute: (v) => microcytic(v, () => thalIndex('Green & King index', r1((v.mcv * v.mcv * v.rdw) / (100 * v.hemoglobin)), 65, true)),
  },
  {
    id: 'shine_lal', name: 'Shine & Lal Index', category: 'Blood',
    requires: ['mcv', 'mch'], reference: 'Shine I, Lal S. Lancet 1977;1:692-3',
    lib: [],
    compute: (v) => microcytic(v, () => thalIndex('Shine & Lal index', Math.round((v.mcv * v.mcv * v.mch) / 100), 1530, true)),
  },
  {
    id: 'srivastava', name: 'Srivastava Index', category: 'Blood',
    requires: ['mch', 'rbc'], anyOf: [['mcv']], reference: 'Srivastava PC. Lancet 1973;1:1386',
    lib: [],
    compute: (v) => microcytic(v, () => thalIndex('Srivastava index', r2(v.mch / v.rbc), 3.8, true)),
  },
  {
    id: 'rdwi', name: 'RDW Index (RDWI)', category: 'Blood',
    requires: ['mcv', 'rdw', 'rbc'], reference: 'Jayabose S et al. J Pediatr Hematol Oncol 1999;21:314',
    lib: [],
    compute: (v) => microcytic(v, () => thalIndex('RDW index', Math.round((v.mcv * v.rdw) / v.rbc), 220, true)),
  },
  {
    id: 'sirdah', name: 'Sirdah Index', category: 'Blood',
    requires: ['mcv', 'rbc', 'hematocrit'], reference: 'Sirdah M et al. Int J Lab Hematol 2008;30:324-30',
    lib: [],
    compute: (v) => microcytic(v, () => thalIndex('Sirdah index', r1(v.mcv - v.rbc - 3 * v.hematocrit), 27, true)),
  },
  {
    id: 'corrected_retic', name: 'Corrected Reticulocyte Count & Production Index', category: 'Blood',
    requires: ['retic', 'hematocrit'], reference: 'Hillman RS, Finch CA. Red Cell Manual 1996',
    lib: ['Corrected Reticulocyte Percentage/Reticulocyte Production Index (RPI)', 'Reticulocyte Production Index', 'Corrected Reticulocyte Count Calculator'],
    compute: ({ retic, hematocrit }) => {
      const corr = (retic * hematocrit) / 45;
      const mat = hematocrit >= 40 ? 1 : hematocrit >= 30 ? 1.5 : hematocrit >= 20 ? 2 : 2.5;
      const rpi = corr / mat;
      return { value: r2(rpi), unit: 'RPI', band: rpi < 2 ? 'RPI < 2 — inadequate marrow response' : 'RPI ≥ 2 — adequate marrow response', severity: rpi < 2 && hematocrit < 36 ? 'moderate' : 'ok',
        interpretation: `Corrected reticulocyte count ${r2(corr)}%; production index ${r2(rpi)}. In anaemia, an RPI below 2 suggests the marrow is not responding (e.g. iron/B12 deficiency); above 2 suggests blood loss or haemolysis.` };
    },
  },
  {
    id: 'ganzoni', name: 'Ganzoni Iron Deficit', category: 'Blood', context: 'specialist',
    requires: ['hemoglobin', 'weight'], reference: 'Ganzoni AM. Schweiz Med Wochenschr 1970;100:301-3',
    lib: ['Ganzoni Equation for Iron Deficiency Anemia'],
    extras: [{ id: 'target_hb', label: 'Target hemoglobin', type: 'number', unit: 'g/dL', default: 15 }],
    compute: ({ hemoglobin }, { weight }, x) => {
      if (hemoglobin >= x.target_hb) return NA('hemoglobin is already at or above the target', 'mg');
      const stores = weight >= 35 ? 500 : 15 * weight;
      const v = weight * (x.target_hb - hemoglobin) * 2.4 + stores;
      return { value: Math.round(v), unit: 'mg iron', band: `${Math.round(v)} mg total iron deficit`, severity: 'moderate', interpretation: 'Total iron needed to correct hemoglobin and replenish stores — used to plan intravenous iron. Only relevant if iron deficiency is confirmed.' };
    },
  },
  {
    id: 'allowable_blood_loss', name: 'Maximum Allowable Blood Loss', category: 'Blood', context: 'specialist',
    requires: ['hematocrit', 'weight', 'sex'], reference: 'Gross JB. Anesthesiology 1983;58:277-80',
    lib: ['Maximum Allowable Blood Loss (ABL) Without Transfusion', 'Allowable Blood Loss Calculator'],
    extras: [{ id: 'target_hct', label: 'Lowest acceptable hematocrit', type: 'number', unit: '%', default: 25 }],
    compute: ({ hematocrit }, { weight, sex }, x) => {
      if (hematocrit <= x.target_hct) return NA('hematocrit is already at or below the target', 'mL');
      const ebv = weight * (sex === 'F' ? 65 : 75);
      const v = (ebv * (hematocrit - x.target_hct)) / ((hematocrit + x.target_hct) / 2);
      return { value: Math.round(v), unit: 'mL', band: `${Math.round(v)} mL`, severity: 'ok', interpretation: `Estimated blood volume ${Math.round(ebv)} mL. Used in surgical planning.` };
    },
  },

  // =================================================================== Thyroid
  {
    id: 'tsh_index', name: "Jostel's TSH Index", category: 'Thyroid',
    requires: ['tsh', 'ft4'], reference: 'Jostel A et al. Clin Endocrinol 2009;71:529-34',
    lib: [],
    compute: ({ tsh, ft4 }) => {
      const v = Math.log(tsh) + 0.1345 * ft4 * 12.87;
      return { value: r2(v), unit: 'index', band: v < 1.3 ? 'Low (< 1.3)' : v > 4.1 ? 'High (> 4.1)' : 'Normal (1.3–4.1)', severity: v < 1.3 ? 'mild' : 'ok',
        interpretation: 'Estimates pituitary TSH drive; a low index can point to central (pituitary) hypothyroidism.' };
    },
  },

  // =================================================================== Inflammation
  {
    id: 'mgps', name: 'Modified Glasgow Prognostic Score (mGPS)', category: 'Inflammation', context: 'specialist',
    requires: ['albumin'], anyOf: [['crp', 'hscrp']], reference: 'McMillan DC. Cancer Treat Rev 2013;39:534-40',
    lib: ['Modified Glasgow Prognostic Score (mGPS) for Cancer Outcomes', 'Glasgow Prognostic Score (GPS) for Cancer Outcomes'],
    compute: ({ crp, hscrp, albumin }) => {
      const c = crp ?? hscrp;
      const s = c <= 10 ? 0 : albumin >= 3.5 ? 1 : 2;
      return { value: s, unit: 'points', band: `mGPS ${s}`, severity: s === 0 ? 'ok' : s === 1 ? 'mild' : 'moderate', interpretation: 'Combines CRP (> 10 mg/L) and low albumin (< 3.5 g/dL); used as a prognostic marker in cancer.' };
    },
  },
  {
    id: 'crp_albumin', name: 'CRP / Albumin Ratio', category: 'Inflammation',
    requires: ['albumin'], anyOf: [['crp', 'hscrp']], reference: 'Fairclough E et al. Clin Med 2009;9:30-3',
    lib: [],
    compute: ({ crp, hscrp, albumin }) => {
      const v = (crp ?? hscrp) / albumin;
      return { value: r2(v), unit: 'ratio', band: v > 2 ? 'Raised (> 2)' : 'Low', severity: v > 2 ? 'mild' : 'ok', interpretation: 'A higher ratio indicates more inflammation relative to nutritional/protein status.' };
    },
  },
  {
    id: 'lrinec', name: 'LRINEC Score (necrotizing soft-tissue infection)', category: 'Inflammation', context: 'specialist',
    requires: ['wbc', 'hemoglobin', 'sodium', 'creatinine'], anyOf: [['crp'], ['glucose_random', 'glucose_fasting']], reference: 'Wong CH et al. Crit Care Med 2004;32:1535-41',
    lib: ['LRINEC Score for Necrotizing Soft Tissue Infection', 'LRINEC Score Calculator'],
    compute: (v) => {
      const g = v.glucose_random ?? v.glucose_fasting;
      const s = (v.crp >= 150 ? 4 : 0) + (v.wbc > 25 ? 2 : v.wbc >= 15 ? 1 : 0) + (v.hemoglobin < 11 ? 2 : v.hemoglobin <= 13.5 ? 1 : 0) +
        (v.sodium < 135 ? 2 : 0) + (v.creatinine > 1.6 ? 2 : 0) + (g > 180 ? 1 : 0);
      return { value: s, unit: 'points', band: s >= 8 ? 'High risk (≥ 8)' : s >= 6 ? 'Intermediate (6–7)' : 'Low risk (≤ 5)', severity: s >= 8 ? 'severe' : s >= 6 ? 'moderate' : 'ok',
        interpretation: 'Only meaningful for a patient with a severe skin/soft-tissue infection; the lab values alone do not imply infection.' };
    },
  },

  // =================================================================== Body
  {
    id: 'bsa', name: 'Body Surface Area (Mosteller & Du Bois)', category: 'Body',
    requires: ['height', 'weight'], reference: 'Mosteller RD. NEJM 1987;317:1098; Du Bois D, Du Bois EF. Arch Intern Med 1916',
    lib: ['Body Surface Area (BSA, Mosteller, square root method)', 'Body Surface Area (BSA, Du Bois Method)', 'BSA Calculator – Body Surface Area'],
    compute: (_v, { height, weight }) => {
      const m = Math.sqrt((height * weight) / 3600);
      const d = 0.007184 * weight ** 0.425 * height ** 0.725;
      return { value: r2(m), unit: 'm²', band: `Du Bois ${r2(d)} m²`, severity: 'ok', interpretation: 'Body surface area is used for drug dosing and indexing cardiac/kidney measurements.' };
    },
  },
  {
    id: 'ibw', name: 'Ideal & Adjusted Body Weight (Devine)', category: 'Body',
    requires: ['height', 'weight', 'sex'], reference: 'Devine BJ. Drug Intell Clin Pharm 1974;8:650-5',
    lib: ['Ideal body weight (method of Devine) and adjusted body weight for adults', 'Ideal Body Weight and Adjusted Body Weight', 'Ideal Body Weight', 'Adjusted Body Weight Calculator'],
    compute: (_v, p) => {
      const ibw = ibwKg(p);
      const abw = ibw + 0.4 * (p.weight - ibw);
      return { value: r1(ibw), unit: 'kg', band: `Adjusted ${r1(abw)} kg · actual is ${Math.round((p.weight / ibw) * 100)}% of ideal`, severity: 'ok', interpretation: 'Ideal body weight from height; adjusted body weight is used for drug dosing in obesity.' };
    },
  },
  {
    id: 'lbw', name: 'Lean Body Weight (Janmahasatian)', category: 'Body',
    requires: ['height', 'weight', 'sex'], reference: 'Janmahasatian S et al. Clin Pharmacokinet 2005;44:1051-65',
    lib: ['Lean Body Weight (Male)', 'Lean Body Weight (Female)', 'Lean Body Mass Calculator'],
    compute: (_v, p) => {
      const bmi = p.weight / (p.height / 100) ** 2;
      const v = p.sex === 'F' ? (9270 * p.weight) / (8780 + 244 * bmi) : (9270 * p.weight) / (6680 + 216 * bmi);
      return { value: r1(v), unit: 'kg', band: `${Math.round((v / p.weight) * 100)}% of body weight`, severity: 'ok', interpretation: 'Estimated fat-free mass.' };
    },
  },
  {
    id: 'tbw_watson', name: 'Total Body Water (Watson)', category: 'Body',
    requires: ['height', 'weight', 'age', 'sex'], reference: 'Watson PE et al. Am J Clin Nutr 1980;33:27-39',
    lib: ['Total Body Water (Watson Formula)', 'Total Body Water Calculator', 'Total Body Water in Adult Males (Watson formula)', 'Total Body Water in Adult Females (Watson formula)'],
    compute: (_v, { height, weight, age, sex }) => {
      const v = sex === 'F' ? -2.097 + 0.1069 * height + 0.2466 * weight : 2.447 - 0.09516 * age + 0.1074 * height + 0.3362 * weight;
      return { value: r1(v), unit: 'L', band: `${Math.round((v / weight) * 100)}% of body weight`, severity: 'ok', interpretation: 'Used for fluid and electrolyte calculations and dialysis dosing.' };
    },
  },
];

function meldBand(s) {
  return s < 10 ? '< 10' : s < 20 ? '10–19' : s < 30 ? '20–29' : s < 40 ? '30–39' : '≥ 40';
}
function meldMortality(s) {
  const m = s < 10 ? '1.9%' : s < 20 ? '6.0%' : s < 30 ? '19.6%' : s < 40 ? '52.6%' : '71.3%';
  return `Approximate 3-month mortality in hospitalised cirrhosis patients: ${m}.`;
}
