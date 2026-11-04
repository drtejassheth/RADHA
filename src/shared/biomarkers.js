// Biomarker catalog: canonical units, unit conversions, aliases and default adult reference ranges.
// Every downstream module (calculators, analysis, trends) works in these canonical units only.
//
// conv: normalized-unit -> factor (multiply) or function. See normUnit() for the normalized spelling.
// ref:  { low, high } or { m: {low, high}, f: {low, high} }  (null = open-ended)
// crit: { low, high } critical thresholds that deserve urgent attention.
// scale: 'count3' | 'count6' | 'plt' | 'fraction' for counts reported in mixed magnitudes.

export const PANELS = [
  'Complete Blood Count',
  'Diabetes / Glycemic',
  'Lipid Profile',
  'Kidney Function',
  'Electrolytes & Minerals',
  'Liver Function',
  'Thyroid',
  'Vitamins & Iron',
  'Inflammation & Cardiac',
  'Other',
];

const CHOL = { 'mg/dl': 1, 'mmol/l': 38.67 };
const TG = { 'mg/dl': 1, 'mmol/l': 88.57 };
const GLU = { 'mg/dl': 1, 'mmol/l': 18.016 };
const ENZ = { 'u/l': 1, 'iu/l': 1, 'ukat/l': 60 };
const MMOL = { 'mmol/l': 1, 'meq/l': 1 };
const GDL = { 'g/dl': 1, 'g/l': 0.1, 'gm/dl': 1, 'gm%': 1, 'g%': 1 };

const B = (key, name, panel, unit, aliases, opts = {}) => ({
  key, name, panel, unit, aliases, ...opts,
  conv: { [normUnit(unit)]: 1, ...(opts.conv || {}) },
});

