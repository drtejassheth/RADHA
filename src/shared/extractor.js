// Turns parser output (plain text or Markdown from pdfplumber / Docling / Marker / EasyOCR / Sarvam)
// into structured rows: patient metadata + one row per biomarker with value, unit and reference range.
import { BIOMARKERS, BY_KEY, toCanonical, defaultRange, classify, round } from './biomarkers.js';

// Optional numbering and specimen prefix ("1. Serum S.G.P.T", "Plasma Glucose …").
const PREFIX = String.raw`^[\s|*•·\-]*(?:\d{1,3}[.)]\s+)?(?:(?:serum|plasma|whole blood|blood|s\.)\s+)?`;

const MATCHERS = BIOMARKERS.flatMap((b) =>
  b.aliases.map((a) => ({ key: b.key, re: new RegExp(`${PREFIX}(${a})(?![a-z0-9])`, 'i') })),
);

const NUM = String.raw`\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+`;
const RANGE_RE = new RegExp(String.raw`(${NUM})\s*(?:-|–|—|to)\s*(${NUM})`, 'i');
const UPPER_RE = new RegExp(String.raw`(?:<=?|≤|less than|upto|up to|below)\s*(${NUM})`, 'i');
const LOWER_RE = new RegExp(String.raw`(?:>=?|≥|more than|greater than|above)\s*(${NUM})`, 'i');
const VALUE_RE = new RegExp(String.raw`(?:^|[\s:=|])([<>≤≥]?)\s*(${NUM})(?![\d.]*\s*(?:-|–|to)\s*\d)`);
const FLAG_RE = /^\s*(\*|HH|LL|H|L|High|Low|Critical|Abnormal)\b/i;
const UNIT_RE = /^\s*((?:x\s*)?10\s*(?:\^|\*\*)?\s*[0-9³⁶]+\s*\/\s*[a-zµμ.]+|[a-zµμ%/][a-zµμ0-9%./^²³*]*(?:\s*\/\s*[a-z0-9µμ.²³]+(?:\s?1\.73\s?m[²2])?)?)/i;
const NOT_UNIT = /^(h|l|hh|ll|high|low|normal|critical|abnormal|method|by|ref|range|serum|plasma|blood|whole|edta)$/i;

const NEXT_RANGE_RE = /^\s*(bio\.?\s*ref|ref(erence)?\s*(range|interval)|normal|adult|desirable)/i;
const num = (s) => (s == null ? null : parseFloat(String(s).replace(/,/g, '')));

