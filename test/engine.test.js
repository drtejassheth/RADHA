import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractReport, parseDate, cleanText } from '../src/shared/extractor.js';
import { toCanonical } from '../src/shared/biomarkers.js';
import { runCalculators } from '../src/shared/calculators.js';
import { analyze } from '../src/shared/analysis.js';
import { chunkText } from '../src/main/sarvam.js';

const sample = fs.readFileSync(new URL('./fixtures/sample-2024.txt', import.meta.url), 'utf8');
const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.key, r]));

test('extracts patient metadata', () => {
  const { patient } = extractReport(sample);
  assert.equal(patient.name, 'Ramesh Kumar Patel');
  assert.equal(patient.age, 52);
  assert.equal(patient.sex, 'M');
  assert.equal(patient.date, '2024-03-12');
  assert.equal(patient.patientId, 'SD-778812');
});

test('extracts every test in the plain-text fixture', () => {
  const { rows } = extractReport(sample);
  assert.equal(rows.length, 55);
  const m = byKey(rows);
  assert.equal(m.hemoglobin.value, 12.1);
  assert.equal(m.hemoglobin.status, 'low');
  assert.equal(m.triglycerides.high, 150);
  assert.equal(m.hdl.low, 40);
  assert.equal(m.anc.value, 6.05);
  assert.equal(m.neutrophils_pct.value, 68);
});

test('normalizes count magnitudes and units', () => {
  const m = byKey(extractReport(sample).rows);
  assert.equal(m.wbc.value, 8.9); // 8900 /cumm -> 10^3/µL
  assert.equal(m.platelets.value, 245); // 2.45 lakhs -> 10^3/µL
  assert.equal(m.t3_total.value, 110); // 1.1 ng/mL -> ng/dL
  assert.ok(Math.abs(toCanonical('glucose_fasting', 5.5, 'mmol/L').value - 99.09) < 0.01);
  assert.ok(Math.abs(toCanonical('creatinine', 88.4, 'µmol/L').value - 1) < 1e-6);
  assert.ok(Math.abs(toCanonical('hba1c', 48, 'mmol/mol').value - 6.54) < 0.01);
  assert.equal(toCanonical('vitamin_d', 50, 'furlongs').unitKnown, false);
});

test('parses Markdown tables (Docling / Sarvam output)', () => {
  const md = '| Test | Result | Unit | Range |\n|---|---|---|---|\n| Haemoglobin | 13.2 | g/dL | 13 - 17 |\n| Platelet Count | 210000 | /cumm | 150000 - 410000 |\n| Total Cholesterol | 5.2 | mmol/L | < 5.17 |';
  const m = byKey(extractReport(md).rows);
  assert.equal(m.hemoglobin.value, 13.2);
  assert.equal(m.platelets.value, 210);
  assert.equal(m.platelets.low, 150);
  assert.equal(m.total_cholesterol.status, 'high');
});

test('keeps "< x" and "> y" ranges that look like HTML', () => {
  assert.match(cleanText('LDL  152  mg/dL  < 100\nHDL  38  mg/dL  > 40'), /< 100\nHDL/);
});

test('parses report dates', () => {
  assert.equal(parseDate('12/03/2024'), '2024-03-12');
  assert.equal(parseDate('18-Feb-2023'), '2023-02-18');
  assert.equal(parseDate('2022-11-05'), '2022-11-05');
});

test('calculators match published formulas', () => {
  const rows = [
    { key: 'creatinine', value: 1.0 }, { key: 'ast', value: 30 }, { key: 'alt', value: 30 },
    { key: 'platelets', value: 250 }, { key: 'hba1c', value: 7.0 },
    { key: 'glucose_fasting', value: 100 }, { key: 'insulin_fasting', value: 10 },
  ];
  const out = Object.fromEntries(runCalculators(rows, { age: 50, sex: 'M' }).map((c) => [c.id, c]));
  assert.equal(out.egfr_ckdepi2021.value, 92);
  assert.equal(out.eag.value, 154);
  assert.equal(out.homa_ir.value, 2.47);
  assert.equal(out.fib4.value, 1.1);
  assert.equal(out.anion_gap.ready, false);
  assert.ok(out.anion_gap.missing.includes('sodium'));
});

