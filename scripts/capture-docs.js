// Captures the screenshots used in docs/ by driving the real app with the built-in demo patient
// (synthetic data — no real patient information). Run with:
//   RADHA_SMOKE=docs/_capture RADHA_SCRIPT=scripts/capture-docs.js npx electron .
// then build the GIF and copy images with: python3 scripts/build_docs_media.py docs/_capture
import { dialog, shell, nativeTheme } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(win, outDir) {
  outDir = path.resolve(outDir);
  const shots = path.join(outDir, 'screens');
  await fs.mkdir(shots, { recursive: true });
  nativeTheme.themeSource = 'light';
  win.webContents.setBackgroundThrottling(false);
  win.show();
  win.focus();
  win.setContentSize(1440, 900);
  win.center();

  dialog.showSaveDialog = async (_w, opts) => ({ canceled: false, filePath: path.join(outDir, /\.pdf$/.test(opts?.defaultPath || '') ? 'RADHA-sample-summary.pdf' : path.basename(opts.defaultPath)) });
  shell.showItemInFolder = () => {};

  const js = (code) => win.webContents.executeJavaScript(code);
  const click = (text) => js(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes(${JSON.stringify(text)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  const nav = (view) => js(`document.querySelector('[data-view="${view}"]').click()`);
  const scrollTo = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.scrollIntoView({ block: 'start' }); const v = document.querySelector('#view'); if (el && v) v.scrollTop -= 12; return !!el; })()`);
  const setInput = (labelStart, value) => js(`(() => { const l = [...document.querySelectorAll('.patient-form label')].find(x => x.textContent.trim().startsWith(${JSON.stringify(labelStart)})); const i = l?.querySelector('input, textarea'); if (!i) return false; i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); return true; })()`);
  const log = [];
  const step = (s) => { log.push(s); console.log('[docs]', s); };
  const shot = async (name, wait = 900) => {
    await sleep(wait);
    // Make sure the latest frame is painted before capturing (capturePage can otherwise return the previous one).
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    win.webContents.invalidate();
    await sleep(400);
    await win.webContents.capturePage();
    const img = await win.webContents.capturePage();
    await fs.writeFile(path.join(shots, `${name}.png`), img.resize({ width: 1600, quality: 'best' }).toPNG());
    step(`captured ${name}`);
  };

  try {
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    await sleep(2000);
    await nav('ingest');
    await shot('01-ingest');

    await click('Load demo reports');
    await shot('02-verify');
    await click('Confirm & verify next'); await sleep(900);
    await click('Confirm & analyse'); await sleep(1200);

    // Fill the demo patient's profile so BMI, ASCVD and the profile screen have content.
    await nav('patients'); await sleep(900);
    await setInput('Height', '170'); await setInput('Weight', '82');
    await setInput('Systolic', '132'); await setInput('Diastolic', '84');
    await setInput('Date of birth', '1972-01-15');
    await js(`[...document.querySelectorAll('.patient-form label')].find(l => l.textContent.includes('Taking blood-pressure'))?.querySelector('input')?.click()`);
    await js(`(() => { const s = [...document.querySelectorAll('.patient-form label')].find(l => l.textContent.trim().startsWith('Smoking'))?.querySelector('select'); s.value = 'never'; s.dispatchEvent(new Event('change')); })()`);
    await setInput('Current medicines', 'Amlodipine 5 mg once daily');
    await setInput('Family history', 'Father — type 2 diabetes');
    await click('Save profile'); await sleep(1200);
    await shot('14-patients');
    await scrollTo('.patient-form ~ .card');
    await shot('14b-patient-reports');

    await click('Open latest report'); await sleep(1200);
    await shot('03-dashboard');

    await nav('labs'); await shot('04-labs');
    await click('Out of range'); await shot('04b-labs-abnormal');
    await click('All (');

    await nav('calculators'); await sleep(1200); await shot('05-calculators');
    await click('Needs your input'); await shot('06-calculators-input');
    await click('Results'); await sleep(500);
    await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Calculator details'))?.click()`);
    await shot('07-calculator-details', 1500);
    await js(`document.querySelector('.modal-close')?.click()`);

    await nav('library'); await sleep(1800);
    await js(`(() => { const i = document.querySelector('#view input[type=text]'); i.value = 'fib-4'; i.dispatchEvent(new Event('input')); document.querySelector('.lib-item')?.click(); })()`);
    await shot('08-library', 1500);

    await nav('analysis'); await shot('09-analysis');
    await scrollTo('.q-group'); await shot('10-questions');
    await click('Generate');
    for (let i = 0; i < 180 && !(await js(`!!document.querySelector('.ai-text')`)); i++) await sleep(500);
    if (await js(`!!document.querySelector('.ai-text')`)) { await scrollTo('.ai-text'); await js(`document.querySelector('#view').scrollTop -= 90`); await shot('11-ai-summary'); }
    else step('AI summary not generated (network?) — skipped');

    await nav('trends'); await shot('12-trends', 1300);

    // Translate on the analysis screen and wait until the findings really are in Gujarati.
    await nav('analysis'); await sleep(500);
    await js(`(() => { const l = document.querySelector('#langSelect'); l.value = 'gu-IN'; l.dispatchEvent(new Event('change')); })()`);
    let translated = false;
    for (let i = 0; i < 240 && !translated; i++) { await sleep(500); translated = await js(`/[\u0A80-\u0AFF]/.test(document.querySelector('.obs h3')?.textContent || '')`); }
    if (!translated) throw new Error('Gujarati translation did not arrive (translation service busy?)');
    await js(`document.querySelector('#view').scrollTop = 0`);
    await shot('13-translated-gujarati', 1300);

    await nav('dashboard'); await sleep(500);
    await js(`document.querySelector('#exportBtn').click()`);
    for (let i = 0; i < 40; i++) { await sleep(300); try { if ((await fs.stat(path.join(outDir, 'RADHA-sample-summary.pdf'))).size) break; } catch { /* not yet */ } }
    step('exported Gujarati PDF');
    await fs.rename(path.join(outDir, 'RADHA-sample-summary.pdf'), path.join(outDir, 'RADHA-sample-summary-gujarati.pdf')).catch(() => {});
    await js(`(() => { const l = document.querySelector('#langSelect'); l.value = 'en-IN'; l.dispatchEvent(new Event('change')); })()`);
    await sleep(800);
    await js(`document.querySelector('#exportBtn').click()`);
    for (let i = 0; i < 40; i++) { await sleep(300); try { if ((await fs.stat(path.join(outDir, 'RADHA-sample-summary.pdf'))).size) break; } catch { /* not yet */ } }
    step('exported English PDF');

    await nav('settings'); await sleep(900);
    await scrollTo('.provider'); await shot('15-settings-ai');
    await js(`[...document.querySelectorAll('.card h2')].find(h => h.textContent.startsWith('Translation'))?.scrollIntoView({ block: 'start' })`);
    await shot('16-settings-translation');
  } catch (err) {
    step('FAILED: ' + err.stack);
  }
  await fs.writeFile(path.join(outDir, 'capture-log.txt'), log.join('\n') + '\n');
}
