import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppLock, waitAfter, FREE_TRIES } from '../src/main/appLock.js';

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'radha-lock-')); }

test('no PIN: the app is open', async () => {
  const lock = await new AppLock(await tmp()).load();
  assert.equal(lock.enabled, false);
  assert.equal(lock.locked, false);
  assert.deepEqual(await lock.unlock('0000').then((r) => r.ok), true);
});

test('set, lock, unlock; the PIN itself is never written to disk', async () => {
  const dir = await tmp();
  const lock = await new AppLock(dir).load();
  await assert.rejects(lock.setPin('123'), /exactly 4 digits/);
  await assert.rejects(lock.setPin('12a4'), /exactly 4 digits/);
  await lock.setPin('4826');
  assert.equal(lock.locked, false, 'setting a PIN leaves the current session open');
  const raw = await fs.readFile(path.join(dir, 'app-lock.json'), 'utf8');
  assert.ok(!raw.includes('4826'));

  // A fresh start (as when RADHA opens) is locked.
  const again = await new AppLock(dir).load();
  assert.equal(again.locked, true);
  const wrong = await again.unlock('1111');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.triesLeft, FREE_TRIES - 1);
  assert.equal(again.locked, true);
  assert.equal((await again.unlock('4826')).ok, true);
  assert.equal(again.locked, false);
  assert.equal(again.status().triesLeft, FREE_TRIES, 'a right PIN resets the count');
  again.lock();
  assert.equal(again.locked, true);
});

test('wrong PINs: five free tries, then a growing wait that survives a restart', async () => {
  const dir = await tmp();
  let t = 1_000_000;
  const now = () => t;
  const lock = await new AppLock(dir, { now }).load();
  await lock.setPin('2580');
  lock.lock();
  for (let i = 1; i < FREE_TRIES; i++) assert.equal((await lock.unlock('0000')).waitSeconds, 0);
  const fifth = await lock.unlock('0000');
  assert.equal(fifth.waitSeconds, 30);
  // Even the right PIN is refused during the wait, and restarting does not clear it.
  const restarted = await new AppLock(dir, { now }).load();
  const blocked = await restarted.unlock('2580');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.waitSeconds > 0);
  t += 31_000;
  assert.equal((await restarted.unlock('0000')).waitSeconds, 60, 'the wait doubles');
  t += 61_000;
  assert.equal((await restarted.unlock('2580')).ok, true);
  assert.equal(waitAfter(4), 0);
  assert.equal(waitAfter(5), 30);
  assert.equal(waitAfter(20), 900, 'capped at 15 minutes');
});

test('change and turn off need the current PIN', async () => {
  const dir = await tmp();
  const lock = await new AppLock(dir).load();
  await lock.setPin('1357');
  await assert.rejects(lock.setPin('2468', '0000'), /Wrong PIN/);
  await lock.setPin('2468', '1357');
  await assert.rejects(lock.removePin('1357'), /Wrong PIN/);
  await lock.setAutoLock(15);
  assert.equal(lock.status().autoLockMinutes, 15);
  await assert.rejects(lock.setAutoLock(7), /Unknown/);
  lock.lock();
  await assert.rejects(lock.setPin('9999', '2468'), /locked/);
  await lock.unlock('2468');
  await lock.removePin('2468');
  assert.equal(lock.enabled, false);
  await assert.rejects(fs.access(path.join(dir, 'app-lock.json')));
});
