// Translation services for the "Output language" option. Runs in the main process (keys stay here).
// Every service receives the same thing: an array of English strings and a target language code
// from translate.js ('hi-IN', 'gu-IN', 'fr', …), and returns the translated array in the same order.
import { sarvamTranslate, chunkText } from './sarvam.js';
import { aiChat } from './aiProviders.js';

export const TRANSLATORS = [
  { id: 'google_free', name: 'Google Translate — free, no key', needsKey: false, free: true,
    note: 'Uses Google Translate\'s public web endpoint. No account needed; very wide language coverage. Unofficial — Google may rate-limit heavy use.' },
  { id: 'sarvam', name: 'Sarvam AI', needsKey: true,
    note: 'Indian-language specialist (22 Indian languages); world languages go through Sarvam\'s chat model. Uses your Sarvam key.' },
  { id: 'google_cloud', name: 'Google Cloud Translation (official)', needsKey: true,
    note: 'Official Google API — key from console.cloud.google.com (Cloud Translation API). First 500,000 characters per month are free.' },
  { id: 'mymemory', name: 'MyMemory — free, no key', needsKey: false, free: true,
    note: 'Free service by Translated. Anonymous use is limited to about 5,000 characters a day — enough for a short report; add an email in Settings for 50,000 a day.' },
  { id: 'libre', name: 'LibreTranslate (open source)', needsKey: false, optionalKey: true,
    note: 'Open-source translator. Free if you run it yourself (e.g. Docker on this computer); libretranslate.com needs a paid key. Fewer Indian languages.' },
  { id: 'ai', name: 'My AI provider (from AI providers)', needsKey: false,
    note: 'Translates with the AI chosen under AI providers — e.g. free Pollinations or local Ollama. Quality depends on the model.' },
];

const LANG_NAMES = {
  'hi': 'Hindi', 'gu': 'Gujarati', 'bn': 'Bengali', 'te': 'Telugu', 'ta': 'Tamil', 'mr': 'Marathi', 'kn': 'Kannada', 'ml': 'Malayalam',
  'pa': 'Punjabi', 'or': 'Odia', 'ur': 'Urdu', 'as': 'Assamese', 'ne': 'Nepali', 'fr': 'French', 'es': 'Spanish', 'de': 'German',
  'pt': 'Portuguese', 'ar': 'Arabic', 'zh-CN': 'Simplified Chinese', 'ja': 'Japanese', 'ru': 'Russian', 'id': 'Indonesian', 'sw': 'Swahili',
};

/** App language code -> ISO code used by Google / MyMemory / LibreTranslate. */
export function isoCode(code) {
  const base = String(code).split('-')[0];
  if (base === 'od') return 'or';
  if (base === 'zh') return 'zh-CN';
  return base;
}

const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');

async function jsonOrThrow(res, label) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error || body?.responseDetails || text.slice(0, 200) || `${res.status}`;
    throw new Error(`${label}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  if (body == null) throw new Error(`${label}: unexpected response`);
  return body;
}

/**
 * Translate short strings in newline-joined batches (fewer requests, keeps each line aligned) and
 * long or multi-line strings one at a time. A batch whose line count changes is retried per string.
 */
export async function batchTranslate(texts, one, { maxChars = 1800, concurrency = 3 } = {}) {
  const out = [...texts];
  const todo = texts.map((_, i) => i).filter((i) => typeof texts[i] === 'string' && texts[i].trim());
  const singles = todo.filter((i) => texts[i].length > maxChars / 3 || texts[i].includes('\n'));
  const batchable = todo.filter((i) => !singles.includes(i));

  const groups = [];
  let cur = [];
  let len = 0;
  for (const i of batchable) {
    if (cur.length && len + texts[i].length + 1 > maxChars) { groups.push(cur); cur = []; len = 0; }
    cur.push(i); len += texts[i].length + 1;
  }
  if (cur.length) groups.push(cur);

  const long = async (t) => {
    const parts = [];
    for (const c of chunkText(t, maxChars)) parts.push(await one(c));
    return parts.join(t.includes('\n') ? '\n' : ' ');
  };
  const tasks = [
    ...groups.map((g) => async () => {
      const res = await one(g.map((i) => texts[i]).join('\n'));
      const lines = res.split('\n').map((x) => x.trim()).filter(Boolean);
      if (lines.length === g.length) g.forEach((i, k) => { out[i] = lines[k]; });
      else for (const i of g) out[i] = await one(texts[i]);
    }),
    ...singles.map((i) => async () => { out[i] = await long(texts[i]); }),
  ];
  let next = 0;
  const worker = async () => { while (next < tasks.length) await tasks[next++](); };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

// ---------------------------------------------------------------- services

async function googleFree(text, tl) {
  const res = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&dt=t&tl=' + encodeURIComponent(tl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ q: text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) throw new Error('Google Translate (free) is rate-limiting requests — wait a minute or choose another service.');
  const body = await jsonOrThrow(res, 'Google Translate');
  return (body?.[0] || []).map((seg) => seg?.[0] || '').join('').trim();
}

async function googleCloud(texts, tl, key) {
  const out = [...texts];
  const idx = texts.map((_, i) => i).filter((i) => texts[i] && texts[i].trim());
  for (let s = 0; s < idx.length; s += 100) {
    const part = idx.slice(s, s + 100);
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: part.map((i) => texts[i]), source: 'en', target: tl, format: 'text' }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await jsonOrThrow(res, 'Google Cloud Translation');
    body.data.translations.forEach((t, k) => { out[part[k]] = t.translatedText; });
  }
  return out;
}

async function myMemory(text, tl, email) {
  const params = new URLSearchParams({ q: text, langpair: `en|${tl}` });
  if (email) params.set('de', email);
  const res = await fetch(`https://api.mymemory.translated.net/get?${params}`, { signal: AbortSignal.timeout(30_000) });
  const body = await jsonOrThrow(res, 'MyMemory');
  if (body.quotaFinished || /LIMIT|QUOTA/i.test(String(body.responseDetails || ''))) {
    throw new Error('MyMemory\'s free daily limit is used up. Add an email in Settings → Translation for a higher limit, or choose another service.');
  }
  if (Number(body.responseStatus) !== 200) throw new Error(`MyMemory: ${body.responseDetails || body.responseStatus}`);
  return String(body.responseData?.translatedText || '').trim();
}

