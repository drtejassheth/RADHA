// Output-language support. Indic languages go through Sarvam /translate; world languages through
// the Sarvam chat model (see src/main/sarvam.js). Only interpretations and advice are translated —
// test names, numbers and units stay as printed so they still match the lab report.

export const LANGUAGES = [
  { code: 'en-IN', name: 'English', native: 'English', indic: true },
  { code: 'hi-IN', name: 'Hindi', native: 'हिन्दी', indic: true },
  { code: 'gu-IN', name: 'Gujarati', native: 'ગુજરાતી', indic: true },
  { code: 'bn-IN', name: 'Bangla', native: 'বাংলা', indic: true },
  { code: 'te-IN', name: 'Telugu', native: 'తెలుగు', indic: true },
  { code: 'ta-IN', name: 'Tamil', native: 'தமிழ்', indic: true },
  { code: 'mr-IN', name: 'Marathi', native: 'मराठी', indic: true },
  { code: 'kn-IN', name: 'Kannada', native: 'ಕನ್ನಡ', indic: true },
  { code: 'ml-IN', name: 'Malayalam', native: 'മലയാളം', indic: true },
  { code: 'pa-IN', name: 'Punjabi', native: 'ਪੰਜਾਬੀ', indic: true },
  { code: 'od-IN', name: 'Odia', native: 'ଓଡ଼ିଆ', indic: true },
  { code: 'ur-IN', name: 'Urdu', native: 'اردو', indic: true },
  { code: 'as-IN', name: 'Assamese', native: 'অসমীয়া', indic: true },
  { code: 'ne-IN', name: 'Nepali', native: 'नेपाली', indic: true },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'zh', name: 'Chinese', native: '中文' },
  { code: 'ja', name: 'Japanese', native: '日本語' },
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'sw', name: 'Swahili', native: 'Kiswahili' },
];

export const RTL = new Set(['ur-IN', 'ar']);

/**
 * Translate the patient-facing text of a report. `translateFn(texts, target)` resolves to an array
 * of translated strings in the same order.
 */
export async function translateBundle(report, narrative, lang, translateFn) {
  const bundle = structuredClone({
    analysis: report.analysis,
    calc: report.calc.filter((c) => c.ready).map((c) => ({ id: c.id, band: c.band, interpretation: c.interpretation })),
    narrative: narrative || null,
  });

  const refs = [];
  const add = (obj, k) => { if (typeof obj[k] === 'string' && obj[k].trim()) refs.push([obj, k]); };
  const a = bundle.analysis;
  a.questions = (a.questions || []).map((q) => (typeof q === 'string' ? { topic: 'General', text: q } : q));
  add(a, 'headline');
  add(a, 'summary');
  for (const o of a.observations) {
    add(o, 'title');
    add(o, 'detail');
    o.nextSteps.forEach((_, i) => add(o.nextSteps, i));
  }
  // Topics repeat across questions: translate each once so groups stay together.
  const topics = {};
  for (const q of a.questions) { topics[q.topic] ||= { t: q.topic }; add(q, 'text'); }
  for (const t of Object.values(topics)) add(t, 't');
  for (const c of bundle.calc) { add(c, 'band'); add(c, 'interpretation'); }
  add(bundle, 'narrative');

  const out = await translateFn(refs.map(([o, k]) => o[k]), lang);
  refs.forEach(([o, k], i) => { if (out[i]) o[k] = out[i]; });
  for (const q of a.questions) q.topic = topics[q.topic]?.t || q.topic;
  bundle.lang = lang;
  return bundle;
}
