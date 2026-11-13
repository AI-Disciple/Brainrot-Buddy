// Brainrot Buddy service worker. All state lives in chrome.storage.local because the worker is suspended
// between events. The adult-domain Set is the only module-level cache.
import { evaluateUrl, hostFromUrl, hostMatchesPattern, normalizeUsage, isTightening, todayString } from './lib/rules.js';
import { verify } from './shared/crypto.js';
import { parseFragment, approvalMessage, randomId, buildRequestUrl, isPublicKey, ACTIONS } from './shared/protocol.js';

const MIN = 60_000;
const MAX_INTERVAL_MS = 2 * MIN; // cap per flush so a sleeping computer doesn't count as browsing
const REQUEST_TTL_MS = 60 * MIN;
const KEYS = ['config', 'usage', 'delayState', 'grants', 'pending', 'tracking'];

const fail = (error) => ({ ok: false, error });
const defaultConfig = () => ({ phase: 'draft', adultContentBlocked: false, blockIncognito: true, showTimer: true, lists: [], pubKey: null, companionUrl: '' });
// Private tabs are only skipped when the user turned "block in incognito" off.
const skipTab = (config, tab) => !!tab?.incognito && !config.blockIncognito;
const pageUrl = (page, u) => chrome.runtime.getURL(`pages/${page}?u=${encodeURIComponent(u)}`);
const statusUrl = (kind, text) => chrome.runtime.getURL(`pages/status.html?kind=${kind}&text=${encodeURIComponent(text)}`);
// Origin + path without index.html or trailing slashes, so the companion matches however it is hosted.
const pageKey = (u) => u.origin + u.pathname.replace(/index\.html$/, '').replace(/\/+$/, '');

// ---------- storage and lock ----------

// Serializes read-modify-write sections. Never call withLock from inside another withLock callback (deadlock).
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

async function read(now = Date.now()) {
  const r = await chrome.storage.local.get(KEYS);
  return {
    config: { ...defaultConfig(), ...r.config },
    usage: normalizeUsage(r.usage || { date: todayString(new Date(now)), minutes: {} }, now),
    delayState: r.delayState || {},
    grants: (r.grants || []).filter((g) => g.expiresAt > now),
    pending: r.pending && r.pending.expiresAt > now ? r.pending : null,
    tracking: r.tracking || null,
  };
}

const write = (s) =>
  chrome.storage.local.set({
    config: s.config, usage: s.usage, delayState: s.delayState, grants: s.grants, pending: s.pending, tracking: s.tracking,
  });

// Loaded once per worker. A failed load is retried on next use.
let adultPromise = null;
function loadAdult() {
  adultPromise ??= fetch(chrome.runtime.getURL('data/adult-domains.json'))
    .then((r) => r.json())
    .then((list) => new Set(list.map((d) => String(d).toLowerCase())))
    .catch((e) => {
      console.error('Brainrot Buddy: adult list failed to load', e);
      adultPromise = null;
      return new Set();
    });
  return adultPromise;
}

async function decide(s, url, now = Date.now()) {
  return evaluateUrl({
    config: s.config, usage: s.usage, delayState: s.delayState, grants: s.grants, url, now,
    adultSet: s.config.adultContentBlocked ? await loadAdult() : null,
    companionHost: hostFromUrl(s.config.companionUrl),
  });
}

// ---------- navigation enforcement (not locked: read-only) ----------

chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const s = await read();
  if (s.config.phase !== 'locked') return;
  if (skipTab(s.config, await chrome.tabs.get(d.tabId).catch(() => null))) return;
  const { action } = await decide(s, d.url);
  if (action === 'block') chrome.tabs.update(d.tabId, { url: pageUrl('blocked.html', d.url) }).catch(() => {});
  if (action === 'delay') chrome.tabs.update(d.tabId, { url: pageUrl('delay.html', d.url) }).catch(() => {});
}, { url: [{ schemes: ['http', 'https'] }] });

// ---------- time tracking ----------

// Adds the running interval's time to its usage keys and refreshes delay timestamps. Mutates s.
function flush(s, now) {
  const t = s.tracking;
  if (!t) return;
  s.tracking = null;
  const mins = Math.min(Math.max(now - t.since, 0), MAX_INTERVAL_MS) / MIN;
  for (const k of t.keys) s.usage.minutes[k] = (s.usage.minutes[k] || 0) + mins;
  for (const k of t.delayKeys) s.delayState[k] = now;
}