/** Flatten Markdown / HTML tables into whitespace-separated lines. */
export function cleanText(raw) {
  return String(raw || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // embedded (base64) images in Markdown output
    .replace(/<\/(td|th)>/gi, '  ')
    .replace(/<\/tr>|<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-z][a-z0-9]*\b[^<>\n]*>/gi, ' ') // real tags only — "< 200 … > 40" ranges must survive
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .split('\n')
    .filter((l) => !/^\s*\|?\s*:?-{3,}/.test(l)) // markdown table separators
    .map((l) => l.replace(/\s*\|\s*/g, '   ').replace(/\*\*/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

// Labs often print decision limits ("Deficiency < 20", "High Risk > 160") instead of a reference
// interval. Only ranges that are unlabelled or labelled as normal/desirable count as the reference range.
const BAD_LABEL = /(deficien|insufficien|toxic|borderline|(?<!no\s?)risk|(?<!non[\s\-]?)(pre[\s\-]?)?diabet|very high|\bhigh\b|\belevated|\bpoor\b|\bsevere|\bmoderate)/i;
const GOOD_LABEL = /(normal|desirable|optimal|non[\s\-]?diabetic|(?<!in)sufficien|no\s?risk|reference|adult|male|female|ideal)/i;

const ANY_RANGE_RE = new RegExp(String.raw`(${NUM})\s*(?:-|–|—|to)\s*(${NUM})|(?:<=?|≤|less than|upto|up to|below)\s*(${NUM})|(?:>=?|≥|more than|greater than|above)\s*(${NUM})`, 'gi');

/**
 * Pick the reference interval from a reference cell. A cell may hold several labelled bands
 * ("Desirable: < 200 Borderline High: 200-239 High: >= 240"); the first band that is unlabelled
 * or labelled normal/desirable/sufficient wins, and decision limits such as "Deficiency < 20" are skipped.
 */
export function findRange(text) {
  ANY_RANGE_RE.lastIndex = 0;
  let prevEnd = 0;
  let m;
  while ((m = ANY_RANGE_RE.exec(text))) {
    const label = text.slice(prevEnd, m.index);
    prevEnd = m.index + m[0].length;
    const labelled = /[a-z]{3}/i.test(label);
    if (labelled && BAD_LABEL.test(label) && !GOOD_LABEL.test(label)) continue;
    const rest = text.slice(prevEnd);
    if (m[1] != null) return { low: num(m[1]), high: num(m[2]), rest };
    if (m[3] != null) return { low: null, high: num(m[3]), rest };
    return { low: num(m[4]), high: null, rest };
  }
  return { low: null, high: null, rest: prevEnd ? text.slice(prevEnd) : text };
}

/** Parse the portion of a line after the test name into value / unit / range / flag. */
export function parseMeasurement(rest) {
  // Drop parenthetical method/specimen notes that precede the value, e.g. "(Serum, CLIA)".
  let s = rest.replace(/^[\s:,\-–=]*/, '').replace(/^\((?=[^)]*[a-z])[^)]*\)\s*/i, '').replace(/^[\s:,\-–=]*/, '');
  const m = VALUE_RE.exec(' ' + s);
  if (!m) return null;
  const qualifier = m[1] || '';
  const value = num(m[2]);
  // Text before the value should be short (method words); otherwise it's probably not a result line.
  const before = (' ' + s).slice(0, m.index).trim();
  if (before.length > 40) return null;
  let after = (' ' + s).slice(m.index + m[0].length);

  let flag = null;
  const f = FLAG_RE.exec(after);
  if (f) { flag = f[1]; after = after.slice(f[0].length); }

  let unit = '';
  const u = UNIT_RE.exec(after);
  if (u && !NOT_UNIT.test(u[1].trim())) { unit = u[1].replace(/\s+/g, ''); after = after.slice(u[0].length); }

  const range = findRange(after);
  let { low, high } = range;
  after = range.rest;

  if (!unit) {
    const u2 = UNIT_RE.exec(after); // some labs print the unit after the range
    if (u2 && !NOT_UNIT.test(u2[1].trim())) unit = u2[1].replace(/\s+/g, '');
  }
  if (!flag) {
    const f2 = /\b(High|Low|H|L)\s*$/i.exec(after);
    if (f2) flag = f2[1];
  }
  return { value, qualifier, unit, low, high, flag };
}

function matchBiomarker(line) {
  let best = null;
  for (const { key, re } of MATCHERS) {
    const m = re.exec(line);
    if (m && (!best || m[0].length > best.len)) best = { key, len: m[0].length, name: m[1] };
  }
  return best;
}

const GENERIC_RE = new RegExp(String.raw`^([A-Za-z][A-Za-z0-9 ()/%,.'\-]{2,48}?)\s{1,}[:\-]?\s*([<>]?\s*(?:${NUM}))\s*(\S{0,14})\s+(${NUM})\s*(?:-|–|to)\s*(${NUM})`);
const GENERIC_SKIP = /\b(page|date|age|sex|gender|phone|mobile|reg|uhid|id|no\.?|time|ref(erred)?|dr\.?|pin|years?)\b/i;

export function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Extract patient metadata from the report header. */
export function extractPatient(text) {
  const t = text.slice(0, 4000);
  const p = { name: '', age: null, sex: '', date: '', patientId: '', lab: '', dob: '', heightCm: null, weightKg: null };
  const DATE = String.raw`(\d{1,2}[\/\-.\s](?:\d{1,2}|[A-Za-z]{3,9})[\/\-.\s,]*\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})`;

  const nm = /(?:patient(?:'s)?\s*name|name\s*of\s*(?:the\s*)?patient|^\s*(?:patient(?=\s*[:\-])|name))\s*[:\-]\s*(?:(?:mr|mrs|ms|miss|dr|master|baby|smt|shri)\.?\s+)?([A-Za-z][A-Za-z.' ]{1,60}?)(?=\s{2,}|\s+\d|\s*\(|\s+(?:age|sex|gender|uhid|patient|ref|date|lab|sample|reg|id|mrn)\b|\s*[|,]|$)/im.exec(t);
  if (nm) p.name = nm[1].trim().replace(/\s+/g, ' ');
  if (!p.name) {
    // "Last Name: Mehta   First Name: Dr Arjun"
    const ln = /last\s*name\s*[:\-]\s*([A-Za-z][A-Za-z.' ]{0,40}?)(?=\s{2,}|\s*first\s*name|$)/im.exec(t);
    const fn = /first\s*name\s*[:\-]\s*(?:(?:mr|mrs|ms|miss|dr|smt|shri)\.?\s+)?([A-Za-z][A-Za-z.' ]{0,40}?)(?=\s{2,}|\s*last\s*name|$)/im.exec(t);
    if (fn || ln) p.name = [fn?.[1], ln?.[1]].filter(Boolean).join(' ').trim().replace(/\s+/g, ' ');
  }

  const dob = new RegExp(String.raw`(?:date\s*of\s*birth|\bd\.?o\.?b\.?)\s*[:\-]?\s*` + DATE, 'i').exec(t);
  if (dob) p.dob = parseDate(dob[1]) || '';
  const ht = /\bheight\s*[:\-]?\s*(\d{2,3}(?:\.\d+)?)\s*cm/i.exec(t);
  if (ht) p.heightCm = parseFloat(ht[1]);
  const wt = /\bweight\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*kg/i.exec(t);
  if (wt) p.weightKg = parseFloat(wt[1]);

  const ag = /\bage\b(?:\s*\/\s*(?:sex|gender))?\s*[:\-]?\s*(\d{1,3})\s*(?:y(?:ea)?r?s?\.?|y\b)?(?:\s*\/\s*(male|female|m|f)\b)?/i.exec(t);
  if (ag) { p.age = parseInt(ag[1], 10); if (ag[2]) p.sex = ag[2][0].toUpperCase(); }

  if (p.age == null) {
    const ys = /\((\d{1,3})\s*y(?:rs?|ears?)?\s*\/\s*(m|f|male|female)\)/i.exec(t);
    if (ys) { p.age = parseInt(ys[1], 10); p.sex = ys[2][0].toUpperCase(); }
  }
  if (!p.sex) {
    const sx = /\b(?:sex|gender)\s*[:\-]?\s*(male|female|m|f)\b/i.exec(t) || /\b\d{1,3}\s*(?:y|yrs|years)\s*[\/,]\s*(male|female|m|f)\b/i.exec(t);
    if (sx) p.sex = sx[1][0].toUpperCase();
  }

  // Report date: never the date of birth; look past the header if the first page has none.
  const DATE_RE = new RegExp(String.raw`(?:collect(?:ed|ion)|sample(?:\s*(?:date|drawn|received))?|reported|report\s*date|registered|registration|receiv(?:ed|ing)|date)[^:\n]{0,20}\n?\s*[:\-]\s*` + DATE, 'i');
  const noDob = (x) => x.replace(/(?:date\s*of\s*birth|\bd\.?o\.?b\.?)[^\n]*/gi, '');
  const dt = DATE_RE.exec(noDob(t)) || DATE_RE.exec(noDob(text));
  if (dt) p.date = parseDate(dt[1]) || '';
  if (p.age == null && p.dob && p.date) p.age = Math.floor((new Date(p.date) - new Date(p.dob)) / (365.25 * 864e5));

  const id = /(?:\buid\b|uhid|identification|patient\s*id|mrn|reg(?:istration)?\.?\s*no|lab\s*no|sample\s*id)\s*[:\-.]?\s*([A-Za-z0-9][A-Za-z0-9\-\/]{2,})/i.exec(t);
  if (id) p.patientId = id[1];

  return p;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Parse report dates (Indian dd/mm/yyyy convention first) into ISO yyyy-mm-dd. */
export function parseDate(s) {
  if (!s) return null;
  s = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[\/\-.\s]([A-Za-z]{3,9})[\/\-.\s,]*(\d{2,4})/.exec(s);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!mon) return null;
    return iso(m[3], mon, m[1]);
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mon ? iso(m[3], mon, m[2]) : null;
  }
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(s);
  if (m) {
    let d = +m[1], mo = +m[2];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d]; // mm/dd/yyyy
    return iso(m[3], mo, d);
  }
  return null;
}

function iso(y, mo, d) {
  y = +y; if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Build a verified-ready row (canonical units, range, status) from raw parsed fields.
 * Used both by the extractor and when the user edits a row on the verification screen.
 */
export function buildRow({ key, rawName, value, unit = '', low = null, high = null, qualifier = '', flag = null, source = 'parsed' }, sex) {
  const b = BY_KEY[key];
  let canon = { value, low, high, converted: false, unitKnown: true };
  if (b) canon = toCanonical(key, value, unit, low, high);
  let rangeSource = 'report';
  let rLow = canon.low;
  let rHigh = canon.high;
  if (rLow == null && rHigh == null && b) {
    ({ low: rLow, high: rHigh } = defaultRange(key, sex));
    rangeSource = rLow == null && rHigh == null ? 'none' : 'default';
  }
  const { status, critical } = classify(key, canon.value, rLow, rHigh);
  return {
    key,
    name: b ? b.name : rawName,
    rawName: rawName || b?.name || key,
    panel: b ? b.panel : 'Other',
    rawValue: value,
    rawUnit: unit,
    rawLow: low,
    rawHigh: high,
    qualifier,
    flag,
    value: canon.value == null ? null : round(canon.value, 3),
    unit: b ? b.unit : unit,
    low: rLow == null ? null : round(rLow, 3),
    high: rHigh == null ? null : round(rHigh, 3),
    rangeSource,
    converted: canon.converted,
    unitWarning: b ? !canon.unitKnown : false,
    status,
    critical,
    source,
    include: true,
  };
}

/** Main entry point: text -> { patient, rows, unmatchedLines }. */
export function extractReport(rawText) {
  const text = cleanText(rawText);
  const patient = extractPatient(text);
  const rows = [];
  const seen = new Set();

  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.length < 3 || line.length > 220) continue;
    const hit = matchBiomarker(line);
    if (hit) {
      const meas = parseMeasurement(line.slice(hit.len));
      if (!meas || meas.value == null) continue;
      if (meas.low == null && meas.high == null) {
        for (const next of lines.slice(li + 1, li + 4)) {
          if (matchBiomarker(next)) break;
          if (!NEXT_RANGE_RE.test(next)) continue;
          ({ low: meas.low, high: meas.high } = findRange(next));
          if (meas.low != null || meas.high != null) break;
        }
      }
      let key = hit.key;
      const b = BY_KEY[key];
      // "Neutrophils 4.2 10^3/µL" is an absolute count, not a percentage.
      if (b.absoluteKey && meas.unit && meas.unit !== '%' && !/^%/.test(meas.unit)) key = b.absoluteKey;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(buildRow({ key, rawName: hit.name.trim(), ...meas }, patient.sex));
      continue;
    }
    const g = GENERIC_RE.exec(line);
    if (g && !GENERIC_SKIP.test(g[1])) {
      const name = g[1].trim().replace(/[\s:\-]+$/, '');
      const key = 'x:' + slug(name);
      if (seen.has(key) || name.length < 3) continue;
      seen.add(key);
      const unit = /[a-z%]/i.test(g[3]) ? g[3] : '';
      rows.push(buildRow({ key, rawName: name, value: num(g[2].replace(/[<>\s]/g, '')), unit, low: num(g[4]), high: num(g[5]) }, patient.sex));
    }
  }
  return { patient, rows, text };
}