async function libre(texts, tl, { url, key }) {
  const base = trimSlash(url);
  if (!/^https?:\/\//.test(base)) throw new Error('LibreTranslate: set the server URL in Settings → Translation.');
  const out = [...texts];
  const idx = texts.map((_, i) => i).filter((i) => texts[i] && texts[i].trim());
  for (let s = 0; s < idx.length; s += 50) {
    const part = idx.slice(s, s + 50);
    const res = await fetch(`${base}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: part.map((i) => texts[i]), source: 'en', target: tl, format: 'text', ...(key ? { api_key: key } : {}) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 403 && /:5000$/.test(base) && /localhost|127\.0\.0\.1/.test(base)) {
      throw new Error('LibreTranslate: port 5000 on a Mac is taken by AirPlay Receiver. Run LibreTranslate on another port (e.g. docker run -p 5050:5000 libretranslate/libretranslate) and use http://localhost:5050.');
    }
    const body = await jsonOrThrow(res, 'LibreTranslate');
    const arr = Array.isArray(body.translatedText) ? body.translatedText : [body.translatedText];
    arr.forEach((t, k) => { out[part[k]] = t; });
  }
  return out;
}

function aiTranslateOne(target, settings, getKey) {
  const lang = LANG_NAMES[isoCode(target)] || target;
  const provider = settings.aiProvider || 'pollinations';
  return (text) => aiChat(provider, [
    { role: 'system', content: `You are a medical translator. Translate the user's text from English into ${lang}. ` +
      'Keep numbers, units and lab test abbreviations unchanged. Translate line by line: output exactly one line for every ' +
      'input line, in the same order. Output only the translation, with no notes.' },
    { role: 'user', content: text },
  ], { model: settings.aiModels?.[provider], key: getKey(provider), settings });
}

/**
 * Translate `texts` (English) into `target` with the chosen service.
 * ctx: { settings, getKey(id) } — getKey resolves saved keys ('sarvam', 'tr_google_cloud', 'tr_libre', AI provider ids).
 */
export async function translateTexts(serviceId, texts, target, { settings, getKey }) {
  if (target === 'en-IN' || target === 'en') return texts;
  const tl = isoCode(target);
  switch (serviceId) {
    case 'sarvam': {
      const key = getKey('sarvam');
      if (!key) throw new Error('Sarvam AI needs an API key. Add it in Settings, or choose a free translation service.');
      return sarvamTranslate(texts, target, key, { chatModel: settings.sarvamChatModel });
    }
    case 'google_free':
      return batchTranslate(texts, (t) => googleFree(t, tl), { maxChars: 4000, concurrency: 2 });
    case 'google_cloud': {
      const key = getKey('tr_google_cloud');
      if (!key) throw new Error('Google Cloud Translation needs an API key (Settings → Translation).');
      return googleCloud(texts, tl, key);
    }
    case 'mymemory':
      return batchTranslate(texts, (t) => myMemory(t, tl, settings.myMemoryEmail), { maxChars: 480, concurrency: 2 });
    case 'libre':
      return libre(texts, tl, { url: settings.libreUrl, key: getKey('tr_libre') });
    case 'ai':
      return batchTranslate(texts, aiTranslateOne(target, settings, getKey), { maxChars: 1800, concurrency: 2 });
    default:
      throw new Error(`Unknown translation service: ${serviceId}`);
  }
}