// Only the focused window's active tab counts.
async function activeTab() {
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win?.focused) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return tab?.url ? { id: tab.id, url: tab.url, incognito: tab.incognito } : null;
}

// Inside withLock. Closes the running interval, opens one for the active tab, returns the tab if it must be blocked.
async function syncLocked(now) {
  const s = await read(now);
  flush(s, now);
  const tab = await activeTab();
  let enforce = null;
  if (tab && s.config.phase === 'locked' && !skipTab(s.config, tab)) {
    const d = await decide(s, tab.url, now);
    if (d.action === 'block') enforce = tab;
    else if (d.action === 'allow' && (d.trackKeys.length || d.delayKeys.length)) {
      s.tracking = { keys: d.trackKeys, delayKeys: d.delayKeys, since: now };
    }
  }
  await write(s);
  return enforce;
}

async function syncAndEnforce() {
  try {
    const tab = await withLock(() => syncLocked(Date.now()));
    if (tab) await chrome.tabs.update(tab.id, { url: pageUrl('blocked.html', tab.url) });
  } catch (e) {
    console.error('Brainrot Buddy: sync failed', e);
  }
}

chrome.alarms.get('tick').then((a) => a || chrome.alarms.create('tick', { periodInMinutes: 0.5 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') syncAndEnforce(); });
chrome.tabs.onActivated.addListener(() => syncAndEnforce());
chrome.tabs.onRemoved.addListener(() => syncAndEnforce());
chrome.windows.onFocusChanged.addListener(() => syncAndEnforce());
chrome.runtime.onStartup.addListener(() => syncAndEnforce());
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  checkApproval(d.tabId, d.url);
  syncAndEnforce();
});
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => {
  if (d.frameId === 0) checkApproval(d.tabId, d.url);
});

// ---------- approval redemption ----------

async function checkApproval(tabId, url) {
  try {
    const u = new URL(url);
    if (!u.hash.startsWith('#a=')) return;
    const s = await read();
    if (!s.config.companionUrl || pageKey(u) !== pageKey(new URL(s.config.companionUrl))) return;
    const f = parseFragment(u.hash);
    const res = f.type === 'approval'
      ? await withLock(() => redeem(f)).catch((e) => fail(e.message))
      : fail('This approval link is not valid.');
    const target = res.ok && res.back ? res.back : statusUrl(res.ok ? 'ok' : 'error', res.ok ? res.text : res.error);
    await chrome.tabs.update(tabId, { url: target });
  } catch (e) {
    console.error('Brainrot Buddy: approval failed', e);
  }
}

// Inside withLock. Single use: the pending request is cleared only after a successful apply.
async function redeem(f) {
  const now = Date.now();
  const s = await read(now);
  const p = s.pending;
  if (!p) return fail('No pending request. Ask again from the blocked page.');
  if (p.id !== f.id) return fail('This approval is for another request.');
  if (!s.config.pubKey) return fail('No partner is paired.');
  const durationOk = p.action === 'EXTEND' ? f.minutes >= 1 && f.minutes <= 1440 : f.minutes === 0;
  if (!durationOk) return fail('Invalid duration.');
  const msg = approvalMessage({ id: p.id, action: p.action, site: p.site, minutes: f.minutes });
  if (!(await verify(s.config.pubKey, msg, f.signature))) {
    return fail('Signature does not match. Check the passphrase and the link.');
  }
  const text = applyAction(s, p, f.minutes, now);
  s.pending = null;
  await write(s);
  return { ok: true, text, back: p.action === 'EXTEND' && hostFromUrl(p.originUrl) ? p.originUrl : null };
}

// Mutates s. Uses the signed site string where it matters, so the partner approves exactly what gets changed.
function applyAction(s, p, minutes, now) {
  const c = s.config;
  const find = (id) => {
    if (!c.lists.some((l) => l.id === id)) throw new Error('That list no longer exists.');
    return c.lists.find((l) => l.id === id);
  };
  switch (p.action) {
    case 'EXTEND':
      s.grants.push({ site: p.site, expiresAt: now + minutes * MIN });
      return `Unlocked ${p.site} for ${minutes} min.`;
    case 'REMOVE_SITE': {
      const l = find(p.payload.listId);
      l.sites = l.sites.filter((e) => e.site !== String(p.site).toLowerCase());
      return `Removed ${p.site}.`;
    }
    case 'REMOVE_LIST':
      find(p.payload.listId);
      c.lists = c.lists.filter((l) => l.id !== p.payload.listId);
      return 'List removed.';
    case 'EDIT_LIST':
      find(p.payload.list.id);
      c.lists = c.lists.map((l) => (l.id === p.payload.list.id ? p.payload.list : l));
      return 'List updated.';
    case 'ADULT_OFF':
      c.adultContentBlocked = false;
      return 'Adult-content block turned off.';
    case 'INCOGNITO_OFF':
      c.blockIncognito = false;
      return 'Blocking in incognito turned off.';
    case 'REPAIR':
      c.pubKey = p.payload.pubKey;
      return 'Partner re-paired.';
    default:
      throw new Error('Unknown action.');
  }
}

