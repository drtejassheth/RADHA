// .radha share files: encryption round trip and code handling (docs/share-format.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newCode, normaliseCode, formatCode, isValidCode, encryptShare, decryptShare, checkEnvelope } from '../src/main/shareCrypto.js';

const payload = { format: 'radha-share-payload', version: 1, patient: { name: 'Synthetic Patient', record: { waistCm: 98 } }, reports: [{ id: 'r1', rows: [{ key: 'hba1c', rawValue: 6.4 }] }] };

test('share codes: 12 Crockford base-32 characters, forgiving when typed', () => {
  const c = newCode();
  assert.equal(c.length, 12);
  assert.ok(isValidCode(c));
  assert.match(formatCode(c), /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(normaliseCode(' k7q2-9mxr 4tbo '), 'K7Q29MXR4TB0');
  assert.equal(normaliseCode('ILo'), '110');
  assert.ok(!isValidCode('K7Q2-9MXR'));
});

test('encrypt then decrypt gives the payload back; the envelope holds nothing identifying', async () => {
  const code = newCode();
  const env = await encryptShare(payload, { code, createdBy: { app: 'RADHA', version: 't', role: 'patient' }, contents: { reports: 1, documents: 0 } });
  const text = JSON.stringify(env);
  assert.ok(!text.includes('Synthetic'));
  assert.equal(env.format, 'radha-share');
  assert.equal(env.kdf.name, 'scrypt');
  assert.equal(env.cipher.name, 'AES-256-GCM');
  const back = await decryptShare(JSON.parse(text), formatCode(code).toLowerCase());
  assert.deepEqual(back, payload);
});

test('a wrong code or a changed byte is refused', async () => {
  const code = newCode();
  const env = await encryptShare(payload, { code, createdBy: { app: 'RADHA', version: 't', role: 'patient' } });
  const other = code[0] === 'A' ? 'B' + code.slice(1) : 'A' + code.slice(1);
  await assert.rejects(decryptShare(env, other), /Wrong code/);
  const buf = Buffer.from(env.ciphertext, 'base64'); buf[5] ^= 1;
  await assert.rejects(decryptShare({ ...env, ciphertext: buf.toString('base64') }, code), /Wrong code/);
  assert.throws(() => checkEnvelope({ format: 'radha-share', version: 2 }), /version 2/);
  assert.throws(() => checkEnvelope({ hello: 1 }), /not a RADHA share/);
});
