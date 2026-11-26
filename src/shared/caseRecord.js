// Clinical details for the patient profile, modelled on an outpatient diabetes case record
// (history, lifestyle, complications, admissions, immunisation and examination).
//
// extractProfileFacts(text) reads "Label: value" lines from any ingested document and returns
// each value with the line it was printed on (and the page, when the document prints page numbers),
// so the profile can show where every auto-filled value came from.
// Blank forms yield nothing: option lists such as "Yes/No" or "present/absent" are never taken as values.

export const SECTIONS = [
  ['history', 'Diabetes & medical history'],
  ['lifestyle', 'Smoking, alcohol & tobacco'],
  ['complications', 'Diabetes complications'],
  ['admissions', 'Hospital admissions & immunisation'],
  ['general', 'Examination: vitals & general'],
  ['foot', 'Examination: feet'],
  ['systemic', 'Examination: skin & systems'],
];

const YN = [['yes', 'Yes'], ['no', 'No']];
const PA = [['present', 'Present'], ['absent', 'Absent']];

// type: text | number | year | yesno | presence | select | bp
// label: regex matched at the start of a line segment. parent: only after that field's label (within 3 lines).
// flat: stored on the profile itself (shared with older profile fields), otherwise in profile.record.
export const FIELDS = [
  // history
  { key: 'occupation', section: 'history', label: 'Occupation', type: 'text', re: /occupation/ },
  { key: 'diabetesType', section: 'history', label: 'Type of diabetes', type: 'select', re: /type of diabetes|diabetes type/,
    options: [['type1', 'Type 1'], ['type2', 'Type 2'], ['gestational', 'Gestational'], ['prediabetes', 'Prediabetes'], ['other', 'Other']] },
  { key: 'diabetesYear', section: 'history', label: 'Year of diagnosis', type: 'year', re: /year of diagnosis|diagnosed in/ },
  { key: 'associatedDiseases', section: 'history', label: 'Associated diseases (date detected)', type: 'text', re: /associated diseases?|co-?morbidit(?:y|ies)/ },
  { key: 'previousSurgeries', section: 'history', label: 'Previous surgeries', type: 'text', re: /previous surger(?:y|ies)|past surgical history/ },
  { key: 'familyHistory', section: 'history', label: 'Family history', type: 'text', re: /family history/, flat: true },
  { key: 'allergies', section: 'history', label: 'Drug allergy', type: 'text', re: /drug allerg(?:y|ies)|allergies/, flat: true },
  { key: 'children', section: 'history', label: 'Number of children', type: 'number', re: /no\.? of children|number of children/, min: 0, max: 20 },
  { key: 'lastChildbirth', section: 'history', label: 'Last childbirth', type: 'text', re: /last child ?birth/ },
  // lifestyle
  { key: 'smokingStatus', section: 'lifestyle', label: 'Smoking', type: 'yesno', re: /smoking|smoker/, habit: 'smoking' },
  { key: 'smokingForm', section: 'lifestyle', label: 'What is smoked', type: 'text' },
  { key: 'smokingPerDay', section: 'lifestyle', label: 'Smoked per day', type: 'number', min: 0, max: 200 },
  { key: 'smokingYears', section: 'lifestyle', label: 'Smoking for (years)', type: 'number', min: 0, max: 90 },
  { key: 'alcoholStatus', section: 'lifestyle', label: 'Alcohol', type: 'yesno', re: /alcohol/, habit: 'alcohol' },
  { key: 'alcoholForm', section: 'lifestyle', label: 'Drink', type: 'text' },
  { key: 'alcoholMlWeek', section: 'lifestyle', label: 'Alcohol (ml per week)', type: 'number', min: 0, max: 20000 },
  { key: 'alcoholYears', section: 'lifestyle', label: 'Drinking for (years)', type: 'number', min: 0, max: 90 },
  { key: 'tobaccoStatus', section: 'lifestyle', label: 'Tobacco (chewed)', type: 'yesno', re: /tobacco|gutkha|khaini/, habit: 'tobacco' },
  { key: 'tobaccoPerDay', section: 'lifestyle', label: 'Tobacco per day', type: 'number', min: 0, max: 200 },
  { key: 'tobaccoYears', section: 'lifestyle', label: 'Tobacco for (years)', type: 'number', min: 0, max: 90 },
  // complications
  { key: 'retinopathy', section: 'complications', label: 'Retinopathy', type: 'yesno', re: /retinopathy/ },
  { key: 'retinopathyType', section: 'complications', label: 'Retinopathy type', type: 'text', re: /type/, parent: 'retinopathy' },
  { key: 'laserTreatment', section: 'complications', label: 'Laser treatment', type: 'yesno', re: /laser(?: treatment| therapy)?/ },
  { key: 'microalbuminuria', section: 'complications', label: 'Microalbuminuria', type: 'yesno', re: /micro ?albuminuria/ },
  { key: 'ckd', section: 'complications', label: 'Chronic kidney disease (CKD)', type: 'yesno', re: /ckd|chronic kidney disease/ },
  { key: 'ckdStage', section: 'complications', label: 'CKD stage', type: 'text', re: /stage/, parent: 'ckd' },
  { key: 'peripheralNeuropathy', section: 'complications', label: 'Peripheral neuropathy', type: 'yesno', re: /peripheral neuropathy/ },
  { key: 'peripheralNeuropathyType', section: 'complications', label: 'Peripheral neuropathy type', type: 'text', re: /type/, parent: 'peripheralNeuropathy' },
  { key: 'autonomicNeuropathy', section: 'complications', label: 'Autonomic neuropathy', type: 'yesno', re: /autonomic neuropathy/ },
  { key: 'autonomicNeuropathyType', section: 'complications', label: 'Autonomic neuropathy type', type: 'text', re: /type/, parent: 'autonomicNeuropathy' },
  { key: 'stroke', section: 'complications', label: 'Stroke', type: 'yesno', re: /stroke|cva/ },
  { key: 'abnormalGait', section: 'complications', label: 'Abnormal gait', type: 'yesno', re: /abnormal gait/ },
  { key: 'paralysis', section: 'complications', label: 'Paralysis', type: 'yesno', re: /paralysis/ },
  { key: 'mi', section: 'complications', label: 'Heart attack (MI)', type: 'yesno', re: /mi\s*\/\s*heart attack|heart attack|myocardial infarction|\bmi\b/ },
  { key: 'cad', section: 'complications', label: 'Coronary artery disease (CAD)', type: 'yesno', re: /cad|coronary artery disease/ },
  { key: 'angina', section: 'complications', label: 'Angina', type: 'yesno', re: /angina/ },
  { key: 'pvd', section: 'complications', label: 'Peripheral vascular disease (PVD)', type: 'yesno', re: /pvd|pad|peripheral (?:vascular|arterial) disease/ },
  { key: 'amputation', section: 'complications', label: 'Amputation', type: 'yesno', re: /amputation/ },
  { key: 'amputationPart', section: 'complications', label: 'Amputation (part)', type: 'text', re: /part/, parent: 'amputation' },
  // admissions & immunisation
  { key: 'previousHospitalization', section: 'admissions', label: 'Previous hospital admissions', type: 'text', re: /previous hospitali[sz]ations?|past admissions?/ },
  { key: 'dka', section: 'admissions', label: 'Diabetic ketoacidosis (DKA)', type: 'yesno', re: /dka|diabetic ketoacidosis/ },
  { key: 'dkaDate', section: 'admissions', label: 'DKA date', type: 'text', re: /date/, parent: 'dka' },
  { key: 'vaccineHepB', section: 'admissions', label: 'Hepatitis B vaccine', type: 'text', re: /hepatitis b|hep\.? ?b/ },
  { key: 'vaccineInfluenza', section: 'admissions', label: 'Influenza vaccine', type: 'text', re: /influenza|flu vaccine/ },
  { key: 'vaccinePneumococcal', section: 'admissions', label: 'Pneumococcal vaccine', type: 'text', re: /pneumococcal/ },
  { key: 'vaccineOther', section: 'admissions', label: 'Other vaccines', type: 'text', re: /other vaccines?/ },
  // general examination & vitals
  { key: 'generalAppearance', section: 'general', label: 'General appearance', type: 'text', re: /general appearance/ },
  { key: 'pulse', section: 'general', label: 'Pulse (per minute)', type: 'number', re: /pulse(?: rate)?(?:\s*\/\s*min(?:ute)?)?/, min: 20, max: 250 },
  { key: 'bpSitting', section: 'general', label: 'BP sitting (mmHg)', type: 'bp', re: /bp\s*(?:\(mm ?hg\))?\s*(?:sitting|seating)|blood pressure\s*(?:\(mm ?hg\))?\s*(?:sitting|seating)?|bp/ },
  { key: 'bpSupine', section: 'general', label: 'BP supine (mmHg)', type: 'bp', re: /bp\s*(?:\(mm ?hg\))?\s*supine|blood pressure\s*(?:\(mm ?hg\))?\s*supine/ },
  { key: 'abi', section: 'general', label: 'Ankle-brachial index', type: 'number', re: /ankle.?brachial index|\babi\b/, min: 0.2, max: 2 },
  { key: 'heightCm', section: 'general', label: 'Height (cm)', type: 'number', re: /height/, min: 50, max: 250, flat: true },
  { key: 'weightKg', section: 'general', label: 'Weight (kg)', type: 'number', re: /(?:body )?weight/, min: 2, max: 400, flat: true },
  { key: 'waistCm', section: 'general', label: 'Waist circumference (cm)', type: 'number', re: /waist(?: circumference)?/, min: 30, max: 250 },
  { key: 'hipCm', section: 'general', label: 'Hip circumference (cm)', type: 'number', re: /hip(?: circumference)?/, min: 30, max: 250 },
  { key: 'mood', section: 'general', label: 'Mood', type: 'select', re: /mood/,
    options: [['normal', 'Normal'], ['anxiety', 'Anxiety'], ['depression', 'Depression'], ['bipolar', 'Bipolar disorder']] },
  { key: 'jaundice', section: 'general', label: 'Jaundice', type: 'presence', re: /jaundice|icterus/ },
  { key: 'anemia', section: 'general', label: 'Anaemia (pallor)', type: 'presence', re: /ana?emia|pallor/ },
  { key: 'cyanosis', section: 'general', label: 'Cyanosis', type: 'presence', re: /cyanosis/ },
  { key: 'oedema', section: 'general', label: 'Oedema', type: 'presence', re: /o?edema/ },
  { key: 'lymphadenopathy', section: 'general', label: 'Lymphadenopathy', type: 'presence', re: /lymphadenopathy/ },
  { key: 'nails', section: 'general', label: 'Nails', type: 'text', re: /nails/ },
  { key: 'teeth', section: 'general', label: 'Teeth', type: 'text', re: /teeth/ },
  { key: 'gums', section: 'general', label: 'Gums', type: 'text', re: /gums/ },
  // feet
  { key: 'footSize', section: 'foot', label: 'Foot size', type: 'text', re: /(?:foot |shoe )?size/ },
  { key: 'footShape', section: 'foot', label: 'Foot shape', type: 'text', re: /(?:foot )?shape/ },
  { key: 'flatFoot', section: 'foot', label: 'Flat foot', type: 'presence', re: /flat ?foot/ },
  { key: 'hammerToes', section: 'foot', label: 'Hammer toes', type: 'presence', re: /hammer ?toes?/ },
  { key: 'footDiscoloration', section: 'foot', label: 'Discolouration', type: 'presence', re: /discolou?ration/ },
  { key: 'corn', section: 'foot', label: 'Corn', type: 'presence', re: /corns?/ },
  { key: 'callus', section: 'foot', label: 'Callus', type: 'presence', re: /callo?us(?:es)?/ },
  { key: 'footUlcer', section: 'foot', label: 'Ulceration', type: 'presence', re: /ulceration|foot ulcer|ulcer/ },
  { key: 'fissures', section: 'foot', label: 'Fissures', type: 'presence', re: /fissures?/ },
  { key: 'tineaPedis', section: 'foot', label: 'Tinea pedis', type: 'presence', re: /tinea pedis/ },
  { key: 'gangrene', section: 'foot', label: 'Gangrene', type: 'presence', re: /gangrene/ },
  { key: 'dorsalisPedis', section: 'foot', label: 'Dorsalis pedis pulse', type: 'presence', re: /dorsalis pedis(?: pulse)?/ },
  { key: 'posteriorTibial', section: 'foot', label: 'Posterior tibial pulse', type: 'presence', re: /posterior tibial(?: pulse)?/ },
  { key: 'footTemperature', section: 'foot', label: 'Temperature of foot', type: 'select', re: /temperature of (?:the )?foot|foot temperature/,
    options: [['normal', 'Normal'], ['warm', 'Warm'], ['cold', 'Cold']] },
  { key: 'claudication', section: 'foot', label: 'Claudication', type: 'presence', re: /claudication/ },
  // skin & systems
  { key: 'acanthosis', section: 'systemic', label: 'Acanthosis nigricans', type: 'presence', re: /acanthosis(?: nigricans)?/ },
  { key: 'skinTags', section: 'systemic', label: 'Skin tags', type: 'presence', re: /skin tags?/ },
  { key: 'lipohypertrophy', section: 'systemic', label: 'Lipohypertrophy at insulin sites', type: 'presence', re: /lipohypertrophy(?: on insulin injection site)?/ },
  { key: 'tinea', section: 'systemic', label: 'Tinea (site)', type: 'text', re: /tinea(?! pedis)/ },
  { key: 'heartSounds', section: 'systemic', label: 'Heart sounds', type: 'text', re: /heart sounds?/ },
  { key: 'murmur', section: 'systemic', label: 'Murmur', type: 'text', re: /murmurs?/ },
  { key: 'liver', section: 'systemic', label: 'Liver', type: 'select', re: /liver/, options: [['palpable', 'Palpable'], ['non-palpable', 'Not palpable']] },
  { key: 'spleen', section: 'systemic', label: 'Spleen', type: 'select', re: /spleen/, options: [['palpable', 'Palpable'], ['non-palpable', 'Not palpable']] },
  { key: 'involuntaryMovements', section: 'systemic', label: 'Involuntary muscle movements', type: 'presence', re: /involuntary(?: muscle)? movements?/ },
  { key: 'tremors', section: 'systemic', label: 'Tremors', type: 'presence', re: /tremors?/ },
];