// ---------- config sanitizing and lock-in ----------

const newListId = () => 'l_' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('');

// Budgets and delays: numbers (or numeric strings) >= 0, anything else is dropped.
function num(v) {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function cleanSite(e) {
  const site = String(e?.site ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  if (!site) return null;
  const out = { site };
  const budget = num(e.dailyBudgetMinutes);
  const delay = num(e.delaySeconds);
  if (budget !== undefined) out.dailyBudgetMinutes = budget;
  if (delay !== undefined) out.delaySeconds = delay;
  return out;
}

function cleanList(l) {
  if (!l || typeof l !== 'object') return null;
  const out = {
    id: typeof l.id === 'string' && l.id ? l.id : newListId(),
    name: String(l.name ?? '').trim().slice(0, 100),
    sites: (Array.isArray(l.sites) ? l.sites : []).map(cleanSite).filter(Boolean),
  };
  if (typeof l.message === 'string' && l.message.trim()) out.message = l.message.trim().slice(0, 500);
  if (Array.isArray(l.schedule) && l.schedule.length) out.schedule = l.schedule;
  return out;
}

// phase is never taken from the client; only lockIn changes it.
function cleanConfig(input, prev) {
  const c = input || {};
  return {
    phase: prev.phase,
    adultContentBlocked: c.adultContentBlocked === true,
    blockIncognito: c.blockIncognito !== false,
    showTimer: c.showTimer !== false, // cosmetic, so it can be changed freely even when locked
    lists: (Array.isArray(c.lists) ? c.lists : []).map(cleanList).filter(Boolean),
    pubKey: isPublicKey(c.pubKey) ? c.pubKey : null,
    companionUrl: typeof c.companionUrl === 'string' ? c.companionUrl.trim() : '',
  };
}

// True if a locked-mode change needs a signed grant. companionUrl is pinned too: it is exempt from blocking,
// so letting it change would open a bypass.
function lockedChangeBlocked(o, n) {
  if (n.pubKey !== o.pubKey || n.companionUrl !== o.companionUrl) return true;
  if (o.adultContentBlocked && !n.adultContentBlocked) return true;
  if (o.blockIncognito && !n.blockIncognito) return true;
  return o.lists.some((ol) => {
    const nl = n.lists.find((x) => x.id === ol.id);
    return !nl || !isTightening(ol, nl);
  });
}

async function saveConfig(input) {
  const s = await read();
  const next = cleanConfig(input, s.config);
  if (s.config.phase === 'locked' && lockedChangeBlocked(s.config, next)) return fail('needs-grant');
  s.config = next;
  await write(s);
  return { ok: true };
}

async function lockIn() {
  const s = await read();
  const c = s.config;
  if (c.phase !== 'draft') return fail('Already locked.');
  if (!isPublicKey(c.pubKey)) return fail('Paste the pairing code from your partner first.');
  if (!hostFromUrl(c.companionUrl)) return fail('The companion URL is missing or invalid.');
  if (!c.lists.length && !c.adultContentBlocked) return fail('Add a list or turn on the adult-content block first.');
  c.phase = 'locked';
  await write(s);
  return { ok: true };
}

// ---------- requests ----------

// Validates the payload against current state, so a request that cannot apply is refused up front.
function checkPayload(action, p, c) {
  const data = p || {};
  const has = (id) => c.lists.some((l) => l.id === id);
  if (action === 'REMOVE_SITE' || action === 'REMOVE_LIST') {
    if (!has(data.listId)) throw new Error('That list no longer exists.');
    return { listId: data.listId };
  }
  if (action === 'EDIT_LIST') {
    const list = cleanList(data.list);
    if (!list || !has(list.id)) throw new Error('That list no longer exists.');
    return { list };
  }
  if (action === 'ADULT_OFF') {
    if (!c.adultContentBlocked) throw new Error('The adult-content list is already off.');
    return {};
  }
  if (action === 'INCOGNITO_OFF') {
    if (!c.blockIncognito) throw new Error('Blocking in incognito is already off.');
    return {};
  }
  if (action === 'REPAIR') {
    if (!isPublicKey(data.pubKey)) throw new Error('Invalid pairing code.');
    return { pubKey: data.pubKey };
  }
  return {};
}

async function createRequest(m) {
  const s = await read();
  const c = s.config;
  if (!isPublicKey(c.pubKey)) return fail('No partner is paired yet.');
  if (!hostFromUrl(c.companionUrl)) return fail('The companion URL is missing or invalid.');
  if (!ACTIONS.includes(m.action)) return fail('Unknown action.');
  const site = String(m.site || '').trim().slice(0, 200);
  if (!site) return fail('Missing target.');
  const asked = Math.round(Number(m.minutes));
  const minutes = m.action === 'EXTEND' ? (asked >= 1 ? Math.min(asked, 1440) : 10) : 0;
  const now = Date.now();
  const pending = {
    id: randomId(), action: m.action, site, minutes,
    note: String(m.note || '').slice(0, 500), desc: String(m.desc || '').slice(0, 500),
    createdAt: now, expiresAt: now + REQUEST_TTL_MS,
    originUrl: hostFromUrl(m.originUrl) ? m.originUrl : '',
    payload: checkPayload(m.action, m.payload, c),
  };
  s.pending = pending;
  await write(s);
  return { ok: true, url: buildRequestUrl(c.companionUrl, { ...pending, pub: c.pubKey }) };
}

// ---------- messages from extension pages ----------

// Time left for the page's tab, for the on-page countdown (content/timer.js). timer is null when nothing is timed.
async function timerInfo(tab) {
  const none = { ok: true, timer: null };
  const host = hostFromUrl(tab?.url);
  if (!host) return none;
  const now = Date.now();
  const s = await read(now);
  if (s.config.phase !== 'locked' || !s.config.showTimer || skipTab(s.config, tab)) return none;

  const grant = s.grants.filter((g) => hostMatchesPattern(host, g.site)).sort((a, b) => b.expiresAt - a.expiresAt)[0];
  if (grant) return { ok: true, timer: { kind: 'grant', remainingMs: grant.expiresAt - now } };

  const d = await decide(s, tab.url, now);
  if (d.action !== 'allow') return none;
  let remaining = Infinity;
  for (const key of d.trackKeys) {
    const [listId, ...rest] = key.split('|');
    const entry = s.config.lists.find((l) => l.id === listId)?.sites.find((e) => e.site === rest.join('|'));
    if (!entry?.dailyBudgetMinutes) continue;
    let used = s.usage.minutes[key] || 0;
    // The stored usage only advances on events, so add the interval that is still running.
    if (s.tracking?.keys.includes(key)) used += Math.min(Math.max(now - s.tracking.since, 0), MAX_INTERVAL_MS) / MIN;
    remaining = Math.min(remaining, (entry.dailyBudgetMinutes - used) * MIN);
  }
  return Number.isFinite(remaining) ? { ok: true, timer: { kind: 'budget', remainingMs: Math.max(0, remaining) } } : none;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handleMessage(msg || {}, sender).then(sendResponse, (e) => sendResponse(fail(String(e?.message || e))));
  return true; // async reply
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'timerInfo':
      return timerInfo(sender?.tab);
    case 'getState': {
      const s = await read();
      return { ok: true, config: s.config, usage: s.usage, pending: s.pending, grants: s.grants, now: Date.now() };
    }
    case 'saveConfig':
      return withLock(() => saveConfig(msg.config));
    case 'lockIn': {
      const r = await withLock(lockIn);
      if (r.ok) syncAndEnforce();
      return r;
    }
    case 'getBlockInfo': {
      const s = await read();
      const decision = await decide(s, String(msg.url || ''));
      return {
        ok: true,
        decision,
        config: { phase: s.config.phase, hasPartner: !!s.config.pubKey, companionUrl: s.config.companionUrl },
        pending: s.pending,
      };
    }
    case 'createRequest':
      return withLock(() => createRequest(msg));
    case 'cancelRequest':
      return withLock(async () => {
        const s = await read();
        s.pending = null;
        await write(s);
        return { ok: true };
      });
    case 'delayDone':
      return withLock(async () => {
        const s = await read();
        const { delayKeys } = await decide(s, String(msg.url || ''));
        const now = Date.now();
        for (const k of delayKeys) s.delayState[k] = now;
        await write(s);
        return { ok: true };
      });
    default:
      return fail('Unknown message type.');
  }
}

// ---------- install ----------

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
