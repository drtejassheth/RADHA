// End-to-end smoke test: drives the real UI with the demo reports, screenshots every view and
// exports a PDF. Run with:  RADHA_SMOKE=/path/to/outdir npx electron .
import { dialog, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(win, outDir) {
  outDir = path.resolve(outDir === '1' ? 'smoke-out' : outDir);
  await fs.mkdir(outDir, { recursive: true });
  const errors = [];
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e.params?.level;
    if (level === 'error' || level === 3) errors.push(e.message ?? e.params?.message);
  });

  // Never open real dialogs / Finder during the smoke run.
  const pdfPath = path.join(outDir, 'RADHA-export.pdf');
  dialog.showSaveDialog = async (_w, opts) => ({ canceled: false, filePath: /\.pdf$/.test(opts?.defaultPath || '.pdf') ? pdfPath : path.join(outDir, path.basename(opts.defaultPath)) });
  shell.showItemInFolder = () => {};

  const js = (code) => win.webContents.executeJavaScript(code);
  const click = (text) => js(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes(${JSON.stringify(text)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  const shot = async (name) => {
    await sleep(700);
    const img = await win.webContents.capturePage();
    await fs.writeFile(path.join(outDir, `${name}.png`), img.toPNG());
  };
  const nav = async (view) => { await js(`document.querySelector('[data-view="${view}"]').click()`); };
  const log = [];
  const step = (s) => { log.push(s); console.log('[smoke]', s); };

  try {
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    await sleep(1500);
    await shot('01-ingest');
    step('ingest view rendered: ' + (await js(`document.querySelector('#viewTitle').textContent`)));

    const files = (process.env.RADHA_SMOKE_FILES || '').split('|').filter(Boolean);
    if (process.env.RADHA_SMOKE_SEED) {
      // Existing-database mode: patients tab, translation of stored reports, CSV + backup.
      await nav('patients'); await sleep(1000); await shot('p1-patients');
      step('patients: ' + (await js(`[...document.querySelectorAll('.lib-item')].map(b => b.innerText.replace(/\\n/g, ' — ')).join(' | ')`)));
      step('reports in panel: ' + (await js(`document.querySelectorAll('.patient-form ~ .card tbody tr').length`)));
      step('date warning: ' + (await js(`document.querySelector('.warn-cell')?.innerText || 'none'`)));
      await click('Fix date'); await sleep(1500);
      step('after fix: ' + (await js(`[...document.querySelectorAll('.patient-form ~ .card tbody tr td:first-child')].map(t => t.innerText).join(' | ')`)));
      await js(`(() => { const i = [...document.querySelectorAll('.patient-form label')].find(l => l.textContent.startsWith('Systolic'))?.querySelector('input'); i.value = '128'; i.dispatchEvent(new Event('input')); })()`);
      await js(`[...document.querySelectorAll('.patient-form label')].find(l => l.textContent.includes('Taking blood-pressure'))?.querySelector('input')?.click()`);
      await click('Save profile'); await sleep(1200);
      await click('Results as CSV'); await sleep(1500);
      await click('Backup all data'); await sleep(1500);
      step('files written: ' + (await fs.readdir(outDir)).filter((f) => /csv|json/.test(f)).join(', '));
      await click('Open latest report'); await sleep(1200);
      await js(`(() => { const t = document.querySelector('#trSelect'); t.value = 'google_free'; t.dispatchEvent(new Event('change')); })()`);
      await sleep(300);
      await js(`(() => { const l = document.querySelector('#langSelect'); l.value = 'hi-IN'; l.dispatchEvent(new Event('change')); })()`);
      for (let i = 0; i < 240 && (await js(`!document.querySelector('#banner').hidden`)); i++) await sleep(500);
      await nav('analysis'); await sleep(800);
      step('translated (Hindi) headline: ' + (await js(`document.querySelector('.card h2')?.textContent`)));
      step('toast: ' + (await js(`document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent`)));
      await nav('calculators'); await sleep(800);
      step('ASCVD now: ' + (await js(`document.querySelector('#calc-ascvd_pce')?.innerText.replace(/\\n/g, ' ').slice(0, 160) || 'not in results tab'`)));
      await nav('trends'); await sleep(800); await shot('p2-trends');
      step('trend columns: ' + (await js(`[...document.querySelectorAll('.table-wrap thead th')].map(t=>t.textContent).join(' | ')`)));
      await nav('patients'); await sleep(800); await shot('p3-patient-after');
      step('console errors: ' + (errors.length ? errors.join(' / ') : 'none'));
      await fs.writeFile(path.join(outDir, 'smoke-log.txt'), log.join('\n') + '\n');
      return;
    }
    if (files.length) {
      // Real-file mode: parse the given PDFs with the chosen engine through the normal UI.
      const engine = process.env.RADHA_SMOKE_ENGINE || 'auto';
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      await js(`document.querySelector('input[name=engine][value="${engine}"]').click()`);
      await js(`document.querySelector('.dropzone').click()`);
      step(`parsing ${files.length} file(s) with ${engine}…`);
      for (let i = 0; i < 240; i++) {
        await sleep(500);
        const st = await js(`[...document.querySelectorAll('.queue-item')].map(q => q.innerText.replace(/\\n/g,' ')).join(' || ') || document.querySelector('#viewTitle').textContent`);
        if (/Verify extracted values/.test(st) || !/Parsing with/.test(st)) { step('queue: ' + st.slice(0, 400)); break; }
      }
    } else {
      step('load demo: ' + (await click('Load demo reports')));
    }
    await sleep(500);
    await shot('02-verify');
    step('rows in verify table: ' + (await js(`document.querySelectorAll('.verify-table tbody tr').length`)));
    for (let i = 0; i < 10; i++) {
      // Reports without a printed date: use a placeholder so the run can continue.
      await js(`(() => { const d = document.querySelector('input[type=date]'); if (d && !d.value) { d.value = '2026-10-14'; d.dispatchEvent(new Event('input')); } })()`);
      const more = await click('Confirm & verify next');
      if (!more) { step('final confirm: ' + (await click('Confirm & analyse'))); break; }
      step('confirmed one report');
      await sleep(800);
    }
    await sleep(800);
    await shot('03-dashboard');
    step('dashboard KPIs: ' + (await js(`[...document.querySelectorAll('.kpi')].map(k => k.innerText.replace(/\\n/g,' ')).join(' | ')`)));

    await nav('labs'); await shot('04-labs');
    step('lab rows: ' + (await js(`document.querySelectorAll('.table-wrap tbody tr:not(.panel-head)').length`)));
    await nav('calculators'); await sleep(800); await shot('05-calculators');
    step('calculator tabs: ' + (await js(`[...document.querySelectorAll('.tabs button')].map(b=>b.textContent).join(' | ')`)));
    await click('Needs your input'); await shot('05b-calculators-input');
    await click('Not available'); await shot('05c-calculators-missing');
    await click('Results');
    await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Calculator details'))?.click()`);
    await sleep(1200); await shot('05d-calculator-details');
    await js(`document.querySelector('.modal-close')?.click()`);
    await nav('library'); await sleep(1500);
    await js(`(() => { const i = document.querySelector('#view input[type=text]'); i.value = 'meld'; i.dispatchEvent(new Event('input')); document.querySelector('.lib-item')?.click(); })()`);
    await sleep(1200); await shot('05e-library');
    step('library: ' + (await js(`document.querySelector('#view .row.mb + .row.mb')?.innerText`)));
    await nav('analysis'); await shot('06-analysis');
    step('observations: ' + (await js(`document.querySelectorAll('.obs').length`)));
    step('doctor questions: ' + (await js(`document.querySelectorAll('.q-group li').length + ' in ' + document.querySelectorAll('.q-group').length + ' groups'`)));
    step('lifestyle section present: ' + (await js(`document.body.innerText.includes('Lifestyle suggestions')`)));
    if (process.env.RADHA_SMOKE_NARRATIVE) {
      // Uses the default provider (Pollinations: free, no key).
      await click('Generate');
      for (let i = 0; i < 180 && !(await js(`!!document.querySelector('.ai-text')`)); i++) await sleep(500);
      step('narrative: ' + (await js(`(document.querySelector('.ai-text')?.innerText || 'none').slice(0, 160).replace(/\\n/g, ' ')`)));
      step('narrative meta: ' + (await js(`document.querySelector('.ai-text + .small')?.innerText || ''`)));
      await js(`document.querySelector('.ai-text')?.scrollIntoView()`);
      await shot('06b-narrative');
    }
    await js(`document.querySelector('.q-group')?.scrollIntoView()`);
    await shot('06c-questions');
    if (process.env.RADHA_SMOKE_TRANSLATE) {
      // Switch translator + language from the top bar, wait for the translated analysis.
      await js(`(() => { const t = document.querySelector('#trSelect'); t.value = ${JSON.stringify(process.env.RADHA_SMOKE_TRANSLATE)}; t.dispatchEvent(new Event('change')); })()`);
      await sleep(500);
      await js(`(() => { const l = document.querySelector('#langSelect'); l.value = 'gu-IN'; l.dispatchEvent(new Event('change')); })()`);
      for (let i = 0; i < 240 && (await js(`!document.querySelector('#banner').hidden`)); i++) await sleep(500);
      await sleep(800);
      step('translator options: ' + (await js(`[...document.querySelectorAll('#trSelect option')].map(o => o.textContent).join(' | ')`)));
      step('translated headline: ' + (await js(`document.querySelector('.card h2')?.textContent`)));
      step('translated question: ' + (await js(`document.querySelector('.q-group li')?.textContent`)));
      await shot('06d-translated');
      await nav('dashboard'); await js(`document.querySelector('#exportBtn').click()`); await sleep(4000);
      await js(`(() => { const l = document.querySelector('#langSelect'); l.value = 'en-IN'; l.dispatchEvent(new Event('change')); })()`);
      await sleep(500);
    }
    await nav('trends'); await sleep(500); await shot('07-trends');
    step('trend columns: ' + (await js(`[...document.querySelectorAll('.table-wrap thead th')].map(t=>t.textContent).join(' | ')`)));
    await nav('settings'); await sleep(1500); await js(`document.querySelector('.provider')?.scrollIntoView()`); await sleep(800); await shot('08-settings');
    step('providers: ' + (await js(`[...document.querySelectorAll('.provider b')].map(b => b.textContent).join(' | ')`)));

    await nav('dashboard');
    await js(`document.querySelector('#exportBtn').click()`);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try { const st = await fs.stat(pdfPath); if (st.size > 0) { step(`PDF exported: ${st.size} bytes`); break; } } catch { /* not yet */ }
    }
  } catch (err) {
    errors.push('SMOKE FAILURE: ' + err.stack);
  }
  step('console errors: ' + (errors.length ? '\n  ' + errors.join('\n  ') : 'none'));
  await fs.writeFile(path.join(outDir, 'smoke-log.txt'), log.join('\n') + '\n');
}