export const BIOMARKERS = [
  // ---------------- Complete Blood Count
  B('hemoglobin', 'Hemoglobin', 'Complete Blood Count', 'g/dL', ['ha?emoglobin', 'hb', 'hgb'],
    { conv: { ...GDL, 'mmol/l': 1.611 }, ref: { m: { low: 13.0, high: 17.0 }, f: { low: 12.0, high: 15.5 } }, crit: { low: 7, high: 20 } }),
  B('rbc', 'RBC Count', 'Complete Blood Count', '10^6/µL', ['(total )?r\\.?b\\.?c\\.?( count)?', 'red (blood )?cell( count)?', 'erythrocyte(s| count)?'],
    { scale: 'count6', ref: { m: { low: 4.5, high: 5.9 }, f: { low: 4.0, high: 5.2 } } }),
  B('hematocrit', 'Hematocrit (PCV)', 'Complete Blood Count', '%', ['ha?ematocrit', 'hct', 'p\\.?c\\.?v\\.?', 'packed cell volume'],
    { scale: 'fraction', ref: { m: { low: 40, high: 50 }, f: { low: 36, high: 46 } } }),
  B('mcv', 'MCV', 'Complete Blood Count', 'fL', ['m\\.?c\\.?v\\.?', 'mean corpuscular volume', 'mean cell volume'], { conv: { fl: 1, 'cu.microns': 1, um3: 1 }, ref: { low: 80, high: 100 } }),
  B('mch', 'MCH', 'Complete Blood Count', 'pg', ['m\\.?c\\.?h\\.?(?!\\.?c)', 'mean (corpuscular|cell) ha?emoglobin(?! conc)'], { conv: { pg: 1, picograms: 1 }, ref: { low: 27, high: 33 } }),
  B('mchc', 'MCHC', 'Complete Blood Count', 'g/dL', ['m\\.?c\\.?h\\.?c\\.?', 'mean (corpuscular|cell) (ha?emoglobin|hb) conc(entration|n)?\\.?'], { conv: { ...GDL, '%': 1 }, ref: { low: 32, high: 36 } }),
  B('rdw', 'RDW-CV', 'Complete Blood Count', '%', ['r\\.?d\\.?w\\.?(\\s*-?\\s*cv)?', 'red cell distribution width( - ?cv)?'], { ref: { low: 11.5, high: 14.5 } }),
  B('wbc', 'Total WBC Count', 'Complete Blood Count', '10^3/µL', ['(total )?w\\.?b\\.?c\\.?( count)?', 'total leu(c|k)ocytes?( \\(wbc\\))?( count)?', 'tlc', 'white (blood )?cell( count)?', 'leu(c|k)ocytes?( count)?'],
    { scale: 'count3', ref: { low: 4.0, high: 11.0 }, crit: { low: 2.0, high: 30 } }),
  B('neutrophils_pct', 'Neutrophils', 'Complete Blood Count', '%', ['neutrophils?', 'polymorphs', 'segmented neutrophils?', 'segs'], { absoluteKey: 'anc', ref: { low: 40, high: 75 } }),
  B('lymphocytes_pct', 'Lymphocytes', 'Complete Blood Count', '%', ['lymphocytes?'], { absoluteKey: 'alc', ref: { low: 20, high: 45 } }),
  B('monocytes_pct', 'Monocytes', 'Complete Blood Count', '%', ['monocytes?'], { absoluteKey: 'amc', ref: { low: 2, high: 10 } }),
  B('eosinophils_pct', 'Eosinophils', 'Complete Blood Count', '%', ['eosinophils?'], { absoluteKey: 'aec', ref: { low: 1, high: 6 } }),
  B('basophils_pct', 'Basophils', 'Complete Blood Count', '%', ['basophils?'], { absoluteKey: 'abc', ref: { low: 0, high: 2 } }),
  B('anc', 'Absolute Neutrophil Count', 'Complete Blood Count', '10^3/µL', ['absolute neutrophils?( count)?', 'a\\.?n\\.?c\\.?', 'neutrophils?,? (absolute|abs\\.?)( count)?', 'abs\\.? neutrophils?'], { scale: 'count3', ref: { low: 2.0, high: 7.5 }, crit: { low: 0.5 } }),
  B('alc', 'Absolute Lymphocyte Count', 'Complete Blood Count', '10^3/µL', ['absolute lymphocytes?( count)?', 'a\\.?l\\.?c\\.?', 'lymphocytes?,? (absolute|abs\\.?)( count)?', 'abs\\.? lymphocytes?'], { scale: 'count3', ref: { low: 1.0, high: 4.0 } }),
  B('amc', 'Absolute Monocyte Count', 'Complete Blood Count', '10^3/µL', ['absolute monocytes?( count)?', 'monocytes?,? (absolute|abs\\.?)( count)?', 'abs\\.? monocytes?'], { scale: 'count3', ref: { low: 0.2, high: 1.0 } }),
  B('aec', 'Absolute Eosinophil Count', 'Complete Blood Count', '10^3/µL', ['absolute eosinophils?( count)?', 'a\\.?e\\.?c\\.?', 'eosinophils?,? (absolute|abs\\.?)( count)?', 'abs\\.? eosinophils?'], { scale: 'count3', ref: { low: 0.02, high: 0.5 } }),
  B('abc', 'Absolute Basophil Count', 'Complete Blood Count', '10^3/µL', ['absolute basophils?( count)?', 'basophils?,? (absolute|abs\\.?)( count)?', 'abs\\.? basophils?'], { scale: 'count3', ref: { low: 0, high: 0.1 } }),
  B('platelets', 'Platelet Count', 'Complete Blood Count', '10^3/µL', ['platelets?( count)?', 'plt( count)?', 'thrombocytes?( count)?'],
    { scale: 'plt', ref: { low: 150, high: 450 }, crit: { low: 50, high: 1000 } }),
  B('mpv', 'MPV', 'Complete Blood Count', 'fL', ['m\\.?p\\.?v\\.?', 'mean platelet volume'], { conv: { fl: 1 }, ref: { low: 7.5, high: 11.5 } }),
  B('retic', 'Reticulocyte Count', 'Complete Blood Count', '%', ['reticulocytes?( count)?(,? %)?', 'retic( count)?'], { ref: { low: 0.5, high: 2.5 } }),
  B('pt', 'Prothrombin Time', 'Complete Blood Count', 'sec', ['prothrombin time( \\(pt\\))?', 'p\\.?t\\.?(?! ?inr)', 'pt[\\s\\-]?test'], { conv: { sec: 1, seconds: 1, secs: 1, s: 1 }, ref: { low: 11, high: 13.5 } }),
  B('inr', 'INR', 'Complete Blood Count', 'ratio', ['i\\.?n\\.?r\\.?', '(pt[\\s\\-]?)?international normali[sz]ed ratio'], { ref: { low: 0.8, high: 1.2 } }),
  B('esr', 'ESR', 'Complete Blood Count', 'mm/hr', ['e\\.?s\\.?r\\.?', 'erythrocyte sedimentation rate'], { conv: { 'mm/hr': 1, 'mm/h': 1, 'mm/1sthr': 1, 'mm/1hr': 1, 'mm/1sthour': 1 }, ref: { m: { low: 0, high: 15 }, f: { low: 0, high: 20 } } }),

  // ---------------- Glycemic
  B('glucose_fasting', 'Fasting Plasma Glucose', 'Diabetes / Glycemic', 'mg/dL',
    ['(plasma |blood )?glucose[,\\s\\-–]*\\(?\\s*fasting\\s*\\)?', 'fasting (plasma |blood )?(glucose|sugar)', 'f\\.?b\\.?s\\.?', 'f\\.?p\\.?g\\.?', 'blood sugar[,\\s\\-–]*\\(?fasting\\)?'],
    { conv: GLU, ref: { low: 70, high: 99 }, crit: { low: 54, high: 400 } }),
  B('glucose_pp', 'Post-prandial Glucose', 'Diabetes / Glycemic', 'mg/dL',
    ['(plasma |blood )?glucose[,\\s\\-–]*\\(?\\s*(post[\\s\\-]?prandial|pp|2\\s*hr?s?\\s*pp)\\s*\\)?', '(post[\\s\\-]?prandial|pp) (plasma |blood )?(glucose|sugar)', 'p\\.?p\\.?b\\.?s\\.?', 'p\\.?\\s?p\\.?\\s*(plasma |blood )?(glucose|sugar)', 'blood sugar[,\\s\\-–]*\\(?(pp|post[\\s\\-]?prandial)\\)?'],
    { conv: GLU, ref: { low: 70, high: 139 }, crit: { low: 54, high: 400 } }),
  B('glucose_random', 'Random Glucose', 'Diabetes / Glycemic', 'mg/dL',
    ['(plasma |blood )?glucose[,\\s\\-–]*\\(?\\s*random\\s*\\)?', 'random (plasma |blood )?(glucose|sugar)', 'r\\.?b\\.?s\\.?'],
    { conv: GLU, ref: { low: 70, high: 139 }, crit: { low: 54, high: 400 } }),
  B('hba1c', 'HbA1c', 'Diabetes / Glycemic', '%', ['h\\.?b\\.?\\s*a\\s*1\\s*c', 'glyc(at|osyl)ated ha?emoglobin', 'a1c'],
    { conv: { '%': 1, 'mmol/mol': (v) => v / 10.929 + 2.15 }, ref: { low: 4.0, high: 5.6 } }),
  B('insulin_fasting', 'Fasting Insulin', 'Diabetes / Glycemic', 'µIU/mL', ['(serum )?insulin[,\\s\\-–]*\\(?\\s*fasting\\s*\\)?', 'fasting (serum )?insulin', 'insulin'],
    { conv: { 'uiu/ml': 1, 'miu/l': 1, 'uu/ml': 1, 'mu/l': 1, 'pmol/l': 1 / 6 }, ref: { low: 2.6, high: 24.9 } }),

  // ---------------- Lipids
  B('total_cholesterol', 'Total Cholesterol', 'Lipid Profile', 'mg/dL', ['(serum )?(total )?cholesterol(,? total)?(?![\\s,\\-–/]*(hdl|ldl|vldl|non))', 't\\.?\\s?chol(esterol)?'],
    { conv: CHOL, ref: { low: null, high: 199 } }),
  B('hdl', 'HDL Cholesterol', 'Lipid Profile', 'mg/dL', ['hdl([\\s\\-]*(cholesterol|chol|c))?(,? direct)?', '(cholesterol|chol)[\\s,\\-–]*hdl', 'high density lipoprotein( cholesterol)?'],
    { conv: CHOL, ref: { m: { low: 40, high: null }, f: { low: 50, high: null } } }),
  B('ldl', 'LDL Cholesterol', 'Lipid Profile', 'mg/dL', ['ldl([\\s\\-]*(cholesterol|chol|c))?(,? (direct|calculated))?', '(cholesterol|chol)[\\s,\\-–]*ldl', 'low density lipoprotein( cholesterol)?'],
    { conv: CHOL, ref: { low: null, high: 99 } }),
  B('vldl', 'VLDL Cholesterol', 'Lipid Profile', 'mg/dL', ['vldl([\\s\\-]*(cholesterol|chol|c))?', '(cholesterol|chol)[\\s,\\-–]*vldl', 'very low density lipoprotein'],
    { conv: CHOL, ref: { low: 5, high: 40 } }),
  B('triglycerides', 'Triglycerides', 'Lipid Profile', 'mg/dL', ['(serum )?triglycerides?', 't\\.?g\\.?', 'trigs'], { conv: TG, ref: { low: null, high: 149 }, crit: { high: 1000 } }),
  B('non_hdl', 'Non-HDL Cholesterol', 'Lipid Profile', 'mg/dL', ['non[\\s\\-]?hdl([\\s\\-]*(cholesterol|chol|c))?'], { conv: CHOL, ref: { low: null, high: 129 } }),
  B('chol_hdl_ratio', 'Total Cholesterol / HDL Ratio', 'Lipid Profile', 'ratio', ['(total )?(cholesterol|chol|tc)\\s*/\\s*hdl( cholesterol)?( ratio)?', 'chol(esterol)?[\\s\\-]*hdl ratio'], { conv: { ratio: 1, '': 1 }, ref: { low: null, high: 5.0 } }),
  B('ldl_hdl_ratio', 'LDL / HDL Ratio', 'Lipid Profile', 'ratio', ['ldl\\s*/\\s*hdl( cholesterol)?( ratio)?', 'ldl[\\s\\-]*hdl ratio'], { conv: { ratio: 1, '': 1 }, ref: { low: null, high: 3.5 } }),

  // ---------------- Kidney
  B('creatinine', 'Creatinine', 'Kidney Function', 'mg/dL', ['(serum )?creatinine(,? serum)?(?!\\s*(clearance|ratio|kinase))', 's\\.?\\s?creat(inine)?'],
    { conv: { 'mg/dl': 1, 'umol/l': 1 / 88.4 }, ref: { m: { low: 0.7, high: 1.3 }, f: { low: 0.6, high: 1.1 } } }),
  B('urea', 'Urea', 'Kidney Function', 'mg/dL', ['(blood |serum )?urea(?![\\s\\-]*nitrogen)'], { conv: { 'mg/dl': 1, 'mmol/l': 6.006 }, ref: { low: 15, high: 40 } }),
  B('bun', 'Blood Urea Nitrogen', 'Kidney Function', 'mg/dL', ['b\\.?u\\.?n\\.?', '(blood )?urea nitrogen'], { conv: { 'mg/dl': 1, 'mmol/l': 2.801 }, ref: { low: 7, high: 20 } }),
  B('uric_acid', 'Uric Acid', 'Kidney Function', 'mg/dL', ['(serum )?uric acid'], { conv: { 'mg/dl': 1, 'umol/l': 1 / 59.48, 'mmol/l': 16.81 }, ref: { m: { low: 3.5, high: 7.2 }, f: { low: 2.6, high: 6.0 } } }),
  B('egfr_reported', 'eGFR (as reported)', 'Kidney Function', 'mL/min/1.73m²', ['e\\.?gfr( \\(?(ckd[\\s\\-]?epi|mdrd)[^)]*\\)?)?', 'estimated glomerular filtration rate'],
    { conv: { 'ml/min/1.73m2': 1, 'ml/min/1.73m²': 1, 'ml/min/1.73sqm': 1, 'ml/min': 1 }, ref: { low: 60, high: null }, crit: { low: 15 } }),
  B('cystatin_c', 'Cystatin C', 'Kidney Function', 'mg/L', ['(serum )?cystatin[\\s\\-]?c'], { conv: { 'mg/l': 1, 'nmol/l': 1 / 74.9 }, ref: { low: 0.6, high: 1.0 } }),
  B('uacr', 'Urine Albumin/Creatinine Ratio', 'Kidney Function', 'mg/g', ['(urine )?(micro)?albumin\\s*/\\s*creatinine( ratio)?', 'u?acr', 'urine albumin creatinine ratio'],
    { conv: { 'mg/g': 1, 'ug/mg': 1, 'mg/gm': 1, 'mg/gcreat': 1, 'mg/mmol': 8.84 }, ref: { low: null, high: 29.9 } }),
  B('urine_microalbumin', 'Urine Microalbumin', 'Kidney Function', 'mg/L', ['(urine )?micro[\\s\\-]?albumin(?!\\s*/)'], { conv: { 'mg/l': 1, 'ug/ml': 1 }, ref: { low: null, high: 20 } }),

  // ---------------- Electrolytes & minerals
  B('sodium', 'Sodium', 'Electrolytes & Minerals', 'mmol/L', ['(serum )?sodium', 'na\\+?'], { conv: MMOL, ref: { low: 135, high: 145 }, crit: { low: 120, high: 160 } }),
  B('potassium', 'Potassium', 'Electrolytes & Minerals', 'mmol/L', ['(serum )?potassium', 'k\\+?'], { conv: MMOL, ref: { low: 3.5, high: 5.1 }, crit: { low: 2.5, high: 6.5 } }),
  B('chloride', 'Chloride', 'Electrolytes & Minerals', 'mmol/L', ['(serum )?chloride', 'cl\\-?'], { conv: MMOL, ref: { low: 98, high: 107 } }),
  B('bicarbonate', 'Bicarbonate', 'Electrolytes & Minerals', 'mmol/L', ['(serum )?bicarbonate', 'hco3\\-?', '(total )?co2'], { conv: MMOL, ref: { low: 22, high: 29 } }),
  B('calcium', 'Calcium', 'Electrolytes & Minerals', 'mg/dL', ['(serum )?(total )?calcium(,? total)?(?!,? ionized)'], { conv: { 'mg/dl': 1, 'mmol/l': 4.008 }, ref: { low: 8.6, high: 10.3 }, crit: { low: 6.5, high: 13 } }),
  B('phosphorus', 'Phosphorus', 'Electrolytes & Minerals', 'mg/dL', ['(serum )?(inorganic )?phosph(orus|orous|ate)'], { conv: { 'mg/dl': 1, 'mmol/l': 3.097 }, ref: { low: 2.5, high: 4.5 } }),
  B('magnesium', 'Magnesium', 'Electrolytes & Minerals', 'mg/dL', ['(serum )?magnesium'], { conv: { 'mg/dl': 1, 'mmol/l': 2.431, 'meq/l': 1.215 }, ref: { low: 1.7, high: 2.4 } }),

  // ---------------- Liver
  B('bilirubin_total', 'Total Bilirubin', 'Liver Function', 'mg/dL', ['(serum )?bilirubin[,\\s\\-–]*\\(?total\\)?', 'total bilirubin', 't\\.?\\s?bil(irubin)?'], { conv: { 'mg/dl': 1, 'umol/l': 1 / 17.1 }, ref: { low: 0.3, high: 1.2 } }),
  B('bilirubin_direct', 'Direct Bilirubin', 'Liver Function', 'mg/dL', ['(serum )?bilirubin[,\\s\\-–]*\\(?(direct|conjugated)\\)?', '(direct|conjugated) bilirubin', 'd\\.?\\s?bil(irubin)?'], { conv: { 'mg/dl': 1, 'umol/l': 1 / 17.1 }, ref: { low: 0, high: 0.3 } }),
  B('bilirubin_indirect', 'Indirect Bilirubin', 'Liver Function', 'mg/dL', ['(serum )?bilirubin[,\\s\\-–]*\\(?(indirect|unconjugated)\\)?', '(indirect|unconjugated) bilirubin'], { conv: { 'mg/dl': 1, 'umol/l': 1 / 17.1 }, ref: { low: 0.2, high: 0.9 } }),
  B('ast', 'AST (SGOT)', 'Liver Function', 'U/L', ['(s\\.?)?g\\.?o\\.?t\\.?(\\s*\\(?ast\\)?)?', 'a\\.?s\\.?t\\.?(\\s*\\(?s\\.?g\\.?o\\.?t\\.?\\)?)?', 'aspartate (amino)?transaminase', 'aspartate aminotransferase'], { conv: ENZ, ref: { low: 0, high: 40 } }),
  B('alt', 'ALT (SGPT)', 'Liver Function', 'U/L', ['(s\\.?)?g\\.?p\\.?t\\.?(\\s*\\(?alt\\)?)?', 'a\\.?l\\.?t\\.?(\\s*\\(?s\\.?g\\.?p\\.?t\\.?\\)?)?', 'alanine (amino)?transaminase', 'alanine aminotransferase'], { conv: ENZ, ref: { low: 0, high: 40 } }),
  B('alp', 'Alkaline Phosphatase', 'Liver Function', 'U/L', ['alk(aline)?\\.? phos(phatase)?', 'a\\.?l\\.?p\\.?'], { conv: ENZ, ref: { low: 44, high: 147 } }),
  B('ggt', 'GGT', 'Liver Function', 'U/L', ['g\\.?g\\.?t\\.?p?\\.?', 'gamma[\\s\\-]?glutamyl\\s?transferase', 'gamma g\\.?t\\.?'], { conv: ENZ, ref: { m: { low: 0, high: 60 }, f: { low: 0, high: 40 } } }),
  B('total_protein', 'Total Protein', 'Liver Function', 'g/dL', ['(serum )?(total )?proteins?(,? total)?'], { conv: GDL, ref: { low: 6.0, high: 8.3 } }),
  B('albumin', 'Albumin', 'Liver Function', 'g/dL', ['(serum )?albumin(?!\\s*/)'], { conv: GDL, ref: { low: 3.5, high: 5.2 } }),
  B('globulin', 'Globulin', 'Liver Function', 'g/dL', ['(serum )?globulin'], { conv: GDL, ref: { low: 2.0, high: 3.5 } }),
  B('ag_ratio', 'A/G Ratio', 'Liver Function', 'ratio', ['a\\s*/\\s*g ratio', 'albumin\\s*/\\s*globulin( ratio)?', 'a:g ratio'], { conv: { ratio: 1, '': 1 }, ref: { low: 1.1, high: 2.5 } }),

  // ---------------- Thyroid
  B('tsh', 'TSH', 'Thyroid', 'µIU/mL', ['(ultra[\\s\\-]?sensitive )?t\\.?s\\.?h\\.?(\\s*\\(?ultra[\\s\\-]?sensitive\\)?)?(\\s*-?\\s*3rd generation)?', '(ultra[\\s\\-]?sensitive )?thyroid stimulating hormone'],
    { conv: { 'uiu/ml': 1, 'miu/l': 1, 'mu/l': 1, 'uu/ml': 1, 'miu/ml': 1000 }, ref: { low: 0.4, high: 4.5 }, crit: { high: 50 } }),
  B('t3_total', 'Total T3', 'Thyroid', 'ng/dL', ['(total )?t3(,? total)?(?! ?free)', '(total )?tri+i?o?do?thyronine(,? total)?(?! ?free)'], { conv: { 'ng/dl': 1, 'nmol/l': 65.1, 'ng/ml': 100 }, ref: { low: 80, high: 200 } }),
  B('t4_total', 'Total T4', 'Thyroid', 'µg/dL', ['(total )?t4(,? total)?(?! ?free)', '(total )?thyroxine(,? total)?(?! ?free)'], { conv: { 'ug/dl': 1, 'nmol/l': 1 / 12.87 }, ref: { low: 5.0, high: 12.0 } }),
  B('ft3', 'Free T3', 'Thyroid', 'pg/mL', ['free t3', 'f\\.?t3', 't3,? free', 'free triiodothyronine'], { conv: { 'pg/ml': 1, 'pmol/l': 0.651 }, ref: { low: 2.3, high: 4.2 } }),
  B('ft4', 'Free T4', 'Thyroid', 'ng/dL', ['free t4', 'f\\.?t4', 't4,? free', 'free thyroxine'], { conv: { 'ng/dl': 1, 'pmol/l': 1 / 12.87 }, ref: { low: 0.8, high: 1.8 } }),

  // ---------------- Vitamins & iron
  B('vitamin_d', 'Vitamin D (25-OH)', 'Vitamins & Iron', 'ng/mL', ['(total )?(25[\\s\\-]?(oh|hydroxy)[\\s\\-]?)?vitamin[\\s\\-]?d3?(,? 25[\\s\\-]?(oh|hydroxy))?(,? total)?', '25[\\s\\-]?(oh|hydroxy)[\\s\\-]?(vit(amin)?\\s?)?d'],
    { conv: { 'ng/ml': 1, 'ug/l': 1, 'nmol/l': 1 / 2.496 }, ref: { low: 30, high: 100 } }),
  B('vitamin_b12', 'Vitamin B12', 'Vitamins & Iron', 'pg/mL', ['vit(amin)?\\.?[\\s\\-]?b[\\s\\-]?12', '(cyano)?cobalamin'], { conv: { 'pg/ml': 1, 'ng/l': 1, 'pmol/l': 1.355 }, ref: { low: 200, high: 900 } }),
  B('folate', 'Folate', 'Vitamins & Iron', 'ng/mL', ['(serum )?fol(ate|ic acid)'], { conv: { 'ng/ml': 1, 'ug/l': 1, 'nmol/l': 1 / 2.266 }, ref: { low: 4.0, high: 20 } }),
  B('ferritin', 'Ferritin', 'Vitamins & Iron', 'ng/mL', ['(serum )?ferritin'], { conv: { 'ng/ml': 1, 'ug/l': 1, 'pmol/l': 1 / 2.247 }, ref: { m: { low: 30, high: 400 }, f: { low: 15, high: 150 } } }),
  B('iron', 'Serum Iron', 'Vitamins & Iron', 'µg/dL', ['(serum )?iron(?!\\s*binding)'], { conv: { 'ug/dl': 1, 'umol/l': 5.585 }, ref: { m: { low: 65, high: 175 }, f: { low: 50, high: 170 } } }),
  B('tibc', 'TIBC', 'Vitamins & Iron', 'µg/dL', ['t\\.?i\\.?b\\.?c\\.?', 'total iron binding capacity'], { conv: { 'ug/dl': 1, 'umol/l': 5.585 }, ref: { low: 250, high: 450 } }),
  B('tsat', 'Transferrin Saturation', 'Vitamins & Iron', '%', ['(%\\s*)?transferrin saturation', '(%\\s*)?t\\.?sat', 'iron saturation'], { ref: { low: 20, high: 50 } }),

  // ---------------- Inflammation & cardiac
  B('crp', 'C-Reactive Protein', 'Inflammation & Cardiac', 'mg/L', ['c[\\s\\-]?reactive protein(?!.*(hs|high))', 'crp(,? quantitative)?'], { conv: { 'mg/l': 1, 'mg/dl': 10 }, ref: { low: null, high: 5 } }),
  B('hscrp', 'hs-CRP', 'Inflammation & Cardiac', 'mg/L', ['hs[\\s\\-]?crp', '(high[\\s\\-]sensitiv(e|ity)) c[\\s\\-]?reactive protein', 'c[\\s\\-]?reactive protein,? (hs|high[\\s\\-]sensitiv(e|ity))'], { conv: { 'mg/l': 1, 'mg/dl': 10 }, ref: { low: null, high: 3.0 } }),
  B('homocysteine', 'Homocysteine', 'Inflammation & Cardiac', 'µmol/L', ['(serum |plasma )?homocysteine'], { conv: { 'umol/l': 1 }, ref: { low: 5, high: 15 } }),
  B('ige', 'Total IgE', 'Inflammation & Cardiac', 'IU/mL', ['(serum |total )?ig[\\s\\-]?e(,? total)?', 'immunoglobulin e'], { conv: { 'iu/ml': 1, 'kiu/l': 1, 'ku/l': 1 }, ref: { low: null, high: 100 } }),
  B('pct', 'Plateletcrit (PCT)', 'Complete Blood Count', '%', ['plateletcrit( \\(pct\\))?', 'p\\.?c\\.?t\\.?'], { ref: { low: 0.108, high: 0.282 } }),
  B('psa', 'PSA (Total)', 'Other', 'ng/mL', ['(total )?p\\.?s\\.?a\\.?(,? total)?', 'prostate specific antigen'], { conv: { 'ng/ml': 1, 'ug/l': 1 }, ref: { low: null, high: 4.0 } }),
];

