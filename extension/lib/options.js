// Options files: the native format (SPEC 5.1) and the LeechBlock NG import (SPEC 5.2).
// Pure module, no chrome.* APIs. Password fields from LeechBlock exports are never read.

export const FORMAT = 'brainrot-buddy-options';
const VERSION = 1;
const MAX_BUDGET = 1440;                 // minutes per day
const MAX_DELAY = 3600;                  // seconds
const DAILY = '86400';                   // LeechBlock limitPeriod meaning "per day"
const SITE_RE = /^(?=.*[a-z0-9])[a-z0-9*-]+(\.[a-z0-9*-]+)*$/;   // host pattern, '*' wildcards allowed
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isRange = (r) => Array.isArray(r) && r.length === 2 && typeof r[0] === 'string' && TIME_RE.test(r[0])
  && typeof r[1] === 'string' && TIME_RE.test(r[1]) && r[0] < r[1];
const allDayRanges = () => [['00:00', '24:00']];

export function newId() {
  return 'l_' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ALPHABET[b % 36]).join('');
}

// ---------- native format ----------

// A site entry: plain string or { site, dailyBudgetMinutes?, delaySeconds? }. Zero values are dropped.
function checkSite(raw, where, errors) {
  const e = typeof raw === 'string' ? { site: raw } : raw;
  if (!isObj(e)) { errors.push(`${where} must be a site name or an object`); return { site: '' }; }
  const site = typeof e.site === 'string' ? e.site.trim().toLowerCase() : '';
  if (!SITE_RE.test(site)) errors.push(`${where}: "${e.site}" is not a valid domain (e.g. youtube.com or xvideos.*)`);
  const num = (key, max) => {
    if (e[key] === undefined) return 0;
    if (isInt(e[key], 0, max)) return e[key];
    errors.push(`${where}.${key} must be a whole number from 0 to ${max}`);
    return 0;
  };
  const out = { site };
  const budget = num('dailyBudgetMinutes', MAX_BUDGET);
  const delay = num('delaySeconds', MAX_DELAY);
  if (budget) out.dailyBudgetMinutes = budget;
  if (delay) out.delaySeconds = delay;
  return out;
}

function checkSchedule(raw, where, errors) {
  if (!Array.isArray(raw)) { errors.push(`${where} must be an array`); return []; }
  return raw.map((item, k) => {
    const w = `${where}[${k}]`;
    if (!isObj(item)) { errors.push(`${w} must be an object`); return null; }
    const days = Array.isArray(item.days) && item.days.length > 0 && item.days.every((d) => isInt(d, 0, 6));
    const ranges = Array.isArray(item.ranges) && item.ranges.length > 0 && item.ranges.every(isRange);
    if (!days) errors.push(`${w}.days must be a non-empty list of day numbers, 0 (Sunday) to 6 (Saturday)`);
    if (!ranges) errors.push(`${w}.ranges must be a non-empty list of ["HH:MM", "HH:MM"] pairs with start before end`);
    return days && ranges ? { days: [...item.days], ranges: item.ranges.map((r) => [r[0], r[1]]) } : null;
  }).filter(Boolean);
}

function checkList(raw, where, errors) {
  if (!isObj(raw)) { errors.push(`${where} must be an object`); return null; }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const label = name ? `${where} "${name}"` : where;
  if (!name) errors.push(`${where}.name must be a non-empty string`);
  if (!Array.isArray(raw.sites)) errors.push(`${label}.sites must be an array`);
  const out = {
    name,
    sites: (Array.isArray(raw.sites) ? raw.sites : []).map((s, j) => checkSite(s, `${label}.sites[${j}]`, errors)),
  };
  if (raw.message !== undefined && typeof raw.message !== 'string') errors.push(`${label}.message must be text`);
  else if (raw.message?.trim()) out.message = raw.message.trim();
  if (raw.schedule !== undefined) {
    const schedule = checkSchedule(raw.schedule, `${label}.schedule`, errors);
    if (schedule.length) out.schedule = schedule;
  }
  return out;
}

/** Native options file => { ok:true, adultContentBlocked, lists (with fresh ids) } or { ok:false, errors }. */
export function validateOptions(obj) {
  if (!isObj(obj)) return { ok: false, errors: ['The file is not a JSON object'] };
  const errors = [];
  if (obj.format !== FORMAT) errors.push(`format must be "${FORMAT}"`);
  if (obj.version !== VERSION) errors.push(`unsupported version ${JSON.stringify(obj.version)}, expected ${VERSION}`);
  if (obj.adultContentBlocked !== undefined && typeof obj.adultContentBlocked !== 'boolean') {
    errors.push('adultContentBlocked must be true or false');
  }
  if (!Array.isArray(obj.lists)) errors.push('lists must be an array');
  const lists = Array.isArray(obj.lists) ? obj.lists.map((l, i) => checkList(l, `lists[${i}]`, errors)) : [];
  if (errors.length) return { ok: false, errors };
  return { ok: true, adultContentBlocked: obj.adultContentBlocked === true, lists: lists.map((l) => ({ id: newId(), ...l })) };
}

// ---------- LeechBlock NG import ----------

// '0900-1200,1300-1700' => { ranges: [['09:00','12:00'], ['13:00','17:00']], bad: [] }. Empty means all day.
function parseTimes(text) {
  if (!text) return { ranges: allDayRanges(), bad: [] };
  const ranges = [];
  const bad = [];
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d\d)(\d\d)-(\d\d)(\d\d)$/.exec(part);
    const range = m ? [`${m[1]}:${m[2]}`, `${m[3]}:${m[4]}`] : null;
    if (range && isRange(range)) ranges.push(range);
    else bad.push(part);
  }
  return { ranges, bad };
}

