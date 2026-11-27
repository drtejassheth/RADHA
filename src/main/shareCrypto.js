// Encryption for .radha share files (see docs/share-format.md).
// scrypt (N=2^15, r=8, p=1) derives a 256-bit key from a 12-character share code; AES-256-GCM encrypts the
// gzipped JSON payload. Plain Node: no Electron, so it can be unit-tested.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const scrypt = promisify(crypto.scrypt);
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const FORMAT = 'radha-share';
export const VERSION = 1;
const AAD = 'radha-share/1';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base 32
const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 };

/** A new random 12-character share code (60 bits). */
export function newCode() {
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET[crypto.randomInt(32)];
  return s;
}

/** What the user typed → the 12 characters used as the password ("k7q2 9mxr-4tbw" → "K7Q29MXR4TBW"). */
export function normaliseCode(input) {
  return String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export const formatCode = (code) => normaliseCode(code).replace(/(.{4})(?=.)/g, '$1-');

export function isValidCode(input) {
  const c = normaliseCode(input);
  return c.length === 12 && [...c].every((ch) => ALPHABET.includes(ch));
}

async function deriveKey(code, salt, kdf = KDF) {
  if (kdf.name !== 'scrypt') throw new Error(`Unsupported key derivation: ${kdf.name}`);
  return scrypt(normaliseCode(code), salt, kdf.dkLen || 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * 2 });
}

/** Encrypt a payload object into a share envelope (a plain object, ready for JSON.stringify). */
export async function encryptShare(payload, { code, createdBy, contents = {}, shareId = crypto.randomUUID() }) {
  if (!isValidCode(code)) throw new Error('Invalid share code.');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(code, salt);
  const plain = await gzip(Buffer.from(JSON.stringify(payload), 'utf8'));
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(AAD, 'ascii'));
  const data = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return {
    format: FORMAT,
    version: VERSION,
    shareId,
    createdAt: new Date().toISOString(),
    createdBy,
    contents,
    kdf: { ...KDF, salt: salt.toString('base64') },
    cipher: { name: 'AES-256-GCM', iv: iv.toString('base64'), tagLength: 16, aad: AAD },
    compression: 'gzip',
    ciphertext: data.toString('base64'),
  };
}

/** Check that a parsed file is a share envelope this version can read. Throws a readable error if not. */
export function checkEnvelope(env) {
  if (!env || env.format !== FORMAT) throw new Error('This is not a RADHA share file.');
  if (env.version !== VERSION) throw new Error(`This share file uses format version ${env.version}; this app reads version ${VERSION}. Please update.`);
  if (env.cipher?.name !== 'AES-256-GCM' || !env.ciphertext || !env.kdf?.salt || !env.cipher?.iv) throw new Error('The share file is incomplete or damaged.');
  return env;
}

/** Decrypt an envelope with the share code → payload object. */
export async function decryptShare(env, code) {
  checkEnvelope(env);
  if (!isValidCode(code)) throw new Error('A share code has 12 letters and digits, for example K7Q2-9MXR-4TBW.');
  const key = await deriveKey(code, Buffer.from(env.kdf.salt, 'base64'), env.kdf);
  const data = Buffer.from(env.ciphertext, 'base64');
  const tagLen = env.cipher.tagLength || 16;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.cipher.iv, 'base64'));
  decipher.setAAD(Buffer.from(env.cipher.aad || AAD, 'ascii'));
  decipher.setAuthTag(data.subarray(data.length - tagLen));
  let plain;
  try {
    plain = Buffer.concat([decipher.update(data.subarray(0, data.length - tagLen)), decipher.final()]);
  } catch {
    throw new Error('Wrong code, or the file is damaged.');
  }
  if (env.compression === 'gzip') plain = await gunzip(plain);
  const payload = JSON.parse(plain.toString('utf8'));
  if (payload?.format !== 'radha-share-payload') throw new Error('The share file contents are not recognised.');
  return payload;
}
