// Screen recordings for the launch video (synthetic demo patient only). Not part of the app.
//   RADHA_SMOKE=<out> RADHA_SCRIPT=scripts/record-launch.js RADHA_ENGINES_HOME=~/Library/Application\ Support/RADHA npx electron .
import { dialog, shell, nativeTheme } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(win, outDir) {
  outDir = path.resolve(outDir);
  await fs.mkdir(outDir, { recursive: true });
  nativeTheme.themeSource = 'light';
  win.webContents.setBackgroundThrottling(false);
  win.show(); win.focus();
  win.setContentSize(1600, 900); win.center();
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(outDir, 'export.pdf') });
  shell.showItemInFolder = () => {};
  const js = (code) => win.webContents.executeJavaScript(code);
  const log = (s) => console.log('[rec]', s);

  // --- recorder: grabs frames continuously, remembers their timestamps ---
  let recording = null;
  async function loop(r) {
    while (recording === r) {
      const t = Date.now() - r.t0;
      const img = await win.webContents.capturePage();
      const file = path.join(r.dir, `f${String(r.frames.length).padStart(5, '0')}.jpg`);
      await fs.writeFile(file, img.resize({ width: 1920, height: 1080, quality: 'good' }).toJPEG(90));
      r.frames.push({ file, t });
    }
  }
  async function rec(name, fn) {
    const dir = path.join(outDir, name);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const r = { dir, frames: [], t0: Date.now() };
    recording = r;
    const done = loop(r);
    try { await fn(); } catch (e) { log(`${name} error ${e.message}`); }
    await sleep(600);
    recording = null; await done;
    const dur = (Date.now() - r.t0) / 1000;
    await fs.writeFile(path.join(dir, 'frames.json'), JSON.stringify({ dur, frames: r.frames.map((f) => ({ f: path.basename(f.file), t: f.t })) }));
    log(`${name}: ${r.frames.length} frames, ${dur.toFixed(1)} s`);
  }

  // --- page helpers: visible fake cursor, smooth scrolling, clicks ---
  const injectCursor = () => js(`(() => { if (document.getElementById('rc')) return;
    const c = document.createElement('div'); c.id = 'rc';
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2l16 10-7 1.5L9.5 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '800px', top: '500px', zIndex: 99999, pointerEvents: 'none', transition: 'left .7s cubic-bezier(.4,0,.2,1), top .7s cubic-bezier(.4,0,.2,1), transform .15s' });
    document.body.appendChild(c);
    const s = document.createElement('style'); s.textContent = '.rc-ring{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #6d5dfc;z-index:99998;pointer-events:none;animation:rcr .5s ease-out forwards}@keyframes rcr{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}';
    document.head.appendChild(s); })()`);
  const point = async (expr) => {
    const ok = await js(`(() => { const el = ${expr}; if (!el) return false; el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return true; })()`);
    if (!ok) return false;
    await sleep(350);
    await js(`(() => { const el = ${expr}; const b = el.getBoundingClientRect(); const c = document.getElementById('rc'); c.style.left = (b.left + Math.min(b.width / 2, 60)) + 'px'; c.style.top = (b.top + b.height / 2) + 'px'; })()`);
    await sleep(800);
    return true;
  };
  const clickEl = async (expr, wait = 900) => {
    if (!(await point(expr))) { log('missing ' + expr); return false; }
    await js(`(() => { const c = document.getElementById('rc'); const r = document.createElement('div'); r.className = 'rc-ring'; r.style.left = (parseFloat(c.style.left) + 4) + 'px'; r.style.top = (parseFloat(c.style.top) + 4) + 'px'; document.body.appendChild(r); setTimeout(() => r.remove(), 600); c.style.transform = 'scale(.85)'; setTimeout(() => c.style.transform = '', 150); (${expr}).click(); })()`);
    await sleep(wait);
    return true;
  };
  const btn = (text) => `[...document.querySelectorAll('button')].find(x => x.textContent.includes(${JSON.stringify(text)}) && !x.disabled)`;
  const navEl = (view) => `document.querySelector('[data-view="${view}"]')`;
  const scroll = (to, ms = 2500) => js(`new Promise((res) => { const v = document.querySelector('#view'); const from = v.scrollTop; const target = typeof (${JSON.stringify(to)}) === 'number' ? ${JSON.stringify(to)} : (() => { const el = document.querySelector(${JSON.stringify(to)}); return el ? from + el.getBoundingClientRect().top - v.getBoundingClientRect().top - 12 : from; })(); const t0 = performance.now(); const step = (n) => { const k = Math.min(1, (n - t0) / ${ms}); const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; v.scrollTop = from + (target - from) * e; k < 1 ? requestAnimationFrame(step) : res(); }; requestAnimationFrame(step); })`);
  const setInput = (labelStart, value) => js(`(() => { const l = [...document.querySelectorAll('.patient-form label')].find(x => x.textContent.trim().startsWith(${JSON.stringify(labelStart)})); const i = l?.querySelector('input, textarea'); if (!i) return false; i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); return true; })()`);

  try {
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    await sleep(2500);
    await injectCursor();
    await js(`${navEl('ingest')}.click()`);
    for (let i = 0; i < 60 && (await js('/Checking/.test(document.querySelector("#view").textContent)')); i++) await sleep(500);
    await sleep(800);

    await rec('c01-ingest', async () => {
      await sleep(1200);
      await point(`document.querySelector('.engine-grid')`);
      await scroll('.engine-grid', 3000);
      await sleep(800);
      await point(btn('Install all'));
      await sleep(800);
      await point(`[...document.querySelectorAll('.engine')].find(e => e.textContent.includes('Apple Vision'))`);
      await sleep(1500);
      await scroll(0, 2000);
      await point(btn('Load demo reports'));
      await sleep(600);
    });

    await rec('c02-verify', async () => {
      await clickEl(btn('Load demo reports'), 1800);
      await scroll(500, 4000);
      await sleep(800);
      await scroll(0, 1500);
      await point(btn('Confirm'));
      await sleep(800);
    });
    await js(`${btn('Confirm & verify next')}?.click()`); await sleep(900);
    await js(`${btn('Confirm & analyse')}?.click()`); await sleep(1200);

    // Profile (off camera, then recorded below).
    await js(`${navEl('patients')}.click()`); await sleep(900);
    await setInput('Height', '170'); await setInput('Weight', '82');
    await setInput('Systolic', '132'); await setInput('Diastolic', '84');
    await setInput('Date of birth', '1972-01-15');
    await js(`[...document.querySelectorAll('.patient-form label')].find(l => l.textContent.includes('Taking blood-pressure'))?.querySelector('input')?.click()`);
    await js(`(() => { const s = [...document.querySelectorAll('.patient-form label')].find(l => l.textContent.trim().startsWith('Smoking'))?.querySelector('select'); s.value = 'never'; s.dispatchEvent(new Event('change')); })()`);
    await js(`${btn('Save profile')}?.click()`); await sleep(1000);
    await js(`${btn('Open latest report')}?.click()`); await sleep(1200);

    await rec('c03-dashboard', async () => {
      await sleep(1500);
      await scroll(400, 3000);
      await sleep(600);
      await clickEl(navEl('labs'), 1200);
      await clickEl(btn('Out of range'), 1800);
      await js(`${btn('All (')}?.click()`);
    });

    await js(`${navEl('dashboard')}.click()`); await sleep(500);
    await rec('c04-calculators', async () => {
      await clickEl(navEl('calculators'), 1600);
      await scroll(700, 4000);
      await sleep(500);
      await scroll(0, 1200);
      await clickEl(btn('Needs your input'), 1500);
      await clickEl(btn('Results'), 800);
      await clickEl(btn('Calculator details'), 2500);
      await js(`document.querySelector('.modal-close')?.click()`);
      await sleep(400);
    });

    await rec('c05-library', async () => {
      await clickEl(navEl('library'), 1800);
      await point(`document.querySelector('#view input[type=text]')`);
      for (const ch of 'fib-4') { await js(`(() => { const i = document.querySelector('#view input[type=text]'); i.value += ${JSON.stringify(ch)}; i.dispatchEvent(new Event('input')); })()`); await sleep(220); }
      await sleep(600);
      await clickEl(`document.querySelector('.lib-item')`, 2200);
    });

    await rec('c06-analysis', async () => {
      await clickEl(navEl('analysis'), 1500);
      await scroll(600, 3500);
      await scroll('.q-group', 3000);
      await sleep(600);
      await scroll(document ? 2600 : 2600, 4000);
      await sleep(600);
    });

    await rec('c07-ai', async () => {
      await scroll(0, 800);
      await clickEl(btn('Generate'), 500);
      for (let i = 0; i < 120 && !(await js(`!!document.querySelector('.ai-text')`)); i++) await sleep(500);
      await scroll('.ai-text', 1500);
      await js(`document.querySelector('#view').scrollTop -= 90`);
      await sleep(3000);
    });

    await rec('c08-trends', async () => {
      await clickEl(navEl('trends'), 2500);
      await scroll(500, 3000);
      await sleep(1000);
    });

    await rec('c09-patients', async () => {
      await clickEl(navEl('patients'), 1800);
      await scroll('.patient-form ~ .card', 2500);
      await sleep(800);
    });

    await js(`${navEl('analysis')}.click()`); await sleep(600);
    await rec('c10-translate', async () => {
      await point(`document.querySelector('#langSelect')`);
      await js(`(() => { const l = document.querySelector('#langSelect'); l.value = 'gu-IN'; l.dispatchEvent(new Event('change')); })()`);
      for (let i = 0; i < 120 && !(await js(`/[઀-૿]/.test(document.querySelector('.obs h3')?.textContent || '')`)); i++) await sleep(500);
      await sleep(800);
      await scroll(500, 3000);
      await sleep(500);
      await clickEl(`document.querySelector('#exportBtn')`, 2500);
    });
  } catch (err) {
    log('FAILED ' + err.stack);
  }
}
