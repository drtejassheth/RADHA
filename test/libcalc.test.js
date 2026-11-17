// Calculator library: auto-scored points tables and report pre-fill.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { suggest, patientFacts, pickVersion, stripTags } from '../src/renderer/libcalc.js';

const LIB = JSON.parse(fs.readFileSync(new URL('../src/data/calculator-library.json', import.meta.url), 'utf8'));
const byId = Object.fromEntries(LIB.map((e) => [e.id, e]));
const scored = (id) => byId[id].versions.find((v) => v.score);
const total = (v, answers) => v.score.items.reduce((s, it) => {
  const label = stripTags(v.inputs[it.input].label);
  const opt = answers[label] ?? v.inputs[it.input].options[0];
  return s + it.points[v.inputs[it.input].options.indexOf(opt)];
}, 0);

test('every auto-scored calculator has a points value for every option', () => {
  let n = 0;
  for (const e of LIB) for (const v of e.versions) {
    if (!v.score) continue;
    n++;
    for (const it of v.score.items) {
      const inp = v.inputs[it.input];
      assert.equal(inp.type, 'choice', e.id);
      assert.equal(it.points.length, inp.options.length, `${e.id}: ${inp.label}`);
      assert.ok(it.points.every(Number.isFinite), e.id);
    }
    assert.equal(new Set(v.score.items.map((x) => x.input)).size, v.inputs.length, `${e.id}: every input scored once`);
    for (const r of v.score.bands?.rows || []) assert.equal(r.cells.length, v.score.bands.head.length, e.id);
  }
  assert.ok(n >= 100, `expected 100+ auto-scored calculators, got ${n}`);
});

test("Wells' DVT: source typo corrected, totals and bands", () => {
  const v = scored('wells-criteria-dvt');
  const calf = v.score.items.find((it) => /Calf swelling/.test(v.inputs[it.input].label));
  assert.deepEqual(calf.points, [0, 1]);
  assert.equal(total(v, {}), 0); // all "No"
  const all = Object.fromEntries(v.inputs.map((i) => [stripTags(i.label), 'Yes']));
  assert.equal(total(v, all), 7); // 9 criteria +1, alternative diagnosis -2
  assert.deepEqual(v.score.bands.rows.map((r) => r.range), [[null, 0], [1, 2], [3, null]]);
});

test('Marburg Heart Score: column-layout table (No | Yes) parsed per column', () => {
  const v = scored('marburg-heart-score');
  const palp = v.score.items.find((it) => /palpation/.test(v.inputs[it.input].label));
  const opts = v.inputs[palp.input].options;
  assert.equal(palp.points[opts.indexOf('No')], 1);
  assert.equal(palp.points[opts.indexOf('Yes')], 0);
});

test('pre-fill: sex, age brackets and Yes/No thresholds from the report', () => {
  const f = patientFacts({ patient: { age: 70, sex: 'F', heightCm: 160, weightKg: 70 },
    rows: [{ key: 'wbc', name: 'Total WBC Count', value: 13.5, unit: '10^3/µL' }, { key: 'creatinine', name: 'Creatinine', value: 1.1, unit: 'mg/dL' }] });
  assert.equal(suggest({ label: 'Sex', type: 'choice', options: ['Female', 'Male'] }, f).value, 0);
  assert.equal(suggest({ label: 'Age', type: 'choice', options: ['<65', '65-74', '≥75'] }, f).value, 1);
  assert.equal(suggest({ label: '1. Age?', type: 'choice', options: ['<60 Years', '60-69 Years', '70-79 Years', '≥80 Years'] }, f), null); // "1. Age?" is not a plain age label
  assert.equal(suggest({ label: 'Age, years', type: 'choice', options: ['≤51', '52-63', '64-72', '≥73'] }, f).value, 2);
  assert.equal(suggest({ label: 'Age ≥60 years', type: 'choice', options: ['No', 'Yes'] }, f).value, 1);
  assert.equal(suggest({ label: 'WBC >12.0 × 10⁹/µL', type: 'choice', options: ['No', 'Yes'] }, f).value, 1); // cell counts are scaled by magnitude, as on reports
  assert.equal(suggest({ label: 'WBC >12 × 10⁹/L', type: 'choice', options: ['No', 'Yes'] }, f).value, 1);
  assert.equal(suggest({ label: 'Creatinine >2.0 mg/dL', type: 'choice', options: ['No', 'Yes'] }, f).value, 0);
  assert.equal(suggest({ label: 'Creatinine >150 µmol/L', type: 'choice', options: ['No', 'Yes'] }, f).value, 0);
  assert.deepEqual(suggest({ label: 'Serum creatinine', type: 'number' }, f), { value: 1.1, unit: 'mg/dL', from: 'report' });
  assert.equal(suggest({ label: 'Weight', type: 'number' }, f).value, 70);
  assert.equal(suggest({ label: 'Age at onset', type: 'number' }, f), null);
  assert.equal(suggest({ label: 'Sex', type: 'choice', options: ['Female', 'Male'] }, patientFacts(null)), null);
});

test('every library entry opens on a version that exists', () => {
  for (const e of LIB) {
    const i = pickVersion(e);
    assert.ok(e.versions[i], e.id);
    if (e.versions.some((v) => v.score)) assert.ok(e.versions[i].score, `${e.id} opens on its auto-scored version`);
  }
});