test('analysis flags expected patterns', () => {
  const { rows, patient } = extractReport(sample);
  const calc = runCalculators(rows, patient).filter((c) => c.ready);
  const ids = analyze(rows, patient, calc).observations.map((o) => o.id);
  for (const id of ['anemia', 'iron', 'glycemic', 'lipids', 'kidney', 'liver', 'thyroid', 'vitd', 'b12']) assert.ok(ids.includes(id), id);
});

test('translation chunks stay under the API limit', () => {
  const long = 'This is a sentence about your results. '.repeat(200);
  const chunks = chunkText(long, 1900);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 1900));
});

const calcById = (rows, patient, inputs) => Object.fromEntries(runCalculators(rows, patient, inputs).map((c) => [c.id, c]));
const R = (o) => Object.entries(o).map(([key, value]) => ({ key, value }));

test('ASCVD pooled cohort equations reproduce the 2013 guideline examples', () => {
  const rows = R({ total_cholesterol: 213, hdl: 50 });
  const x = (race) => ({ ascvd_pce: { sbp: 120, bp_treated: 'no', smoker: 'no', race } });
  // Guideline worked examples (Goff 2014, table A): 2.1 / 5.3 / 3.0 / 6.1 %. The guideline rounds each
  // intermediate term; exact arithmetic can differ by 0.1.
  const near = (got, want) => assert.ok(Math.abs(got - want) <= 0.11, `${got} vs ${want}`);
  near(calcById(rows, { age: 55, sex: 'F', diabetes: false }, x('other')).ascvd_pce.value, 2.1);
  near(calcById(rows, { age: 55, sex: 'M', diabetes: false }, x('other')).ascvd_pce.value, 5.3);
  near(calcById(rows, { age: 55, sex: 'F', diabetes: false }, x('aa')).ascvd_pce.value, 3.0);
  near(calcById(rows, { age: 55, sex: 'M', diabetes: false }, x('aa')).ascvd_pce.value, 6.1);
});

test('MELD family, ALBI and Child-Pugh', () => {
  const rows = R({ creatinine: 1.0, bilirubin_total: 1.0, inr: 1.0, sodium: 137, albumin: 3.5 });
  const c = calcById(rows, { age: 50, sex: 'M' }, { child_pugh: { ascites: '1', enceph: '1' } });
  assert.equal(c.meld.value, 6);
  assert.equal(c.meld_na.value, 6);
  assert.equal(c.meld3.value, 6);
  assert.equal(c.child_pugh.value, 6); // bili 1 + alb 2 (3.5) + INR 1 + 1 + 1
  const sick = calcById(R({ creatinine: 2.0, bilirubin_total: 4.0, inr: 2.0, sodium: 130, albumin: 2.5 }), { age: 50, sex: 'M' }, {});
  // 10 × (0.957 ln2 + 0.378 ln4 + 1.12 ln2 + 0.643) = 26.07
  assert.equal(sick.meld.value, 26);
  const a = calcById(R({ albumin: 4.0, bilirubin_total: 1.0 }), { age: 50, sex: 'M' }, {});
  assert.equal(a.albi.value, -2.59);
  assert.equal(a.albi.band, 'Grade 2');
});

test('typed-in inputs gate calculators that need them', () => {
  const c = calcById(R({ creatinine: 1.0, bilirubin_total: 1.0 }), { age: 50, sex: 'M' }, {});
  assert.equal(c.meld.ready, false);
  assert.equal(c.meld.needsInput, true);
  assert.deepEqual(c.meld.missingExtras, ['inr']);
  assert.equal(calcById(R({ creatinine: 1.0, bilirubin_total: 1.0 }), { age: 50, sex: 'M' }, { meld: { inr: 1.0 } }).meld.value, 6);
});

