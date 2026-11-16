// Screenshots of the local-engine installer and tuning dialog (used by docs/USER-GUIDE.md).
//   RADHA_SMOKE=docs/_capture RADHA_SCRIPT=scripts/capture-engines.js RADHA_ENGINES_HOME=~/Library/Application\ Support/RADHA npx electron .
// RADHA_CAPTURE_EMPTY=1 shows the screen as a new user sees it (no engines installed).
import { nativeTheme, dialog } from 'electron';
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
  win.setContentSize(1440, 900);
  const js = (code) => win.webContents.executeJavaScript(code);
  const log = [];
  const step = (s) => { log.push(s); console.log('[engines]', s); };
  const shot = async (name, wait = 900) => {
    await sleep(wait);
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    win.webContents.invalidate();
    await sleep(300);
    await win.webContents.capturePage();
    const img = await win.webContents.capturePage();
    await fs.writeFile(path.join(shots, `${name}.png`), img.resize({ width: 1600, quality: 'best' }).toPNG());
    step(`captured ${name}`);
  };
  try {
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    for (let i = 0; i < 60 && !(await js('!!document.querySelector(".engine .s") && !/Checking/.test(document.querySelector("#view").textContent)')); i++) await sleep(500);
    await sleep(800);
    step(await js(`[...document.querySelectorAll('.engine')].map(e => e.querySelector('.t').textContent + ' | ' + e.querySelector('.s').textContent).join('\\n')`));
    await shot(process.env.RADHA_CAPTURE_EMPTY ? '17-engines-install' : '17b-engines-installed');
    if (process.env.RADHA_CAPTURE_EMPTY) return;

    // Live progress panel: reinstall Apple Vision OCR (quick, packages already present).
    js(`window.radha.installEngines(['applevision'])`);
    await js(`document.querySelector('[data-view="ingest"]').click()`);
    for (let i = 0; i < 40 && !(await js('!!document.querySelector(".install-panel .progress")')); i++) await sleep(250);
    await shot('18-engines-installing', 1200);
    for (let i = 0; i < 240 && (await js('!!document.querySelector(".install-panel .progress")')); i++) await sleep(500);
    step('install finished: ' + (await js(`document.querySelector('#toast')?.textContent || ''`)));

    // Tune dialog with a test read of the synthetic sample report.
    const sample = path.resolve('test/fixtures/sample-2024.pdf');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sample] });
    await js(`[...document.querySelectorAll('.engine')].find(e => e.querySelector('.t')?.textContent.includes('Apple Vision'))?.querySelector('button.btn:not(.primary)')?.click()`);
    await sleep(600);
    await js(`[...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('Test on a report'))?.click()`);
    for (let i = 0; i < 120 && !(await js('!!document.querySelector(".tune-result")')); i++) await sleep(500);
    step('tune result: ' + (await js(`document.querySelector('.tune-result')?.innerText.split('\\n')[0] || 'none'`)));
    await shot('19-engine-tune', 800);
    await js(`document.querySelector('.modal-close')?.click()`);

    await js(`document.querySelector('[data-view="settings"]').click()`);
    await sleep(900);
    await js(`[...document.querySelectorAll('.card h2')].find(h => h.textContent.startsWith('Local parsing'))?.scrollIntoView({ block: 'start' })`);
    await shot('20-settings-engines');
  } catch (err) {
    step('FAILED: ' + err.stack);
  } finally {
    await fs.writeFile(path.join(outDir, 'capture-engines-log.txt'), log.join('\n') + '\n');
  }
}
