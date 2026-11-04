// Sarvam AI client (runs in the main process so the API key never reaches the renderer).
// Docs: https://docs.sarvam.ai — Document AI parse, /translate, /v1/chat/completions.
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';

const BASE = 'https://api.sarvam.ai';

// Languages served by the /translate endpoint (sarvam-translate:v1). Anything else goes through chat.
export const INDIC_CODES = new Set([
  'bn-IN', 'en-IN', 'gu-IN', 'hi-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN',
  'as-IN', 'brx-IN', 'doi-IN', 'kok-IN', 'ks-IN', 'mai-IN', 'mni-IN', 'ne-IN', 'sa-IN', 'sat-IN', 'sd-IN', 'ur-IN',
]);

const WORLD_NAMES = {
  'fr': 'French', 'es': 'Spanish', 'de': 'German', 'pt': 'Portuguese', 'it': 'Italian', 'ar': 'Arabic',
  'zh': 'Simplified Chinese', 'ja': 'Japanese', 'ko': 'Korean', 'ru': 'Russian', 'id': 'Indonesian',
  'sw': 'Swahili', 'tr': 'Turkish', 'vi': 'Vietnamese', 'th': 'Thai', 'nl': 'Dutch',
};

async function sarvamFetch(url, key, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'api-subscription-key': key, ...(init.headers || {}) },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      msg = body?.error?.message || body?.detail || JSON.stringify(body);
    } catch { /* keep status text */ }
    throw new Error(`Sarvam AI request failed: ${msg}`);
  }
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Upload a PDF to Sarvam Document AI, wait for the job, return the parsed Markdown. */
export async function sarvamParsePdf(filePath, key, { language = 'en-IN', timeoutMs = 5 * 60_000 } = {}) {
  const buf = await fs.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/pdf' }), path.basename(filePath));
  form.append('language', language);
  form.append('output_format', 'md');

  const submit = await (await sarvamFetch(`${BASE}/doc-ai/v1/job/parse`, key, { method: 'POST', body: form })).json();
  const jobId = submit.job_id;
  if (!jobId) throw new Error('Sarvam AI did not return a job id.');

  const started = Date.now();
  let status = submit.status;
  let usage = null;
  while (!['completed', 'partially_completed', 'failed', 'rejected'].includes(status)) {
    if (Date.now() - started > timeoutMs) throw new Error('Sarvam AI parse timed out.');
    await sleep(2000);
    const s = await (await sarvamFetch(`${BASE}/doc-ai/v1/job/${jobId}/status`, key)).json();
    status = s.status;
    usage = s.usage || usage;
  }
  if (status === 'failed' || status === 'rejected') throw new Error(`Sarvam AI parse job ${status}.`);

  const dl = await (await sarvamFetch(`${BASE}/doc-ai/v1/job/${jobId}/download-url`, key)).json();
  const zipRes = await fetch(dl.url); // pre-signed URL: no API key header
  if (!zipRes.ok) throw new Error(`Could not download Sarvam AI result (${zipRes.status}).`);
  const zip = new AdmZip(Buffer.from(await zipRes.arrayBuffer()));
  const md = zip.getEntries().find((e) => !e.isDirectory && e.entryName.endsWith('.md') && !e.entryName.includes('metadata/'));
  if (!md) throw new Error('Sarvam AI result did not contain a Markdown file.');

  return {
    engine: 'sarvam',
    format: 'markdown',
    text: md.getData().toString('utf8'),
    pages: usage?.pages_total ?? null,
    partial: status === 'partially_completed',
    warnings: status === 'partially_completed' ? ['Sarvam AI parsed only part of the document.'] : [],
  };
}

/** Split text into chunks below `max` characters, preferring paragraph then sentence boundaries. */
export function chunkText(text, max = 1900) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = '';
  const pieces = text.split(/(?<=\n)|(?<=[.!?])\s+/);
  for (const p of pieces) {
    if ((cur + p).length > max && cur) { out.push(cur); cur = ''; }
    if (p.length > max) {
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
    } else {
      cur += (cur && !cur.endsWith('\n') ? ' ' : '') + p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function translateIndic(text, target, key, source) {
  const parts = [];
  for (const chunk of chunkText(text)) {
    if (!chunk.trim()) { parts.push(chunk); continue; }
    const res = await sarvamFetch(`${BASE}/translate`, key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: chunk,
        source_language_code: source,
        target_language_code: target,
        model: 'sarvam-translate:v1',
        numerals_format: 'international',
      }),
    });
    parts.push((await res.json()).translated_text);
  }
  return parts.join(' ');
}

export async function sarvamChat(messages, key, { model = 'sarvam-105b', temperature = 0.2, maxTokens = 4096 } = {}) {
  const res = await sarvamFetch(`${BASE}/v1/chat/completions`, key, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
  });
  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Sarvam AI returned an empty response.');
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function translateWorld(text, target, key, chatModel) {
  const lang = WORLD_NAMES[target] || target;
  return sarvamChat([
    {
      role: 'system',
      content: `You are a medical translator. Translate the user's text from English into ${lang}. ` +
        'Keep numbers, units and lab test abbreviations unchanged. Translate line by line: ' +
        'output exactly one line for every input line, in the same order. Output only the translation.',
    },
    { role: 'user', content: text },
  ], key, { model: chatModel, temperature: 0 });
}

/**
 * Translate an array of strings. Indic targets use /translate; world languages use the chat model.
 * Short single-line strings are batched (joined by newlines) to keep the number of API calls low;
 * if a batch comes back with a different line count, its strings are retried one by one.
 */
export async function sarvamTranslate(texts, target, key, { source = 'en-IN', chatModel } = {}) {
  if (target === source || target === 'en-IN' || target === 'en') return texts;
  const one = INDIC_CODES.has(target)
    ? (t) => translateIndic(t, target, key, source)
    : (t) => translateWorld(t, target, key, chatModel);

  const out = [...texts];
  const todo = texts.map((_, i) => i).filter((i) => typeof texts[i] === 'string' && texts[i].trim());
  const singles = todo.filter((i) => texts[i].length > 600 || texts[i].includes('\n'));
  const batchable = todo.filter((i) => !singles.includes(i));

  const groups = [];
  let cur = [];
  let len = 0;
  for (const i of batchable) {
    if (cur.length && len + texts[i].length + 1 > 1800) { groups.push(cur); cur = []; len = 0; }
    cur.push(i); len += texts[i].length + 1;
  }
  if (cur.length) groups.push(cur);

  const tasks = [
    ...groups.map((g) => async () => {
      const res = await one(g.map((i) => texts[i]).join('\n'));
      const parts = res.split('\n').map((x) => x.trim()).filter(Boolean);
      if (parts.length === g.length) g.forEach((i, k) => { out[i] = parts[k]; });
      else for (const i of g) out[i] = await one(texts[i]);
    }),
    ...singles.map((i) => async () => { out[i] = await one(texts[i]); }),
  ];

  // Small concurrency pool to stay under rate limits.
  let next = 0;
  const worker = async () => { while (next < tasks.length) await tasks[next++](); };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}