export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
export const FLAT_KEYS = new Set(FIELDS.filter((f) => f.flat).map((f) => f.key).concat(['sbp', 'dbp']));

// ------------------------------------------------------------------ value parsing
const YES = /^(?:yes|y|present|positive|\+ve|\+)$/i;
const NO = /^(?:no|n|nil|none|absent|negative|-ve|not present)$/i;
// "Yes/No", "present/absent", "(Normal/Anxiety/Depression)": an unfilled option list.
const OPTION_LIST = /^\(?\s*[a-z][a-z .\-]*(?:\s*\/\s*[a-z][a-z .\-]*)+\s*\)?\s*$/i;
const BLANK = /^[\s_.:\-–—]*$/;

function firstWord(v) {
  const m = v.trim().match(/^([+\-]?ve|[+]|not present|[a-z]+)(?=$|[\s,.;)]|\s*-)/i);
  if (!m) return null;
  if (/^\s*\//.test(v.trim().slice(m[0].length))) return null; // "Yes/No"
  return m[1];
}

function yesNo(v) {
  const w = firstWord(v);
  if (!w) return null;
  if (YES.test(w)) return 'yes';
  if (NO.test(w)) return 'no';
  return null;
}

function parseValue(f, raw) {
  const v = raw.replace(/^[\s:\-–—=]+/, '').trim();
  if (BLANK.test(v)) return null;
  switch (f.type) {
    case 'yesno': return yesNo(v);
    case 'presence': { const y = yesNo(v); return y === 'yes' ? 'present' : y === 'no' ? 'absent' : null; }
    case 'number': {
      if (OPTION_LIST.test(v)) return null;
      const m = v.match(/^(?:[a-z ()/]*?)(\d+(?:\.\d+)?)/i);
      if (!m) return null;
      let n = parseFloat(m[1]);
      const ftIn = f.key === 'heightCm' && v.match(/(\d)\s*(?:ft|feet|foot|')\s*(?:(\d{1,2}(?:\.\d)?)\s*(?:in|inch(?:es)?|")?)?/i);
      if (ftIn) n = Math.round((+ftIn[1] * 12 + (+ftIn[2] || 0)) * 2.54);
      else if (f.key === 'heightCm' && n > 1 && n < 2.5) n = Math.round(n * 100); // metres
      if (f.key === 'heightCm' && /\bin(?:ch(?:es)?)?\b/i.test(v) && n < 100) n = Math.round(n * 2.54);
      if (f.key === 'weightKg' && /\b(?:lb|lbs|pounds?)\b/i.test(v)) n = Math.round(n * 0.4536 * 10) / 10;
      if (/^(?:waist|hip)Cm$/.test(f.key) && /\b(?:in|inch(?:es)?)\b/i.test(v)) n = Math.round(n * 2.54);
      return n >= (f.min ?? -Infinity) && n <= (f.max ?? Infinity) ? n : null;
    }
    case 'year': { const m = v.match(/\b(19[3-9]\d|20[0-9]\d)\b/); return m ? +m[1] : null; }
    case 'bp': {
      const m = v.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/);
      if (!m) return null;
      const s = +m[1]; const d = +m[2];
      return s >= 60 && s <= 260 && d >= 30 && d <= 160 && s > d ? `${s}/${d}` : null;
    }
    case 'select': {
      if (OPTION_LIST.test(v)) return null;
      const t = v.toLowerCase();
      if (f.key === 'diabetesType') {
        if (/\b(?:type\s*(?:1|i)\b|t1dm|iddm)/.test(t)) return 'type1';
        if (/\b(?:type\s*(?:2|ii)\b|t2dm|niddm)/.test(t)) return 'type2';
        if (/gestational|gdm/.test(t)) return 'gestational';
        if (/pre-?diabet|ifg|igt/.test(t)) return 'prediabetes';
        return null;
      }
      if (/^(?:liver|spleen)$/.test(f.key)) return /non[- ]?palpable|not palpable/.test(t) ? 'non-palpable' : /^palpable/.test(t) ? 'palpable' : null;
      for (const [val, label] of f.options) if (t.startsWith(val) || t.startsWith(label.toLowerCase())) return val;
      return null;
    }
    default: { // text
      if (OPTION_LIST.test(v)) return null;
      let t = v.replace(/\s{2,}/g, ' ').trim();
      // "Hypertension Date Detected: 2018" → "Hypertension (detected 2018)"; a bare "Date Detected:" is an empty form cell.
      t = t.replace(/\s*date detected\s*:\s*(.*)$/i, (_, d) => (d.trim() ? ` (detected ${d.trim()})` : '')).trim();
      if (/^[a-z][a-z .()/]*:\s*$/i.test(t) || BLANK.test(t)) return null;
      if (/^(?:nails|teeth|gums)$/.test(f.key) && /^n(?:ormal)?\.?$/i.test(t)) return 'Normal';
      if (f.key === 'allergies') { const y = yesNo(t); if (y === 'no' && t.length < 6) return 'None known'; if (y === 'yes' && t.length < 5) return 'Yes (details not recorded)'; }
      if (t.length < 1 || t.length > 200 || /^(?:yes|no)\s*\/\s*(?:yes|no)/i.test(t)) return null;
      return t;
    }
  }
}

/** "Yes  Cigarettes  10 /day since  15 years" → status, form, amount, years. */
function parseHabit(kind, raw) {
  const status = yesNo(raw.replace(/^[\s:\-–—=]+/, ''));
  if (!status) return [];
  const out = [[`${kind}Status`, status]];
  if (status === 'no') return out;
  const forms = { smoking: /\b(bidis?|beedis?|cigarettes?|cigars?|hukka|hookah|pipe)\b/i, alcohol: /\b(whisky|whiskey|wine|beer|rum|vodka|gin|brandy|toddy|country liquor)\b/i, tobacco: null };
  const fm = forms[kind] && raw.match(forms[kind]);
  if (fm) out.push([`${kind}Form`, fm[1].toLowerCase()]);
  const amount = kind === 'alcohol' ? raw.match(/(\d+(?:\.\d+)?)\s*ml\s*(?:\/|per)?\s*(?:a\s*)?week/i) : raw.match(/(\d+(?:\.\d+)?)\s*(?:\/|per|a)\s*day/i);
  if (amount) out.push([kind === 'alcohol' ? 'alcoholMlWeek' : `${kind}PerDay`, parseFloat(amount[1])]);
  const yrs = raw.match(/(?:since|for)\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)/i) || raw.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?)/i);
  if (yrs) out.push([`${kind}Years`, parseFloat(yrs[1])]);
  return out;
}

