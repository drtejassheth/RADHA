// App-lock walkthrough in the real app: set a PIN in Settings, lock, check the main process refuses data while
// locked, wrong PINs and the wait, unlock, change the PIN, turn it off. Run with:
//   RADHA_SMOKE=/path/to/outdir RADHA_SCRIPT=test/lock-smoke.js npx electron .
import { shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(win, outDir) {
  outDir = path.resolve(outDir === '1' ? 'smoke-out' : outDir);
  await fs.mkdir(outDir, { recursive: true });
  shell.showItemInFolder = () => {};
  const errors = [];
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e.params?.level;
    if (level === 'error' || level === 3) errors.push(e.message ?? e.params?.message);
  });
  const js = (code) => win.webContents.executeJavaScript(code);
  const click = (text, scope = 'document') => js(`(() => { const b = [...${scope}.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  const shot = async (name) => { await sleep(500); await fs.writeFile(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  const loaded = () => new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  const fill = (label, value) => js(`(() => { const i = document.querySelector('.modal input[aria-label=${JSON.stringify(label)}]'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); return true; })()`);
  const typePin = async (pin) => { for (const d of pin) { await js(`[...document.querySelectorAll('.pin-key')].find(b => b.textContent === ${JSON.stringify(d)}).click()`); await sleep(60); } await sleep(700); };
  const lockMsg = () => js(`document.querySelector('.lock-msg')?.textContent || ''`);
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`[lock] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

  try {
    await loaded(); await sleep(1500);
    check('no PIN: no lock screen, Lock button hidden', !(await js(`!!document.querySelector('.lock-screen')`)) && (await js(`document.querySelector('#lockBtn').hidden`)));

    await js(`document.querySelector('[data-view="settings"]').click()`); await sleep(800);
    await click('Set a PIN'); await sleep(400);
    await fill('New PIN', '4826'); await fill('New PIN again', '4821');
    await click('Turn on PIN', `document.querySelector('.modal')`); await sleep(500);
    check('mismatched PINs refused', (await js(`document.querySelector('.modal [role=alert]').textContent`)).includes('don’t match'));
    await fill('New PIN again', '4826');
    await shot('lock-01-set-pin');
    await click('Turn on PIN', `document.querySelector('.modal')`); await sleep(1200);
    check('PIN set: Lock button shown, settings card says On', !(await js(`document.querySelector('#lockBtn').hidden`)) && (await js(`document.body.innerText.includes('RADHA asks for your 4-digit PIN')`)));
    await js(`[...document.querySelectorAll('.card')].find(c => c.textContent.includes('App lock'))?.scrollIntoView()`);
    await shot('lock-02-settings-on');

    await js(`document.querySelector('#lockBtn').click()`); await sleep(1500); await loaded(); await sleep(1500);
    check('Lock: lock screen shown, app hidden', await js(`!!document.querySelector('.lock-screen') && getComputedStyle(document.querySelector('main')).visibility === 'hidden'`));
    const refused = await js(`Promise.all([window.radha.listReports(), window.radha.listPatients(), window.radha.getSettings(), window.radha.exportBackup()]).then(r => r.map(x => x.ok ? 'OPEN' : x.error))`);
    check('while locked the main process refuses data', refused.every((e) => /locked/i.test(e)), refused[0]);
    await shot('lock-03-locked');

    for (let i = 1; i <= 4; i++) await typePin('1111');
    check('4 wrong PINs: warning with tries left', (await lockMsg()).includes('1 try left'), await lockMsg());
    await typePin('1111');
    check('5th wrong PIN: wait starts', (await lockMsg()).includes('Try again in'), await lockMsg());
    await shot('lock-04-wait');
    await typePin('4826');
    check('right PIN is ignored during the wait', await js(`!!document.querySelector('.lock-screen')`));
    await sleep(31000);
    await typePin('4826');
    check('after the wait the right PIN unlocks', !(await js(`!!document.querySelector('.lock-screen')`)) && (await js(`window.radha.listReports().then(r => r.ok)`)));
    await shot('lock-05-unlocked');

    // Keyboard entry and the shortcut.
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', metaKey: true, shiftKey: true, ctrlKey: true }))`); await sleep(1500); await loaded(); await sleep(1500);
    check('⌘⇧L locks', await js(`!!document.querySelector('.lock-screen')`));
    for (const d of '4826') await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(d)} }))`);
    await sleep(1200);
    check('typing the PIN on the keyboard unlocks', !(await js(`!!document.querySelector('.lock-screen')`)));

    await js(`document.querySelector('[data-view="settings"]').click()`); await sleep(800);
    await click('Change PIN'); await sleep(400);
    await fill('Current PIN', '0000'); await fill('New PIN', '1357'); await fill('New PIN again', '1357');
    await click('Change PIN', `document.querySelector('.modal')`); await sleep(1200);
    check('change refused with a wrong current PIN', (await js(`document.querySelector('.modal [role=alert]')?.textContent || ''`)).includes('Wrong PIN'));
    await fill('Current PIN', '4826');
    await click('Change PIN', `document.querySelector('.modal')`); await sleep(1200);
    check('PIN changed', !(await js(`!!document.querySelector('.modal')`)));
    await js(`(() => { const s = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('App lock')).querySelector('select'); s.value = '5'; s.dispatchEvent(new Event('change')); })()`); await sleep(600);
    check('auto-lock time saved', (await js(`window.radha.lockStatus().then(r => r.data.autoLockMinutes)`)) === 5);

    await click('Turn off'); await sleep(400);
    await fill('Current PIN', '1357');
    await click('Turn off', `document.querySelector('.modal')`); await sleep(1200);
    check('PIN turned off: Lock button hidden', await js(`document.querySelector('#lockBtn').hidden`));
    const st = await js(`window.radha.lockStatus().then(r => r.data)`);
    check('lock file removed', !(await fs.access(st.file).then(() => true, () => false)));
  } catch (err) {
    check('walkthrough ran', false, err.stack);
  }
  check('no console errors', errors.length === 0, errors.join(' | '));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`[lock] ${results.length - failed}/${results.length} passed`);
  await fs.writeFile(path.join(outDir, 'lock-results.json'), JSON.stringify(results, null, 2));
}