test('kidney equations', () => {
  const c = calcById(R({ creatinine: 1.0, cystatin_c: 1.0, uacr: 10 }), { age: 50, sex: 'M', weightKg: 70, heightCm: 170 }, {});
  assert.equal(c.egfr_ckdepi2009.value, 87);
  assert.equal(c.egfr_mdrd.value, 79);
  assert.equal(c.cockcroft_gault.value, 88);
  assert.equal(c.egfr_cys2012.value, 81); // 133 × 1.25^-1.328 × 0.996^50
  assert.equal(c.kfre4.band.startsWith('Not applicable'), true);
});

test('thalassemia indices only apply to microcytic counts', () => {
  const micro = calcById(R({ mcv: 65, rbc: 6.0, hemoglobin: 11, rdw: 14, mch: 20, hematocrit: 36 }), { age: 30, sex: 'M' }, {});
  assert.equal(micro.mentzer.band.includes('thalassemia'), true);
  assert.ok(Math.abs(micro.england_fraser.value - 0.6) < 1e-9);
  const normo = calcById(R({ mcv: 90, rbc: 5.0, hemoglobin: 14, rdw: 13 }), { age: 30, sex: 'M' }, {});
  assert.equal(normo.england_fraser.band.startsWith('Not applicable'), true);
});

test('KFRE gives a 5-year risk for CKD stage 3+', () => {
  const c = calcById(R({ creatinine: 2.0, uacr: 300 }), { age: 60, sex: 'M' }, {});
  assert.equal(c.kfre4.ready, true);
  assert.ok(c.kfre4.value > 5 && c.kfre4.value < 30, String(c.kfre4.value));
});

test('reads header details and never uses the date of birth as the report date', () => {
  const t = 'Last Name:   Mehta   First Name:   Dr Arjun\nIdentification:   1234567   Sex:   male\nDate of Birth:   08/08/1989   Age:   28 Years\nHeight:   169.2 cm   Weight:   83.1 kg\nFEV 1  3.07\nDate : 16/09/2017 8:56';
  const p = extractReport(t).patient;
  assert.equal(p.name, 'Arjun Mehta');
  assert.equal(p.date, '2017-09-16');
  assert.equal(p.dob, '1989-08-08');
  assert.equal(p.age, 28);
  assert.equal(p.sex, 'M');
  assert.equal(p.heightCm, 169.2);
  assert.equal(p.weightKg, 83.1);
  assert.equal(p.patientId, '1234567');
});

// Regressions found by the synthetic stress test (RADHA-Paper/eval/synthetic_eval.mjs).
test('recognises "Glycated Haemoglobin" as HbA1c', () => {
  for (const name of ['Glycated Haemoglobin', 'Glycated Hemoglobin', 'Glycosylated Hemoglobin (HbA1c)']) {
    const m = byKey(extractReport(`${name}   6.1   %   4 - 5.6`).rows);
    assert.equal(m.hba1c?.value, 6.1, name);
  }
});

test('small absolute counts printed per cumm are scaled by their unit, not their size', () => {
  const md = '| Test | Result | Unit | Range |\n|---|---|---|---|\n| Absolute Basophil Count | 50 | /cumm | 0 - 100 |\n| Absolute Eosinophil Count | 180 | cells/cumm | 20 - 500 |\n| Absolute Monocyte Count | 450 | /cumm | 200 - 1000 |';
  const m = byKey(extractReport(md).rows);
  assert.equal(m.abc.value, 0.05);
  assert.equal(m.aec.value, 0.18);
  assert.equal(m.amc.value, 0.45);
  assert.equal(m.amc.low, 0.2);
  assert.equal(m.amc.high, 1);
  assert.equal(m.amc.status, 'normal');
  // Unit-less and mislabelled values still fall back to the magnitude rule.
  assert.equal(toCanonical('wbc', 8900, '').value, 8.9);
  assert.equal(toCanonical('wbc', 8.9, '/cumm').value, 8.9);
  assert.equal(toCanonical('platelets', 2.45, 'lakhs/cumm').value, 245);
});

test('reads the name after a bare "Patient :" label', () => {
  const { patient } = extractReport('Patient : Ms. Priya Nair\nAge / Gender : 45 Years / Female\nLab No : LB-104233\n');
  assert.equal(patient.name, 'Priya Nair');
  assert.equal(patient.patientId, 'LB-104233');
});
