// App lock: a 4-digit PIN asked for when RADHA opens (and, if chosen, after a period away from the computer).
// The PIN is never stored: only a salted scrypt hash, in app-lock.json next to the database. That file is kept
// out of backups on purpose, so restoring a backup never changes or removes someone's PIN.
//
// This is a lock on the app, not encryption of the data: four digits are only 10,000 possibilities, so they
// could not protect a copied database file. What it does is keep the window closed to someone at the computer.
// The main process enforces it: while locked, every data channel refuses (see main.js), and wrong guesses are
// slowed down (5 free tries, then a wait that doubles from 30 seconds up to 15 minutes, kept across restarts).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PIN_LENGTH = 4;
export const PIN_RE = /^\d{4}$/;
export const FREE_TRIES = 5;
export const AUTO_LOCK_CHOICES = [0, 1, 5, 15, 30, 60]; // minutes away from the computer; 0 = only when RADHA opens
const KDF = { N: 1 << 15, r: 8, p: 1, keyLen: 32 };

/** Seconds to wait after `failed` wrong PINs in a row. */
export function waitAfter(failed) {
  if (failed < FREE_TRIES) return 0;
  return Math.min(30 * 2 ** (failed - FREE_TRIES), 15 * 60);
}

function hashPin(pin, salt, kdf = KDF) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), salt, kdf.keyLen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * 2 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export class AppLock {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.file = path.join(dir, 'app-lock.json');
    this.dir = dir;
    this.now = now;
    this.data = null;       // { version, kdf, salt, hash, autoLockMinutes, failed, blockedUntil, setAt }
    this.unlocked = false;
  }

  async load() {
    try {
      const d = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = d?.hash && d?.salt ? d : null;
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Could not read the app lock file:', err);
      this.data = null;
    }
    this.unlocked = !this.data;
    return this;
  }

  async save() {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  get enabled() { return Boolean(this.data); }
  get locked() { return this.enabled && !this.unlocked; }

  waitSeconds() {
    const until = this.data?.blockedUntil || 0;
    return Math.max(0, Math.ceil((until - this.now()) / 1000));
  }

  status() {
    return {
      enabled: this.enabled,
      locked: this.locked,
      autoLockMinutes: this.data?.autoLockMinutes || 0,
      waitSeconds: this.waitSeconds(),
      triesLeft: this.enabled ? Math.max(0, FREE_TRIES - (this.data.failed || 0)) : FREE_TRIES,
      file: this.file,
    };
  }

  /** Check a PIN, counting wrong ones. Returns { ok, waitSeconds?, triesLeft? }. */
  async check(pin) {
    if (!this.enabled) return { ok: true };
    const wait = this.waitSeconds();
    if (wait > 0) return { ok: false, waitSeconds: wait, triesLeft: 0 };
    const d = this.data;
    const good = PIN_RE.test(String(pin ?? '')) &&
      crypto.timingSafeEqual(await hashPin(pin, Buffer.from(d.salt, 'base64'), d.kdf), Buffer.from(d.hash, 'base64'));
    if (good) {
      if (d.failed || d.blockedUntil) { d.failed = 0; d.blockedUntil = 0; await this.save(); }
      return { ok: true };
    }
    d.failed = (d.failed || 0) + 1;
    const w = waitAfter(d.failed);
    d.blockedUntil = w ? this.now() + w * 1000 : 0;
    await this.save();
    return { ok: false, waitSeconds: w, triesLeft: Math.max(0, FREE_TRIES - d.failed) };
  }

  async unlock(pin) {
    const res = await this.check(pin);
    if (res.ok) this.unlocked = true;
    return { ...res, ...this.status() };
  }

  lock() {
    if (this.enabled) this.unlocked = false;
    return this.status();
  }

  /** Set a new PIN. Changing an existing PIN needs the current one. */
  async setPin(pin, currentPin) {
    if (!PIN_RE.test(String(pin ?? ''))) throw new Error(`The PIN must be exactly ${PIN_LENGTH} digits.`);
    if (this.enabled) {
      if (this.locked) throw new Error('RADHA is locked.');
      const res = await this.check(currentPin);
      if (!res.ok) throw new Error(wrongPinMessage(res));
    }
    const salt = crypto.randomBytes(16);
    const hash = await hashPin(pin, salt);
    this.data = {
      version: 1, kdf: { ...KDF }, salt: salt.toString('base64'), hash: hash.toString('base64'),
      autoLockMinutes: this.data?.autoLockMinutes || 0, failed: 0, blockedUntil: 0, setAt: new Date(this.now()).toISOString(),
    };
    await this.save();
    this.unlocked = true;
    return this.status();
  }

  /** Turn the lock off. Needs the current PIN. */
  async removePin(currentPin) {
    if (!this.enabled) return this.status();
    if (this.locked) throw new Error('RADHA is locked.');
    const res = await this.check(currentPin);
    if (!res.ok) throw new Error(wrongPinMessage(res));
    this.data = null;
    this.unlocked = true;
    await fs.rm(this.file, { force: true });
    return this.status();
  }

  async setAutoLock(minutes) {
    if (!this.enabled) throw new Error('Set a PIN first.');
    if (this.locked) throw new Error('RADHA is locked.');
    const m = Number(minutes);
    if (!AUTO_LOCK_CHOICES.includes(m)) throw new Error('Unknown auto-lock time.');
    this.data.autoLockMinutes = m;
    await this.save();
    return this.status();
  }
}

export function wrongPinMessage({ waitSeconds = 0, triesLeft }) {
  if (waitSeconds > 0) return `Wrong PIN. Too many tries: wait ${formatWait(waitSeconds)} before trying again.`;
  if (triesLeft != null && triesLeft <= 2) return `Wrong PIN. ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left before a wait.`;
  return 'Wrong PIN.';
}

export function formatWait(s) {
  return s >= 60 ? `${Math.ceil(s / 60)} min` : `${s} s`;
}