const LABELLED = FIELDS.filter((f) => f.re);
// Longest, most specific label first (e.g. "BP supine" before "BP", "Tinea pedis" before "Tinea").
const ORDERED = [...LABELLED].sort((a, b) => b.re.source.length - a.re.source.length);
const PAGE_MARK = [/^\s*(\d{1,3})\s*\|\s*p\s*a\s*g\s*e\b/i, /^\s*page\s*(\d{1,3})(?:\s*(?:of|\/)\s*\d+)?\s*$/i, /^\s*-\s*(\d{1,3})\s*-\s*$/];

function matchLabel(seg, lastParent, lineNo) {
  const s = seg.replace(/^\s*(?:\d{1,2}[.)]|[•\-*])\s*/, ''); // "1. Flat Foot:" / "- Smoking:"
  for (const f of ORDERED) {
    if (f.parent && !(lastParent && lastParent.key === f.parent && lineNo - lastParent.line <= 3)) continue;
    const re = new RegExp(`^(?:${f.re.source})\\b\\s*(?:\\([^)]*\\))?`, 'i');
    const m = s.match(re);
    if (!m) continue;
    const rest = s.slice(m[0].length);
    // Free-text and generic labels need an explicit separator ("Liver: palpable"), so that
    // headings such as "Liver Function Test" or "Family Medicine" are not read as values.
    const sep = /^\s*[:\-–=]/.test(rest);
    if (!sep && (f.type === 'text' || f.type === 'select' || f.parent) && !/^(?:liver|spleen|mood)$/.test(f.key)) continue;
    if (!sep && /^[a-z]/i.test(rest.trim()) && f.type !== 'yesno' && f.type !== 'presence' && f.type !== 'select') continue;
    return { f, rest };
  }
  return null;
}

