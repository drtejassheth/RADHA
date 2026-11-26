// Patient-profile details read from clinical documents (synthetic data only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProfileFacts, applyFacts, compareFact, derived } from '../src/shared/caseRecord.js';
import { DEMO_REPORTS } from '../src/renderer/demo.js';

const byKey = (facts) => Object.fromEntries(facts.map((f) => [f.key, f]));
const caseRecord = DEMO_REPORTS.find((d) => /case-record/.test(d.fileName)).text;

test('a blank case-record form gives no values', () => {
  const blank = [
    '1 | P a g e', 'Outpatient Diabetes Case Record', 'Date: _________________', 'Name:', 'Sex:      M/F', 'Occupation:',
    'Type of Diabetes:', 'Year of Diagnosis:', 'Associated Diseases: Date Detected:',
    'Smoking: Yes/No      Bidi/Cigarettes/Hukka', '                              /day since                    years',
    'Alcohol: Yes/No          Whisky/Wine/Beer', 'Retinopathy: Yes/No', 'Type:', 'CKD: Yes/No', 'Stage:', 'DKA: Yes/No         Date:',
    '2 | P a g e', 'Pulse Rate/minute', 'BP (mm Hg) Seating', '1. Flat Foot: (present/absent)', 'Height (cms)', 'Weight (cms)',
    'Mood (Normal/Anxiety/Depression/Bipolar', 'Jaundice (present/absent)', 'Temperature of foot: (normal/warm/cold)',
    'Nails (clubbing/infection/discoloration/N)', 'Liver: (palpable/non-palpable)', 'Tremors: present/absent',
  ].join('\n');
  assert.deepEqual(extractProfileFacts(blank), []);
});

test('lab reports give no profile values', () => {
  for (const d of DEMO_REPORTS.filter((x) => !/case-record/.test(x.fileName))) assert.deepEqual(extractProfileFacts(d.text), [], d.fileName);
});

test('filled case record: values, the line they were printed on, and the page', () => {
  const f = byKey(extractProfileFacts(caseRecord));
  assert.equal(f.diabetesType.value, 'prediabetes');
  assert.equal(f.diabetesYear.value, 2023);
  assert.equal(f.associatedDiseases.value, 'Hypertension (detected 2019)');
  assert.deepEqual([f.smokingStatus.value, f.smokingForm.value, f.smokingPerDay.value, f.smokingYears.value], ['yes', 'cigarettes', 8, 20]);
  assert.equal(f.alcoholMlWeek.value, 180);
  assert.equal(f.peripheralNeuropathy.value, 'yes');
  assert.equal(f.peripheralNeuropathyType.value, 'Sensory, both feet'); // "Type:" belongs to the line above
  assert.equal(f.retinopathyType, undefined); // blank "Type:" under Retinopathy
  assert.equal(f.allergies.value, 'None known');
  // Page 2 is laid out in two columns; each value cites only its own cell.
  assert.equal(f.bpSitting.value, '142/90');
  assert.equal(f.bpSitting.page, 2);
  assert.equal(f.bpSitting.printed, 'BP (mm Hg) Seating 142/90');
  assert.equal(f.corn.value, 'present');
  assert.equal(f.corn.printed, '4. Corn: present');
  assert.equal(f.heightCm.value, 170);
  assert.equal(f.weightKg.value, 81);
  assert.equal(f.mood.value, 'normal');
  assert.equal(f.liver.value, 'non-palpable');
  assert.equal(f.nails.value, 'Normal');
  assert.equal(f.occupation.page, 1);
});

test('other document styles: units and generic labels', () => {
  const f = byKey(extractProfileFacts('Page 1 of 2\nBP: 130/80 mmHg\nPulse: 76/min\nHeight: 5 ft 7 in\nWeight: 154 lbs\nWaist: 36 inches\nLiver Function Test\nSample Type: Serum\nSmoker: No'));
  assert.equal(f.bpSitting.value, '130/80');
  assert.equal(f.pulse.value, 76);
  assert.equal(f.heightCm.value, 170);
  assert.equal(f.weightKg.value, 69.9);
  assert.equal(f.waistCm.value, 91);
  assert.equal(f.smokingStatus.value, 'no');
  assert.equal(f.liver, undefined); // a heading, not "Liver: palpable"
});

test('applying values cites the source and updates blood pressure, smoking and conditions', () => {
  const facts = extractProfileFacts(caseRecord);
  const src = { kind: 'document', id: 'doc1', fileName: 'case-record.pdf', date: '2024-03-12' };
  const p = applyFacts({ name: 'Test', conditions: {}, record: {}, sources: {} }, facts, src);
  assert.equal(p.sbp, 142);
  assert.equal(p.dbp, 90);
  assert.equal(p.sources.sbp.fileName, 'case-record.pdf');
  assert.equal(p.sources.sbp.page, 2);
  assert.equal(p.sources.corn.printed, '4. Corn: present');
  assert.equal(p.smoking, 'current');
  assert.equal(p.conditions.diabetes, true);
  assert.equal(p.conditions.hypertension, true);
  assert.equal(p.record.footUlcer, 'absent');
  const d = derived(p);
  assert.equal(d.whr, 0.97);
  assert.equal(d.packYears, 8);
});

test('values typed by hand, or from a newer document, are not replaced by default', () => {
  const p = { record: { waistCm: 90 }, sources: { waistCm: { kind: 'manual', date: '2024-01-01' } }, conditions: {} };
  assert.equal(compareFact(p, { key: 'waistCm', value: 98 }, '2024-03-12'), 'manual');
  assert.equal(compareFact(p, { key: 'waistCm', value: 90 }, '2024-03-12'), 'same');
  const q = { record: { waistCm: 95 }, sources: { waistCm: { kind: 'document', date: '2025-01-01' } } };
  assert.equal(compareFact(q, { key: 'waistCm', value: 98 }, '2024-03-12'), 'older');
  assert.equal(compareFact(q, { key: 'waistCm', value: 98 }, '2025-06-01'), 'update');
  assert.equal(compareFact({ record: {} }, { key: 'hipCm', value: 101 }, '2024-03-12'), 'new');
});
