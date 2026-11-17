// Engine installer metadata: estimates and per-platform lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_INFO, estimate, engineList, managedPython } from '../src/main/engines.js';

test('estimate counts shared PyTorch once', () => {
  const one = estimate(['easyocr']).diskMB;
  const two = estimate(['easyocr', 'docling']).diskMB;
  assert.equal(one, ENGINE_INFO.easyocr.disk);
  assert.ok(two < ENGINE_INFO.easyocr.disk + ENGINE_INFO.docling.disk, 'PyTorch not double-counted');
});

test('estimate skips installed engines and shared PyTorch already present', () => {
  assert.equal(estimate(['pdfplumber'], { pdfplumber: true }).diskMB, 0);
  const withTorch = estimate(['docling'], { easyocr: true }).diskMB;
  assert.ok(withTorch < ENGINE_INFO.docling.disk);
});

test('engine list respects platforms', () => {
  const ids = engineList().map((e) => e.id);
  assert.ok(ids.includes('pdfplumber') && ids.includes('marker'));
  assert.equal(ids.includes('applevision'), process.platform === 'darwin');
  for (const e of engineList()) assert.ok(e.diskMB > 0 && e.ramMB > 0, `${e.id} has size and memory figures`);
});

test('managed Python lives inside the engines folder', () => {
  assert.match(managedPython('/tmp/x'), /[\\/]tmp[\\/]x[\\/]engines[\\/]venv[\\/](bin[\\/]python|Scripts[\\/]python\.exe)$/);
});