/**
 * Profile facts printed in a document.
 * Returns [{ key, value, printed, page }] — one per field, first occurrence wins.
 */
export function extractProfileFacts(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const found = new Map();
  let page = null;
  let lastParent = null;
  const add = (key, value, printed) => { if (value != null && value !== '' && !found.has(key)) found.set(key, { key, value, printed: printed.trim().replace(/\s{2,}/g, ' '), page }); };

  lines.forEach((line, i) => {
    for (const re of PAGE_MARK) { const m = line.match(re); if (m) { page = +m[1]; return; } }
    // Two-column layouts put two "Label value" cells on one line, separated by wide gaps.
    const segs = line.replace(/\|/g, '   ').split(/\t|\s{3,}/).map((s) => s.trim()).filter(Boolean);
    for (let j = 0; j < segs.length; j++) {
      const hit = matchLabel(segs[j], lastParent, i);
      if (!hit) continue;
      const { f } = hit;
      let rest = hit.rest;
      // Value in the next cell of the same line ("Pulse Rate/minute      78").
      let cell = segs[j];
      if (BLANK.test(rest) && segs[j + 1] && !matchLabel(segs[j + 1], lastParent, i)) { rest = segs[j + 1]; cell += ' ' + segs[j + 1]; j++; }
      if (!f.parent) lastParent = { key: f.key, line: i };
      if (f.habit) {
        // The habit line continues onto the next line on many forms ("/day since 10 years").
        const tail = lines[i + 1] && !matchLabel(lines[i + 1].trim(), null, i + 1) ? ' ' + lines[i + 1] : '';
        for (const [k, v] of parseHabit(f.habit, rest + tail)) add(k, v, cell + (k.endsWith('Status') ? '' : tail));
        continue;
      }
      add(f.key, parseValue(f, rest), cell);
    }
  });
  return [...found.values()];
}

