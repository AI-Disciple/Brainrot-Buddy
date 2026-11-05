// Pure rule logic for Brainrot Buddy. No chrome.* APIs, so it is unit-testable.

const DELAY_FORGIVE_MS = 5 * 60 * 1000;

export function entryKey(list, entry) {
  return `${list.id}|${entry.site}`;
}

export function hostFromUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Pattern is host-only; without '*' it also matches subdomains; '*' is a glob.
export function hostMatchesPattern(host, pattern) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  const p = String(pattern).split('/')[0].trim().toLowerCase();
  if (!p) return false;
  if (!p.includes('*')) return h === p || h.endsWith('.' + p);
  const glob = p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^(?:.*\\.)?${glob}$`).test(h);
}

const toMinutes = t => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

// Empty/missing schedule = always active. Ranges are [start, end) and end may be '24:00'.
export function isScheduleActive(schedule, date) {
  if (!schedule?.length) return true;
  const day = date.getDay();
  const mins = date.getHours() * 60 + date.getMinutes();
  return schedule.some(s =>
    (s.days || []).includes(day) &&
    (s.ranges || []).some(([start, end]) => mins >= toMinutes(start) && mins < toMinutes(end)));
}

const pad = n => String(n).padStart(2, '0');

export function todayString(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function normalizeUsage(usage, now) {
  const today = todayString(new Date(now));
  return usage?.date === today && usage.minutes ? usage : { date: today, minutes: {} };
}

// Returns the matched domain (host itself or a parent domain) or null.
export function isAdultHost(host, adultSet) {
  if (!host || !adultSet) return null;
  const parts = String(host).toLowerCase().split('.');
  for (let i = 0; i < parts.length; i++) {
    const domain = parts.slice(i).join('.');
    if (adultSet.has(domain)) return domain;
  }
  return null;
}

export function evaluateUrl({ config, usage, delayState = {}, grants = [], url, now, adultSet = null, companionHost = null }) {
  const allow = {
    action: 'allow', reason: null, site: null, listName: null, message: null,
    budgetMinutes: null, usedMinutes: null, delaySeconds: 0, trackKeys: [], delayKeys: [],
  };
  const host = hostFromUrl(url);
  if (!host || host === companionHost || config.phase !== 'locked') return allow;

  if (grants.some(g => g.expiresAt > now && hostMatchesPattern(host, g.site))) return allow;

  if (config.adultContentBlocked && adultSet) {
    const site = isAdultHost(host, adultSet);
    if (site) return { ...allow, action: 'block', reason: 'adult', site };
  }

  // Every active list entry that covers this host.
  const date = new Date(now);
  const minutes = normalizeUsage(usage, now).minutes;
  const matches = [];
  for (const list of config.lists || []) {
    if (!isScheduleActive(list.schedule, date)) continue;
    for (const entry of list.sites || []) {
      if (hostMatchesPattern(host, entry.site)) matches.push({ list, entry, key: entryKey(list, entry) });
    }
  }

  for (const { list, entry, key } of matches) {
    const base = { ...allow, site: entry.site, listName: list.name, message: list.message ?? null };
    const budget = entry.dailyBudgetMinutes;
    if (!budget) return { ...base, action: 'block', reason: 'schedule' };
    const used = minutes[key] || 0;
    if (used >= budget) return { ...base, action: 'block', reason: 'budget', budgetMinutes: budget, usedMinutes: used };
  }

  const trackKeys = matches.filter(m => m.entry.dailyBudgetMinutes).map(m => m.key);
  const delayKeys = matches.filter(m => m.entry.delaySeconds > 0).map(m => m.key);
  // Delay applies only to entries not seen in the last 5 minutes.
  const due = matches.filter(m => m.entry.delaySeconds > 0 && now - (delayState[m.key] || 0) > DELAY_FORGIVE_MS);
  if (!due.length) return { ...allow, trackKeys, delayKeys };

  const top = due.reduce((a, b) => (b.entry.delaySeconds > a.entry.delaySeconds ? b : a));
  return {
    ...allow, action: 'delay', site: top.entry.site, listName: top.list.name, message: top.list.message ?? null,
    delaySeconds: top.entry.delaySeconds, trackKeys, delayKeys,
  };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(k => deepEqual(a[k], b[k]));
}

// True if the change needs no partner approval: same schedule, no removed site,
// no budget increase, no delay decrease. Name, message and new sites are free.
export function isTightening(oldList, newList) {
  const sched = s => (s?.length ? s : null);
  if (!deepEqual(sched(oldList.schedule), sched(newList.schedule))) return false;
  const newSites = newList.sites || [];
  return (oldList.sites || []).every(o => {
    const n = newSites.find(s => s.site === o.site);
    return !!n &&
      (n.dailyBudgetMinutes || 0) <= (o.dailyBudgetMinutes || 0) &&
      (n.delaySeconds || 0) >= (o.delaySeconds || 0);
  });
}