const isAllDay = (ranges) => ranges.length === 1 && ranges[0][0] === '00:00' && ranges[0][1] === '24:00';

// One numbered LeechBlock set => list without id, or null when the set is skipped. Problems go to warnings.
function convertSet(src, n, warnings) {
  const get = (field) => String(src[`${field}${n}`] ?? '').trim();
  const rawName = get('setName');
  const label = rawName ? `Set ${n} '${rawName}'` : `Set ${n}`;
  const warn = (msg) => warnings.push(`${label}: ${msg}`);

  const sitesText = get('sites');
  if (!sitesText) return null;                                  // empty set: skipped silently
  const sites = [];
  for (const token of sitesText.split(/\s+/)) {
    const site = token.split('/')[0].toLowerCase();              // drop any path part
    if (!SITE_RE.test(site)) warn(`skipped invalid site "${token}"`);
    else if (!sites.some((s) => s.site === site)) sites.push({ site });
  }
  if (!sites.length) { warn('no valid sites, skipped'); return null; }

  const flags = src[`days${n}`];                                // Sunday first, same as our day numbers
  if (!Array.isArray(flags) || flags.length !== 7) { warn('days are not 7 booleans, skipped'); return null; }
  const days = flags.flatMap((on, d) => (on === true ? [d] : []));
  if (!days.length) { warn('no days selected, skipped'); return null; }

  const { ranges, bad } = parseTimes(get('times'));
  bad.forEach((t) => warn(`time range "${t}" not understood, ignored`));
  if (!ranges.length) { warn('no usable time range, skipped'); return null; }

  let budget = null;
  const limit = get('limitMins');
  if (limit && limit !== '0') {
    const mins = Number(limit);
    if (!isInt(mins, 1, MAX_BUDGET)) warn(`limit "${limit}" not usable, ignored`);
    else if (get('limitPeriod') !== DAILY) warn(`limit period ${get('limitPeriod') || '(empty)'} is not daily, limit ignored`);
    else budget = mins;
  }

  // No schedule needed when the set is every day, all day (then the limit alone, or always blocked).
  const scheduled = !(days.length === 7 && isAllDay(ranges));
  if (scheduled && budget && src[`conjMode${n}`] !== true) {
    warn('schedule plus daily limit in "or" mode is not supported, imported as schedule only');
    budget = null;
  }

  let delay = 0;
  if (get('blockURL').startsWith('delayed.html')) {
    const secs = get('delaySecs') || '0';
    if (isInt(Number(secs), 0, MAX_DELAY)) delay = Number(secs);
    else warn(`delay "${secs}" not usable, ignored`);
  }

  if (budget && sites.length > 1) {
    warn(`LeechBlock shares the ${budget} min limit across ${sites.length} sites, copied to each site`);
  }
  for (const field of ['regexpBlock', 'regexpAllow', 'regexpKeyword']) {
    if (get(field)) warn(`${field} is not imported, check this set by hand`);
  }

  const extra = { ...(budget && { dailyBudgetMinutes: budget }), ...(delay && { delaySeconds: delay }) };
  const list = { name: rawName || `Set ${n}`, sites: sites.map((s) => ({ ...s, ...extra })) };
  if (scheduled) list.schedule = [{ days, ranges }];
  const message = get('customMsg');
  if (message) list.message = message;
  return list;
}

/** LeechBlock NG export => { lists (with fresh ids), warnings }. Passwords are never read. */
export function importLeechBlock(obj) {
  const warnings = [];
  const count = Number(obj?.numSets);
  if (!isInt(count, 0, 999)) return { lists: [], warnings: ['numSets is missing or invalid, nothing imported'] };
  const lists = [];
  for (let n = 1; n <= count; n++) {
    const list = convertSet(obj, n, warnings);
    if (list) lists.push({ id: newId(), ...list });
  }
  return { lists, warnings };
}

/** Detects the format: native file, LeechBlock export, or neither. */
export function importAny(obj) {
  if (isObj(obj) && obj.format === FORMAT) {
    const r = validateOptions(obj);
    return r.ok
      ? { ok: true, kind: 'native', lists: r.lists, adultContentBlocked: r.adultContentBlocked, warnings: [] }
      : { ok: false, kind: 'native', lists: [], warnings: [], errors: r.errors };
  }
  if (isObj(obj) && 'numSets' in obj) {
    const { lists, warnings } = importLeechBlock(obj);
    if (!lists.length) return { ok: false, kind: 'leechblock', lists, warnings, errors: ['No LeechBlock sets with sites were found'] };
    return { ok: true, kind: 'leechblock', lists, warnings };
  }
  return { ok: false, kind: null, lists: [], warnings: [], errors: ['Not a Brainrot Buddy or LeechBlock NG options file'] };
}

// ---------- export ----------

function toFileSite(s) {
  const e = typeof s === 'string' ? { site: s } : s;
  return {
    site: e.site,
    ...(e.dailyBudgetMinutes && { dailyBudgetMinutes: e.dailyBudgetMinutes }),
    ...(e.delaySeconds && { delaySeconds: e.delaySeconds }),
  };
}

// Only the file fields of a list: no id, no anything else.
function toFileList({ name, sites = [], message, schedule }) {
  const out = { name, sites: sites.map(toFileSite) };
  if (message) out.message = message;
  if (schedule?.length) out.schedule = schedule.map(({ days, ranges }) => ({ days: [...days], ranges: ranges.map((r) => [...r]) }));
  return out;
}

/** Native options file for the given config. No ids, pubKey, phase or companion URL. */
export function exportOptions(config) {
  return {
    format: FORMAT,
    version: VERSION,
    adultContentBlocked: config.adultContentBlocked === true,
    lists: (config.lists ?? []).map(toFileList),
  };
}