// ------------------------------------------------------------------ profile
const today = () => new Date().toISOString().slice(0, 10);

export function getValue(prof, key) {
  if (key === 'bpSitting') return prof.sbp && prof.dbp ? `${prof.sbp}/${prof.dbp}` : (prof.record?.bpSitting ?? null);
  return FLAT_KEYS.has(key) ? prof[key] ?? null : prof.record?.[key] ?? null;
}

const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * What applying `fact` from a document dated `date` would do to the profile:
 * 'new' (field empty), 'same', 'update' (replaces a value from an older document),
 * 'older' (the profile has a value from a newer document) or 'manual' (typed in by hand).
 */
export function compareFact(prof, fact, date) {
  const cur = getValue(prof, fact.key);
  if (cur == null || cur === '') return 'new';
  if (same(cur, fact.value)) return 'same';
  const src = prof.sources?.[fact.key];
  if (!src || src.kind === 'manual') return 'manual';
  return (src.date || '') > (date || '') ? 'older' : 'update';
}

/** Apply chosen facts to a copy of the profile; each value remembers the document it came from. */
export function applyFacts(prof, facts, source) {
  const p = { ...prof, record: { ...(prof.record || {}) }, sources: { ...(prof.sources || {}) }, conditions: { ...(prof.conditions || {}) } };
  const cite = (key, fact) => { p.sources[key] = { ...source, printed: fact.printed, page: fact.page ?? null }; };
  for (const fact of facts) {
    const f = FIELD[fact.key];
    if (!f) continue;
    if (fact.key === 'bpSitting') {
      const [s, d] = String(fact.value).split('/').map(Number);
      if (s && d) { p.sbp = s; p.dbp = d; cite('sbp', fact); cite('dbp', fact); }
      p.record.bpSitting = fact.value; cite('bpSitting', fact);
      continue;
    }
    if (f.flat) p[fact.key] = fact.value; else p.record[fact.key] = fact.value;
    cite(fact.key, fact);
    if ((fact.key === 'heightCm' || fact.key === 'weightKg') && (!p.measuredOn || (source.date || '') >= p.measuredOn)) p.measuredOn = source.date || p.measuredOn;
  }
  return syncDerived(p);
}