export const BY_KEY = Object.fromEntries(BIOMARKERS.map((b) => [b.key, b]));

/** Normalize a unit string so lookups ignore case, micro-sign variants and spacing. */
export function normUnit(u) {
  if (u == null) return '';
  return String(u)
    .toLowerCase()
    .replace(/[µμ]/g, 'u')
    .replace(/\s+/g, '')
    .replace(/mcg/g, 'ug')
    .replace(/microgram/g, 'ug')
    .replace(/(cu\.?mm|mm3|mm\^3|cmm|cumm)/g, 'ul')
    .replace(/(litre|liter|ltr)/g, 'l')
    .replace(/gms?\//g, 'g/')
    .replace(/\.$/, '');
}

function applyConv(conv, v) {
  return typeof conv === 'function' ? conv(v) : v * conv;
}

function scaleCount(kind, v) {
  if (v == null || !Number.isFinite(v)) return v;
  switch (kind) {
    case 'count3': // target 10^3/µL; raw /cumm values are in the thousands
      return v > 200 ? v / 1000 : v;
    case 'count6': // target 10^6/µL
      return v > 1000 ? v / 1e6 : v;
    case 'plt': // target 10^3/µL; "lakhs/cumm" values are < 10, raw counts are > 5000
      if (v > 5000) return v / 1000;
      if (v < 10) return v * 100;
      return v;
    case 'fraction': // hematocrit reported as 0.42 L/L
      return v <= 1 ? v * 100 : v;
    default:
      return v;
  }
}

/**
 * Convert a value (and optional reference bounds) reported in `unit` into the marker's canonical unit.
 * Returns { value, low, high, converted, unitKnown }.
 */
export function toCanonical(key, value, unit, low = null, high = null) {
  const b = BY_KEY[key];
  if (!b) return { value, low, high, converted: false, unitKnown: false };
  if (b.unit === 'ratio') return { value, low, high, converted: false, unitKnown: true };
  if (b.scale) {
    const f = (x) => (x == null ? x : scaleCount(b.scale, x));
    const v = f(value);
    return { value: v, low: f(low), high: f(high), converted: v !== value, unitKnown: true };
  }
  const nu = normUnit(unit);
  if (!nu || nu === normUnit(b.unit)) return { value, low, high, converted: false, unitKnown: true };
  const c = b.conv[nu];
  if (c === undefined) return { value, low, high, converted: false, unitKnown: false };
  const f = (x) => (x == null ? x : round(applyConv(c, x), 4));
  return { value: f(value), low: f(low), high: f(high), converted: c !== 1, unitKnown: true };
}

export function round(x, d = 2) {
  if (x == null || !Number.isFinite(x)) return x;
  const p = 10 ** d;
  return Math.round(x * p) / p;
}

/** Default reference range for a marker, sex-specific when available. */
export function defaultRange(key, sex) {
  const b = BY_KEY[key];
  if (!b || !b.ref) return { low: null, high: null };
  const r = b.ref.m || b.ref.f ? (sex === 'F' ? b.ref.f : b.ref.m) : b.ref;
  return { low: r?.low ?? null, high: r?.high ?? null };
}

/** Classify a canonical value against a range: low | normal | high | unknown, plus critical flag. */
export function classify(key, value, low, high) {
  if (value == null || !Number.isFinite(value)) return { status: 'unknown', critical: false };
  let status = 'unknown';
  if (low != null || high != null) {
    status = 'normal';
    if (low != null && value < low) status = 'low';
    if (high != null && value > high) status = 'high';
  }
  const c = BY_KEY[key]?.crit;
  const critical = Boolean(c && ((c.low != null && value < c.low) || (c.high != null && value > c.high)));
  return { status, critical };
}

export function fmtRange(low, high) {
  if (low != null && high != null) return `${low} – ${high}`;
  if (high != null) return `< ${high}`;
  if (low != null) return `> ${low}`;
  return '—';
}