/** Keep the older summary fields (conditions, smoking, alcohol) in step with the detailed record. */
export function syncDerived(p) {
  const r = p.record || {};
  const c = (p.conditions = { ...(p.conditions || {}) });
  if (r.diabetesType || r.diabetesYear) c.diabetes = true;
  if (r.ckd === 'yes') c.ckd = true;
  if (r.mi === 'yes' || r.cad === 'yes' || r.angina === 'yes' || r.stroke === 'yes') c.heart = true;
  if (/hypertension|\bhtn\b|high blood pressure/i.test(r.associatedDiseases || '')) c.hypertension = true;
  if (/hypothyroid|hyperthyroid|thyroid/i.test(r.associatedDiseases || '')) c.thyroid = true;
  if (r.smokingStatus === 'yes') p.smoking = 'current';
  else if (r.smokingStatus === 'no' && !p.smoking) p.smoking = 'never';
  if (r.alcoholStatus === 'yes' && (!p.alcohol || p.alcohol === 'none')) p.alcohol = 'regular';
  else if (r.alcoholStatus === 'no' && !p.alcohol) p.alcohol = 'none';
  return p;
}

/** Values worked out from the record (not stored). */
export function derived(p) {
  const r = p.record || {};
  const out = {};
  if (r.waistCm && r.hipCm) out.whr = Math.round((r.waistCm / r.hipCm) * 100) / 100;
  if (r.diabetesYear) out.diabetesDuration = new Date().getFullYear() - r.diabetesYear;
  if (r.smokingStatus === 'yes' && /cigarette/.test(r.smokingForm || '') && r.smokingPerDay && r.smokingYears) out.packYears = Math.round((r.smokingPerDay / 20) * r.smokingYears * 10) / 10;
  if (p.sbp && r.bpSupine) {
    const [ss] = String(r.bpSupine).split('/').map(Number);
    if (ss) out.posturalDrop = ss - p.sbp;
  }
  return out;
}

export function displayValue(key, value) {
  const f = FIELD[key];
  if (value == null || value === '') return '—';
  if (f?.options) return f.options.find(([v]) => v === value)?.[1] || value;
  if (f?.type === 'yesno') return value === 'yes' ? 'Yes' : value === 'no' ? 'No' : value;
  if (f?.type === 'presence') return value === 'present' ? 'Present' : value === 'absent' ? 'Absent' : value;
  return String(value);
}

export const manualSource = () => ({ kind: 'manual', date: today() });
