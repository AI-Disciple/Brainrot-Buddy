// Options page: setup editor (phase 'draft') and settings view (phase 'locked').
// Talks to background.js with chrome.runtime.sendMessage; every reply is { ok, error?, ... }.

import { importAny, exportOptions, newId } from '../lib/options.js';
import { isTightening } from '../lib/rules.js';
import { isPublicKey } from '../shared/protocol.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CHECK_LABELS = [
  'At least one list, or adult blocking on',
  'Companion page link entered',
  'Pairing code from your partner entered',
];
const SAVE_DEBOUNCE_MS = 300;
const REFRESH_MS = 5000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const OPTIONS_URL = chrome.runtime.getURL('pages/options.html');
// Plain link to the setup guide. It only opens in a new tab when the user clicks it; the extension sends nothing to it.
// The extension has no built-in companion page: the user enters that address themselves.
const GUIDE_URL = 'https://brainrot-buddy.netlify.app/guide';
const LOCK_WARNING = [
  'Lock in Brainrot Buddy?',
  '',
  "After locking, most changes need your partner's approval: removing a site or list, raising a budget, lowering a timer, changing a schedule, turning off adult blocking, or changing the partner.",
  '',
  'Adding lists and sites stays free.',
].join('\n');

const app = document.getElementById('app');
const phaseBadge = document.getElementById('phase');
const statusEl = document.getElementById('status');

let state = null;          // last getState reply
let phase = 'draft';       // 'draft' | 'locked'
let serverConfig = null;   // config as last stored by the background (cleaned)
let working = null;        // local working copy, edited in place
let editing = null;        // { listId, copy } while a locked list is being edited
let lastRequestUrl = '';   // request link of the current pending request
let draftEls = {};         // references into the draft page
let saveTimer = null;
let saving = 0;
let saveChain = Promise.resolve();
let renderedSig = '';
let refreshTimer = null;
let activeTab = 'lists';   // selected top-level tab, shared by setup and locked views
let activeListId = null;   // selected list inside the Lists tab
let animateNext = false;   // fade the next panel in (tab switches only, never on data refreshes)

const DRAFT_TABS = [
  { id: 'lists', label: 'Lists' },
  { id: 'protection', label: 'Protection' },
  { id: 'partner', label: 'Partner' },
  { id: 'lock', label: 'Lock in' },
];
const LOCKED_TABS = [
  { id: 'lists', label: 'Lists' },
  { id: 'protection', label: 'Protection' },
  { id: 'partner', label: 'Partner' },
];

// ---------- small DOM helpers (textContent / createElement only) ----------

const clone = (x) => JSON.parse(JSON.stringify(x));

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function button(label, onClick, className = '') {
  return el('button', { type: 'button', class: className, text: label, onclick: onClick });
}

function field(label, input) {
  return el('label', { class: 'field' }, el('span', { text: label }), input);
}

function withClass(node, className) {
  node.classList.add(className);
  return node;
}

function guideLink(text) {
  return el('a', { class: 'guide-link', href: GUIDE_URL, target: '_blank', rel: 'noopener noreferrer', text });
}

function section(title, ...children) {
  return el('section', null, el('h2', { text: title }), ...children);
}

// Segmented tab bar. Arrow keys move between tabs, only the active tab is in the tab order.
function tabBar(tabs, onSelect) {
  return el(
    'div',
    { class: 'tabbar' },
    el(
      'div',
      { class: 'tabs', role: 'tablist' },
      ...tabs.map((tab) => {
        const active = tab.id === activeTab;
        return el('button', {
          type: 'button',
          role: 'tab',
          class: active ? 'tab active' : 'tab',
          'aria-selected': String(active),
          tabindex: active ? '0' : '-1',
          text: tab.label,
          onclick: () => selectTab(tab.id, onSelect),
          onkeydown: (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const step = e.key === 'ArrowRight' ? 1 : -1;
            const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
            selectTab(next.id, onSelect);
            app.querySelector('.tab.active')?.focus();
          },
        });
      }),
    ),
  );
}

function selectTab(id, redraw) {
  if (id === activeTab) return;
  activeTab = id;
  animateNext = true;
  redraw();
}

function tabPanel(...children) {
  const cls = animateNext ? 'panel enter' : 'panel';
  animateNext = false;
  return el('div', { class: cls, role: 'tabpanel' }, ...children);
}

// One pill per list; `extra` is an optional trailing control (the "+ New list" pill).
function listPills(lists, onSelect, extra) {
  return el(
    'div',
    { class: 'pills', role: 'tablist', 'aria-label': 'Lists' },
    ...lists.map((l) => el('button', {
      type: 'button',
      role: 'tab',
      class: l.id === activeListId ? 'pill active' : 'pill',
      'aria-selected': String(l.id === activeListId),
      'data-list-id': l.id,
      text: String(l.name || '').trim() || 'Untitled list',
      onclick: () => {
        activeListId = l.id;
        onSelect();
      },
    })),
    extra,
  );
}

function refreshPillNames() {
  for (const pill of app.querySelectorAll('.pill[data-list-id]')) {
    const list = working.lists.find((l) => l.id === pill.dataset.listId);
    if (list) pill.textContent = String(list.name || '').trim() || 'Untitled list';
  }
}

function numberField(value, placeholder, max, label, onValue, event = 'input') {
  const input = el('input', {
    type: 'number',
    min: '0',
    max: String(max),
    step: '1',
    value: value ? String(value) : '',
    placeholder,
    'aria-label': label,
  });
  input.addEventListener(event, () => onValue(input.value));
  return input;
}

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`.trim();
}

function setHint(node, kind, text) {
  node.className = `hint ${kind}`.trim();
  node.textContent = text;
}

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(response || { ok: false, error: 'No response from the extension.' });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err) });
    }
  });
}

function errText(res) {
  if (res.error === 'needs-grant') {
    return 'That change needs your partner\'s approval. Use "Edit (loosen)" to request it.';
  }
  return res.error || 'Something went wrong.';
}

// ---------- config helpers ----------

function fromState(cfg = {}) {
  return {
    phase: cfg.phase === 'locked' ? 'locked' : 'draft',
    adultContentBlocked: !!cfg.adultContentBlocked,
    blockIncognito: cfg.blockIncognito !== false,
    showTimer: cfg.showTimer !== false,
    lists: (Array.isArray(cfg.lists) ? cfg.lists : []).map((l) => ({
      ...l,
      sites: Array.isArray(l.sites) ? l.sites : [],
    })),
    pubKey: isPublicKey(cfg.pubKey) ? cfg.pubKey : null,
    companionUrl: typeof cfg.companionUrl === 'string' ? cfg.companionUrl : '',
  };
}

function normalizeSite(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split('/')[0]
    .replace(/\s+/g, '');
}

function posInt(value, max) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
}

function cleanSite(s) {
  const site = normalizeSite(s.site);
  if (!site) return null;
  const out = { site };
  const budget = posInt(s.dailyBudgetMinutes, 1440);
  const delay = posInt(s.delaySeconds, 3600);
  if (budget) out.dailyBudgetMinutes = budget;
  if (delay) out.delaySeconds = delay;
  return out;
}

// A range is [start, end] as 'HH:MM'; end may be '24:00' (end of day).
function rangeOk([start, end]) {
  return TIME_RE.test(start || '') && (end === '24:00' || TIME_RE.test(end || '')) && start < end;
}

function cleanSchedule(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const days = [...new Set(row.days || [])]
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => a - b);
    const ranges = (row.ranges || []).filter(rangeOk).map(([s, e]) => [s, e]);
    if (days.length && ranges.length) out.push({ days, ranges });
  }
  return out;
}

function cleanList(list) {
  const out = {
    id: list.id,
    name: String(list.name || '').trim() || 'Untitled list',
    sites: (list.sites || []).map(cleanSite).filter(Boolean),
  };
  const message = String(list.message || '').trim();
  if (message) out.message = message;
  if (Array.isArray(list.schedule)) {
    const schedule = cleanSchedule(list.schedule);
    if (schedule.length) out.schedule = schedule;
  }
  return out;
}

// What actually gets sent to the background: incomplete rows are dropped, never half-saved.
function cleanConfig(c) {
  return {
    phase: c.phase,
    adultContentBlocked: !!c.adultContentBlocked,
    blockIncognito: c.blockIncognito !== false,
    showTimer: c.showTimer !== false,
    lists: c.lists.map(cleanList),
    pubKey: isPublicKey(c.pubKey) ? c.pubKey : null,
    companionUrl: String(c.companionUrl || '').trim(),
  };
}

const canon = (config) => JSON.stringify(cleanConfig(fromState(config)));

function companionUrlOk(url) {
  try {
    const u = new URL(String(url || '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function scheduleText(schedule) {
  if (!Array.isArray(schedule) || !schedule.length) return 'Active all the time.';
  const rows = schedule.map((row) => {
    const days = (row.days || []).map((d) => DAY_NAMES[d]).join(', ');
    const ranges = (row.ranges || []).map(([s, e]) => `${s} to ${e}`).join(', ');
    return `${days}, ${ranges}`;
  });
  return `Active ${rows.join('; ')}.`;
}

function describeChange(before, next) {
  const parts = [];
  if (before.name !== next.name) parts.push(`rename to "${next.name}"`);
  if ((before.message || '') !== (next.message || '')) parts.push('change message');
  if (JSON.stringify(before.schedule || null) !== JSON.stringify(next.schedule || null)) {
    parts.push('change schedule');
  }
  for (const old of before.sites) {
    const now = next.sites.find((s) => s.site === old.site);
    if (!now) {
      parts.push(`remove ${old.site}`);
      continue;
    }
    if ((old.dailyBudgetMinutes || 0) !== (now.dailyBudgetMinutes || 0)) {
      parts.push(`${old.site} budget ${old.dailyBudgetMinutes || 'none'} to ${now.dailyBudgetMinutes || 'none'} min`);
    }
    if ((old.delaySeconds || 0) !== (now.delaySeconds || 0)) {
      parts.push(`${old.site} timer ${old.delaySeconds || 'off'} to ${now.delaySeconds || 'off'} s`);
    }
  }
  for (const now of next.sites) {
    if (!before.sites.some((s) => s.site === now.site)) parts.push(`add ${now.site}`);
  }
  return `Edit list ${before.name}: ${parts.join('; ') || 'minor edit'}`.slice(0, 300);
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Link copied.', 'ok');
  } catch {
    setStatus('Could not copy automatically. Select the link and copy it.', 'error');
  }
}

// Cosmetic setting, so it is free to change in both modes.
function timerToggleSection() {
  const box = el('input', {
    type: 'checkbox',
    checked: working.showTimer,
    onchange: () => {
      working.showTimer = box.checked;
      if (phase === 'draft') draftChanged();
      else saveNow();
    },
  });
  return section(
    'Page timer',
    el('label', { class: 'check' }, box, el('span', { text: 'Show a countdown in the top-left corner of timed sites' })),
    el('p', { class: 'hint', text: 'Shows the time left on sites with a daily budget, or on an approved extension. It hides itself in fullscreen.' }),
  );
}

// Chrome only shows private tabs to the extension if the user turned on "Allow in Incognito" themselves.
function incognitoAccessHint() {
  const node = el('p', { class: 'hint' });
  try {
    chrome.extension.isAllowedIncognitoAccess((allowed) => {
      if (allowed) {
        setHint(node, 'ok', 'Chrome allows Brainrot Buddy in private windows.');
      } else {
        setHint(node, 'bad', 'Chrome has not allowed Brainrot Buddy in private windows yet, so private tabs are NOT blocked. Open chrome://extensions, click Details on Brainrot Buddy and turn on "Allow in Incognito".');
      }
    });
  } catch {
    // Not available: leave the hint empty.
  }
  return node;
}

function focusInInput() {
  const active = document.activeElement;
  return !!active && app.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
}

const isDirty = () => saving > 0 || saveTimer !== null;

// ---------- saving ----------

function scheduleSave() {
  clearTimeout(saveTimer);
  setStatus('Saving...');
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, SAVE_DEBOUNCE_MS);
}

// Saves are serialized; each one sends the working copy as it is when its turn comes.
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  saving += 1;
  saveChain = saveChain.catch(() => {}).then(async () => {
    try {
      const config = cleanConfig(working);
      const res = await send({ type: 'saveConfig', config });
      if (res.ok) {
        serverConfig = clone(config);
        state = { ...state, config: clone(config) };
        setStatus('Saved', 'ok');
        return res;
      }
      setStatus(errText(res), 'error');
      if (res.error === 'needs-grant' && phase === 'locked') {
        working = clone(serverConfig);
        renderLocked();
      }
      return res;
    } finally {
      saving -= 1;
    }
  });
  return saveChain;
}

function loadState(res) {
  state = res;
  phase = fromState(res.config).phase;
  const cfg = fromState(res.config);
  serverConfig = clone(cfg);
  working = clone(cfg);
}

// ---------- startup and mode switch ----------

function renderAll() {
  phaseBadge.textContent = phase === 'locked' ? 'Locked' : 'Setup';
  phaseBadge.className = `badge ${phase}`;
  if (phase === 'locked') {
    renderLocked();
    startRefresh();
  } else {
    renderDraft();
  }
}

async function init() {
  const res = await send({ type: 'getState' });
  if (!res.ok) {
    app.replaceChildren(el('p', { class: 'hint bad', text: `Could not load settings: ${errText(res)}` }));
    return;
  }
  loadState(res);
  renderAll();
}

window.addEventListener('pagehide', () => {
  if (saveTimer) saveNow();
});

async function lockIn() {
  if (!window.confirm(LOCK_WARNING)) return;
  const saved = await saveNow();
  if (!saved.ok) {
    setStatus(errText(saved), 'error');
    return;
  }
  const res = await send({ type: 'lockIn' });
  if (!res.ok) {
    setStatus(errText(res), 'error');
    return;
  }
  const st = await send({ type: 'getState' });
  if (!st.ok) {
    setStatus(errText(st), 'error');
    return;
  }
  loadState(st);
  renderAll();
  setStatus('Locked in.', 'ok');
}

// ---------- draft mode ----------

const draftCtx = { changed: draftChanged, redraw: draftRedraw };

function draftChanged() {
  scheduleSave();
  refreshSummary();
  refreshPillNames();
}

function draftRedraw() {
  renderLists();
  draftChanged();
}

function renderDraft() {
  stopRefresh();
  draftEls = {};
  draftEls.lists = el('div', { class: 'lists' });
  draftEls.adult = el('input', {
    type: 'checkbox',
    checked: working.adultContentBlocked,
    onchange: () => {
      working.adultContentBlocked = draftEls.adult.checked;
      draftChanged();
    },
  });
  draftEls.incognito = el('input', {
    type: 'checkbox',
    checked: working.blockIncognito,
    onchange: () => {
      working.blockIncognito = draftEls.incognito.checked;
      draftChanged();
    },
  });
  draftEls.importMessages = el('ul', { class: 'messages', 'aria-live': 'polite' });
  draftEls.companionInput = el('input', {
    type: 'url',
    value: working.companionUrl,
    placeholder: 'https://your-name.github.io/brainrot-buddy/',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Companion page URL',
    oninput: () => {
      working.companionUrl = draftEls.companionInput.value;
      checkPartner();
      draftChanged();
    },
  });
  draftEls.codeInput = el('input', {
    type: 'text',
    value: working.pubKey || '',
    placeholder: 'Paste the code here',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Pairing code from your partner',
    oninput: () => {
      const code = draftEls.codeInput.value.trim();
      working.pubKey = isPublicKey(code) ? code : null;
      checkPartner();
      draftChanged();
    },
  });
  draftEls.urlHint = el('p', { class: 'hint' });
  draftEls.codeHint = el('p', { class: 'hint' });
  draftEls.summaryText = el('p', { class: 'hint' });
  draftEls.checks = CHECK_LABELS.map((label) => {
    const mark = el('span', { class: 'mark' });
    return { mark, li: el('li', null, mark, el('span', { text: label })) };
  });
  draftEls.lockBtn = button('Lock in', lockIn, 'primary');

  const importInput = el('input', {
    type: 'file',
    accept: '.json,application/json',
    'aria-label': 'Options file to import',
    onchange: importFile,
  });

  draftEls.intro = el('p', {
    class: 'intro',
    text: 'Set up your lists, then lock in. Nothing is enforced until you lock in, and after that most changes need your partner.',
  });
  draftEls.panels = {
    lists: [
      el(
        'section',
        null,
        el('p', {
          class: 'hint',
          text: 'A site with no daily budget is blocked whenever its list is active. A list with no schedule is always active. Budgets are minutes of active-tab time per site per day. Timers are seconds on the countdown page before a site opens.',
        }),
        draftEls.lists,
      ),
      section(
        'Import and export',
        el('p', {
          class: 'hint',
          text: 'Import a Brainrot Buddy options file or a LeechBlock NG export. Imported lists are added to your current lists. Passwords are never imported.',
        }),
        importInput,
        el('div', { class: 'actions' }, button('Export options', exportOptionsFile)),
        draftEls.importMessages,
      ),
    ],
    protection: [
      section(
        'Adult sites',
        el('label', { class: 'check' }, draftEls.adult, el('span', { text: 'Block adult sites' })),
        el('p', {
          class: 'hint',
          text: 'Uses a bundled domain list. Always on while enabled, but new or obscure sites can slip through.',
        }),
      ),
      section(
        'Private windows',
        el('label', { class: 'check' }, draftEls.incognito, el('span', { text: 'Also block in incognito (private) windows' })),
        incognitoAccessHint(),
      ),
      timerToggleSection(),
    ],
    partner: [
      withClass(section(
        'Partner',
        el('p', {
          class: 'partner-note',
          text: 'Approvals need a small web page your partner opens, called the companion page. This extension has no built-in address and never contacts any website by itself. You enter the address below. You can use the hosted copy from the guide, or host your own free copy from the open-source code. Everything you ask for travels only as a link you send to your partner yourself.',
        }),
        el('p', { class: 'partner-note' }, guideLink('Open the setup guide')),
        el(
          'ol',
          { class: 'steps' },
          el('li', { text: 'Your partner opens their companion page, goes to setup, and chooses a PIN (6+ digits).' }),
          el('li', { text: 'They keep the PIN to themselves. You must never learn it.' }),
          el('li', { text: 'They text you a pairing code. Paste it below, along with the companion page link.' }),
        ),
        field('Companion page URL', draftEls.companionInput),
        draftEls.urlHint,
        field('Pairing code from your partner', draftEls.codeInput),
        draftEls.codeHint,
      ), 'partner-section'),
    ],
    lock: [
      section(
        'Summary and lock in',
        draftEls.summaryText,
        el('ul', { class: 'checks' }, ...draftEls.checks.map((c) => c.li)),
        el('div', { class: 'actions' }, draftEls.lockBtn),
        el('p', { class: 'hint', text: 'Locking in means most changes need your partner\'s approval.' }),
      ),
    ],
  };

  renderLists();
  checkPartner();
  refreshSummary();
  drawDraft();
}

// The panels are built once; switching tabs only swaps which ones are attached.
function drawDraft() {
  if (!DRAFT_TABS.some((t) => t.id === activeTab)) activeTab = DRAFT_TABS[0].id;
  app.replaceChildren(
    draftEls.intro,
    tabBar(DRAFT_TABS, drawDraft),
    tabPanel(...draftEls.panels[activeTab]),
  );
}

function renderLists() {
  if (!draftEls.lists) return;
  const lists = working.lists;
  if (!lists.some((l) => l.id === activeListId)) activeListId = lists.length ? lists[0].id : null;
  const active = lists.find((l) => l.id === activeListId);
  draftEls.lists.replaceChildren(
    listPills(lists, renderLists, button('+ New list', addDraftList, 'pill add')),
    active
      ? listCard(active, draftCtx)
      : el('p', { class: 'hint', text: 'No lists yet. Add one above or import a file.' }),
  );
}

function addDraftList() {
  const list = { id: newId(), name: `List ${working.lists.length + 1}`, sites: [] };
  working.lists.push(list);
  activeListId = list.id;
  draftRedraw();
}

function listCard(list, ctx) {
  return el(
    'div',
    { class: 'list' },
    listFields(list, ctx),
    el(
      'div',
      { class: 'list-foot' },
      button(
        'Delete list',
        () => {
          if (!window.confirm(`Delete the list "${list.name}" and its sites?`)) return;
          working.lists = working.lists.filter((l) => l !== list);
          ctx.redraw();
        },
        'small danger',
      ),
    ),
  );
}

// Editable fields of one list. Used for draft lists and for the copy in the locked editor.
function listFields(list, ctx) {
  const nameInput = el('input', {
    type: 'text',
    value: list.name || '',
    placeholder: 'List name',
    autocomplete: 'off',
    'aria-label': 'List name',
    oninput: () => {
      list.name = nameInput.value;
      ctx.changed();
    },
  });
  const messageInput = el('input', {
    type: 'text',
    value: list.message || '',
    placeholder: 'Shown on the blocked page (optional)',
    autocomplete: 'off',
    'aria-label': 'Custom message',
    oninput: () => {
      list.message = messageInput.value;
      ctx.changed();
    },
  });
  return el(
    'div',
    { class: 'fields' },
    field('Name', nameInput),
    field('Custom message (optional)', messageInput),
    scheduleEditor(list, ctx),
    draftSitesTable(list, ctx),
    el('div', { class: 'actions' }, button('Add site', () => {
      list.sites.push({ site: '' });
      ctx.redraw();
    }, 'small')),
  );
}

function draftSitesTable(list, ctx) {
  if (!list.sites.length) return el('p', { class: 'hint', text: 'No sites yet.' });
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'sites' },
      el(
        'thead',
        null,
        el(
          'tr',
          null,
          el('th', { text: 'Site pattern' }),
          el('th', { text: 'Daily budget (min)' }),
          el('th', { text: 'Brainrot timer (s)' }),
          el('th'),
        ),
      ),
      el(
        'tbody',
        null,
        list.sites.map((site) => {
          const siteInput = el('input', {
            type: 'text',
            value: site.site || '',
            placeholder: 'youtube.com',
            autocomplete: 'off',
            spellcheck: false,
            'aria-label': 'Site pattern',
            oninput: () => {
              site.site = siteInput.value;
              ctx.changed();
            },
            onchange: () => {
              site.site = normalizeSite(siteInput.value);
              siteInput.value = site.site;
              ctx.changed();
            },
          });
          const budget = numberField(site.dailyBudgetMinutes, 'none', 1440, 'Daily budget in minutes', (v) => {
            site.dailyBudgetMinutes = v === '' ? undefined : Number(v);
            ctx.changed();
          });
          const timer = numberField(site.delaySeconds, 'off', 3600, 'Brainrot timer in seconds', (v) => {
            site.delaySeconds = v === '' ? undefined : Number(v);
            ctx.changed();
          });
          return el(
            'tr',
            null,
            el('td', null, siteInput),
            el('td', null, budget),
            el('td', null, timer),
            el(
              'td',
              null,
              button('Remove', () => {
                list.sites = list.sites.filter((s) => s !== site);
                ctx.redraw();
              }, 'small danger'),
            ),
          );
        }),
      ),
    ),
  );
}

function scheduleEditor(list, ctx) {
  const enabled = Array.isArray(list.schedule);
  const toggle = el('input', {
    type: 'checkbox',
    checked: enabled,
    onchange: () => {
      if (toggle.checked) list.schedule = [{ days: [1, 2, 3, 4, 5], ranges: [['09:00', '17:00']] }];
      else delete list.schedule;
      ctx.redraw();
    },
  });
  const children = [el('label', { class: 'check' }, toggle, el('span', { text: 'Only active on certain days/times' }))];
  if (enabled) {
    if (!list.schedule.length) {
      children.push(el('p', { class: 'hint', text: 'No schedule rows, so this list is active all the time.' }));
    }
    list.schedule.forEach((row, index) => children.push(scheduleRow(list, row, index, ctx)));
    children.push(
      el('div', { class: 'actions' }, button('Add schedule row', () => {
        list.schedule.push({ days: [], ranges: [['09:00', '17:00']] });
        ctx.redraw();
      }, 'small')),
    );
  }
  return el('div', { class: 'schedule' }, ...children);
}

function rowProblem(row) {
  if (!row.days.length) return 'Pick at least one day. Not saved until then.';
  if (!row.ranges.length || !row.ranges.every(rangeOk)) {
    return 'Each time range needs a start time and an end time after it. Not saved until then.';
  }
  return '';
}

function scheduleRow(list, row, index, ctx) {
  const hint = el('p', { class: 'hint bad' });
  const refreshHint = () => {
    hint.textContent = rowProblem(row);
  };

  const dayBoxes = DAY_NAMES.map((dayName, day) => {
    const box = el('input', {
      type: 'checkbox',
      checked: row.days.includes(day),
      onchange: () => {
        row.days = box.checked ? [...row.days, day] : row.days.filter((d) => d !== day);
        refreshHint();
        ctx.changed();
      },
    });
    return el('label', { class: 'day' }, box, el('span', { text: dayName }));
  });

  const rangeRows = row.ranges.map((range, k) => {
    const start = el('input', {
      type: 'time',
      value: range[0] || '',
      'aria-label': 'Start time',
      oninput: () => {
        range[0] = start.value;
        refreshHint();
        ctx.changed();
      },
    });
    const eod = el('span', { class: 'eod', text: range[1] === '24:00' ? '= 24:00' : '' });
    const end = el('input', {
      type: 'time',
      value: range[1] === '24:00' ? '00:00' : range[1] || '',
      'aria-label': 'End time',
      oninput: () => {
        // Picking 00:00 as the end means midnight at the end of the day.
        range[1] = end.value === '00:00' ? '24:00' : end.value;
        eod.textContent = range[1] === '24:00' ? '= 24:00' : '';
        refreshHint();
        ctx.changed();
      },
    });
    return el(
      'div',
      { class: 'range' },
      start,
      el('span', { text: 'to' }),
      end,
      eod,
      button('Remove range', () => {
        row.ranges.splice(k, 1);
        ctx.redraw();
      }, 'small danger'),
    );
  });

  refreshHint();
  return el(
    'div',
    { class: 'sched-row' },
    el('div', { class: 'days' }, dayBoxes),
    el('div', { class: 'ranges' }, rangeRows),
    el(
      'div',
      { class: 'actions' },
      button('Add time range', () => {
        row.ranges.push(['09:00', '17:00']);
        ctx.redraw();
      }, 'small'),
      button('Remove schedule row', () => {
        list.schedule.splice(index, 1);
        ctx.redraw();
      }, 'small danger'),
    ),
    hint,
  );
}

function refreshSummary() {
  if (!draftEls.summaryText) return;
  const lists = working.lists.length;
  const sites = working.lists.reduce((n, l) => n + l.sites.filter((s) => normalizeSite(s.site)).length, 0);
  draftEls.summaryText.textContent = `${lists} list${lists === 1 ? '' : 's'}, ${sites} site${sites === 1 ? '' : 's'}. Adult sites: ${working.adultContentBlocked ? 'blocked' : 'not blocked'}.`;
  const results = [
    lists > 0 || working.adultContentBlocked,
    companionUrlOk(working.companionUrl),
    isPublicKey(working.pubKey),
  ];
  draftEls.checks.forEach((c, i) => {
    c.mark.textContent = results[i] ? '✓' : '✗';
    c.li.className = results[i] ? 'ok' : 'bad';
  });
  draftEls.lockBtn.disabled = !results.every(Boolean);
}

function checkPartner() {
  if (!draftEls.urlHint) return;
  const url = (working.companionUrl || '').trim();
  if (!url) setHint(draftEls.urlHint, '', 'Required before you can lock in.');
  else if (companionUrlOk(url)) setHint(draftEls.urlHint, 'ok', 'Looks good.');
  else setHint(draftEls.urlHint, 'bad', 'Enter a full web address that starts with https://');

  const code = draftEls.codeInput.value.trim();
  if (!code) setHint(draftEls.codeHint, '', 'Paste the code your partner texted you.');
  else if (isPublicKey(code)) setHint(draftEls.codeHint, 'ok', 'Valid pairing code.');
  else setHint(draftEls.codeHint, 'bad', 'That is not a valid pairing code. Check that you copied all of it.');
}

function showIoMessages({ info = [], warnings = [], errors = [] }) {
  draftEls.importMessages.replaceChildren(
    ...info.map((text) => el('li', { class: 'msg', text })),
    ...warnings.map((text) => el('li', { class: 'msg warn', text: `Warning: ${text}` })),
    ...errors.map((text) => el('li', { class: 'msg error', text: `Error: ${text}` })),
  );
}

async function importFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    showIoMessages({ errors: [`${file.name} is not a valid JSON file.`] });
    return;
  }

  let result;
  try {
    result = importAny(parsed);
  } catch (err) {
    showIoMessages({ errors: [`Could not read ${file.name}: ${err.message}`] });
    return;
  }
  if (!result || !result.ok) {
    const errors = result && result.errors && result.errors.length
      ? result.errors
      : ['This is not a Brainrot Buddy or LeechBlock options file.'];
    showIoMessages({ errors, warnings: (result && result.warnings) || [] });
    return;
  }

  const lists = result.lists || [];
  working.lists.push(...lists);
  if (typeof result.adultContentBlocked === 'boolean') {
    working.adultContentBlocked = result.adultContentBlocked;
    draftEls.adult.checked = result.adultContentBlocked;
  }
  renderLists();
  draftChanged();
  showIoMessages({
    info: [`Added ${lists.length} list${lists.length === 1 ? '' : 's'} from ${file.name}.`],
    warnings: result.warnings || [],
  });
}

function exportOptionsFile() {
  const data = exportOptions(cleanConfig(working));
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }));
  const link = el('a', { href: url, download: 'brainrot-buddy-options.json' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- locked mode ----------

function startRefresh() {
  if (!refreshTimer) refreshTimer = setInterval(tick, REFRESH_MS);
}

function stopRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = null;
}

function sigOf() {
  const p = state && state.pending;
  return [canon(state.config), p ? `${p.id}:${p.expiresAt}` : '', lastRequestUrl].join('|');
}

async function tick() {
  if (phase !== 'locked') return;
  const res = await send({ type: 'getState' });
  if (!res.ok || phase !== 'locked') return;
  state = res;
  if (!res.pending) lastRequestUrl = '';
  if (!isDirty() && canon(res.config) !== canon(serverConfig)) {
    serverConfig = clone(fromState(res.config));
    working = clone(fromState(res.config));
  }
  if (sigOf() !== renderedSig) {
    if (!focusInInput()) renderLocked();
  } else {
    refreshUsage();
  }
}

// Shows "used X of Y min" next to each site, from today's usage.
function refreshUsage() {
  const minutes = (state && state.usage && state.usage.minutes) || {};
  for (const span of app.querySelectorAll('[data-usage-key]')) {
    const list = working.lists.find((l) => l.id === span.dataset.listId);
    const site = list && list.sites.find((s) => s.site === span.dataset.site);
    if (!site) continue;
    const used = Math.floor(minutes[span.dataset.usageKey] || 0);
    const budget = posInt(site.dailyBudgetMinutes, 1440);
    span.textContent = budget ? `used ${used} of ${budget} min` : 'no budget';
  }
}

function renderLocked() {
  if (!LOCKED_TABS.some((t) => t.id === activeTab)) activeTab = LOCKED_TABS[0].id;
  const panels = {
    lists: () => [lockedListsSection()],
    protection: () => [
      section('Adult sites', adultLockedBlock()),
      section('Private windows', incognitoLockedBlock()),
      timerToggleSection(),
    ],
    partner: () => [section('Partner', partnerLockedBlock())],
  };
  app.replaceChildren(
    el('p', {
      class: 'intro',
      text: 'Locked. Adding lists and sites is free. Removing something, or making a rule looser, needs your partner to approve it.',
    }),
    ...[pendingBanner()].filter(Boolean), // replaceChildren(null) would render the text "null"
    tabBar(LOCKED_TABS, renderLocked),
    tabPanel(...panels[activeTab]()),
  );
  renderedSig = sigOf();
  refreshUsage();
}

function lockedListsSection() {
  const lists = working.lists;
  if (!lists.some((l) => l.id === activeListId)) activeListId = lists.length ? lists[0].id : null;
  const active = lists.find((l) => l.id === activeListId);
  return el(
    'section',
    null,
    lists.length ? listPills(lists, renderLocked) : null,
    active ? lockedListCard(active) : el('p', { class: 'hint', text: 'No lists yet.' }),
    addListForm(),
  );
}

function pendingBanner() {
  const p = state && state.pending;
  if (!p) return null;
  const children = [
    el('p', null, el('strong', { text: 'Waiting for your partner: ' }), p.desc || p.action),
    el('p', {
      class: 'hint',
      text: `Expires at ${clockTime(p.expiresAt)}. When your partner texts back an approval link, open it in this browser.`,
    }),
  ];
  if (lastRequestUrl) {
    children.push(
      el('p', { text: 'Send this link to your partner:' }),
      el('textarea', {
        readonly: true,
        rows: 3,
        value: lastRequestUrl,
        'aria-label': 'Request link',
        onclick: (e) => e.target.select(),
      }),
      el('div', { class: 'actions' }, button('Copy link', () => copyText(lastRequestUrl)), button('Cancel request', cancelRequest, 'danger')),
    );
  } else {
    children.push(el('div', { class: 'actions' }, button('Cancel request', cancelRequest, 'danger')));
  }
  return el('div', { class: 'banner' }, ...children);
}

async function cancelRequest() {
  const res = await send({ type: 'cancelRequest' });
  if (!res.ok) {
    setStatus(errText(res), 'error');
    return;
  }
  lastRequestUrl = '';
  await reloadState();
  renderLocked();
  setStatus('Request cancelled.', 'ok');
}

async function reloadState() {
  const res = await send({ type: 'getState' });
  if (res.ok) state = res;
  return res.ok;
}

// Sends a grant request (needs partner approval). Returns true when a link was created.
async function requestChange({ action, site, desc, payload }) {
  if (state && state.pending && !window.confirm('Another request is waiting for approval. A new one replaces it. Continue?')) {
    return false;
  }
  const res = await send({
    type: 'createRequest',
    action,
    site,
    minutes: 0,
    note: '',
    desc,
    payload,
    originUrl: OPTIONS_URL,
  });
  if (!res.ok) {
    setStatus(errText(res), 'error');
    renderLocked();
    return false;
  }
  lastRequestUrl = res.url;
  let copied = false;
  try {
    await navigator.clipboard.writeText(res.url);
    copied = true;
  } catch {
    copied = false;
  }
  await reloadState();
  renderLocked();
  setStatus(
    copied ? 'Request link copied. Send it to your partner.' : 'Request created. Copy the link below and send it to your partner.',
    copied ? 'ok' : '',
  );
  return true;
}

function lockedListCard(list) {
  if (editing && editing.listId === list.id) return editListCard(list);
  return el(
    'div',
    { class: 'list' },
    el(
      'div',
      { class: 'list-head' },
      el(
        'div',
        { class: 'list-title' },
        el('h3', { text: list.name }),
        el('p', { class: 'hint', text: scheduleText(list.schedule) }),
        list.message ? el('p', { class: 'hint', text: `Message: ${list.message}` }) : null,
      ),
      el(
        'div',
        { class: 'actions' },
        button('Edit (loosen)', () => startEdit(list.id)),
        button('Remove list', () => requestChange({
          action: 'REMOVE_LIST',
          site: list.name,
          desc: `Remove list ${list.name}`,
          payload: { listId: list.id },
        }), 'danger'),
      ),
    ),
    lockedSitesTable(list),
    addSiteForm(list),
  );
}

function lockedSitesTable(list) {
  if (!list.sites.length) return el('p', { class: 'hint', text: 'No sites yet.' });
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'sites' },
      el(
        'thead',
        null,
        el(
          'tr',
          null,
          el('th', { text: 'Site' }),
          el('th', { text: 'Today' }),
          el('th', { text: 'Budget (min)' }),
          el('th', { text: 'Timer (s)' }),
          el('th'),
        ),
      ),
      el(
        'tbody',
        null,
        list.sites.map((site) => el(
          'tr',
          null,
          el('td', { text: site.site }),
          el('td', null, el('span', {
            class: 'usage',
            'data-usage-key': `${list.id}|${site.site}`,
            'data-list-id': list.id,
            'data-site': site.site,
          })),
          el('td', null, numberField(
            site.dailyBudgetMinutes,
            'none',
            1440,
            'Daily budget in minutes',
            (v) => commitSite(site, 'dailyBudgetMinutes', v),
            'change',
          )),
          el('td', null, numberField(
            site.delaySeconds,
            'off',
            3600,
            'Brainrot timer in seconds',
            (v) => commitSite(site, 'delaySeconds', v),
            'change',
          )),
          el('td', null, button('Remove', () => requestChange({
            action: 'REMOVE_SITE',
            site: site.site,
            desc: `Remove ${site.site} from list ${list.name}`,
            payload: { listId: list.id, site: site.site },
          }), 'small danger')),
        )),
      ),
    ),
  );
}

// In-place edit of a budget or timer. Stricter values save at once; looser ones are refused by the background.
function commitSite(site, field, raw) {
  const max = field === 'dailyBudgetMinutes' ? 1440 : 3600;
  const next = posInt(raw, max);
  if (posInt(site[field], max) === next) return;
  site[field] = next || undefined;
  saveNow().then((res) => {
    if (res.ok) refreshUsage();
  });
}

function addSiteForm(list) {
  const siteInput = el('input', {
    type: 'text',
    placeholder: 'site, e.g. youtube.com',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'New site',
  });
  const budgetInput = el('input', {
    type: 'number',
    min: '0',
    max: '1440',
    placeholder: 'budget (min)',
    'aria-label': 'New site daily budget in minutes',
  });
  const timerInput = el('input', {
    type: 'number',
    min: '0',
    max: '3600',
    placeholder: 'timer (s)',
    'aria-label': 'New site brainrot timer in seconds',
  });
  return el(
    'div',
    { class: 'add-row' },
    siteInput,
    budgetInput,
    timerInput,
    button('Add site', async () => {
      const site = normalizeSite(siteInput.value);
      if (!site) {
        setStatus('Type a site first.', 'error');
        return;
      }
      if (list.sites.some((s) => s.site === site)) {
        setStatus(`${site} is already in this list.`, 'error');
        return;
      }
      list.sites.push(cleanSite({ site, dailyBudgetMinutes: budgetInput.value, delaySeconds: timerInput.value }));
      const res = await saveNow();
      if (res.ok) renderLocked();
    }),
  );
}

function addListForm() {
  const nameInput = el('input', {
    type: 'text',
    placeholder: 'New list name',
    autocomplete: 'off',
    'aria-label': 'New list name',
  });
  return el(
    'div',
    { class: 'add-row add-list' },
    nameInput,
    button('Add list', async () => {
      const name = nameInput.value.trim();
      if (!name) {
        setStatus('Type a name for the list first.', 'error');
        return;
      }
      const list = { id: newId(), name, sites: [] };
      working.lists.push(list);
      activeListId = list.id;
      const res = await saveNow();
      if (res.ok) renderLocked();
    }, 'primary'),
  );
}

function adultLockedBlock() {
  if (working.adultContentBlocked) {
    return el(
      'div',
      null,
      el('p', { text: 'Adult sites are blocked.' }),
      button('Turn adult blocking off', () => requestChange({
        action: 'ADULT_OFF',
        site: 'adult sites',
        desc: 'Turn off adult-content blocking',
        payload: {},
      }), 'danger'),
    );
  }
  return el(
    'div',
    null,
    el('p', { text: 'Adult sites are not blocked.' }),
    button('Turn adult blocking on', async () => {
      working.adultContentBlocked = true;
      const res = await saveNow();
      if (res.ok) renderLocked();
    }, 'primary'),
  );
}

function incognitoLockedBlock() {
  const on = working.blockIncognito;
  return el(
    'div',
    null,
    el('p', { text: on ? 'Blocking also applies in incognito windows.' : 'Incognito windows are not blocked.' }),
    on
      ? button('Turn incognito blocking off', () => requestChange({
        action: 'INCOGNITO_OFF',
        site: 'incognito',
        desc: 'Turn off blocking in incognito windows',
        payload: {},
      }), 'danger')
      : button('Turn incognito blocking on', async () => {
        working.blockIncognito = true;
        const res = await saveNow();
        if (res.ok) renderLocked();
      }, 'primary'),
    incognitoAccessHint(),
  );
}

function partnerLockedBlock() {
  const codeInput = el('input', {
    type: 'text',
    placeholder: 'New pairing code',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'New pairing code',
  });
  const hint = el('p', { class: 'hint' });
  codeInput.addEventListener('input', () => {
    const code = codeInput.value.trim();
    if (!code) setHint(hint, '', '');
    else if (isPublicKey(code)) setHint(hint, 'ok', 'Valid pairing code.');
    else setHint(hint, 'bad', 'That is not a valid pairing code.');
  });
  return el(
    'div',
    null,
    el('p', { text: working.pubKey ? 'A partner is paired.' : 'No partner is paired.' }),
    el('p', { class: 'hint', text: `Companion page: ${working.companionUrl || 'not set'}` }),
    el('p', null, guideLink('Open the setup guide')),
    field('New pairing code (from the new partner)', codeInput),
    hint,
    el('div', { class: 'actions' }, button('Change partner', () => {
      const code = codeInput.value.trim();
      if (!isPublicKey(code)) {
        setHint(hint, 'bad', 'Paste a valid pairing code first.');
        return;
      }
      requestChange({
        action: 'REPAIR',
        site: 'partner',
        desc: 'Change partner (new pairing code)',
        payload: { pubKey: code },
      });
    }, 'danger')),
  );
}

function startEdit(listId) {
  const list = working.lists.find((l) => l.id === listId);
  if (!list) return;
  editing = { listId, copy: clone(list) };
  renderLocked();
}

function cancelEdit() {
  editing = null;
  renderLocked();
}

function editListCard(list) {
  const copy = editing.copy;
  const ctx = { changed() {}, redraw: renderLocked };
  return el(
    'div',
    { class: 'list editing' },
    el('h3', { text: `Editing ${list.name}` }),
    listFields(copy, ctx),
    el('p', {
      class: 'hint',
      text: 'Changes that only make rules stricter apply right away. Anything looser is sent to your partner for approval.',
    }),
    el('div', { class: 'actions' }, button('Request change', requestEdit, 'primary'), button('Cancel', cancelEdit)),
  );
}

async function requestEdit() {
  const current = editing;
  const oldList = serverConfig.lists.find((l) => l.id === current.listId);
  if (!oldList) {
    cancelEdit();
    return;
  }
  const before = cleanList(oldList);
  const next = cleanList(current.copy);
  if (JSON.stringify(before) === JSON.stringify(next)) {
    setStatus('Nothing changed.');
    return;
  }

  if (isTightening(before, next)) {
    editing = null;
    working.lists = working.lists.map((l) => (l.id === next.id ? clone(next) : l));
    const res = await saveNow();
    if (res.ok) setStatus('Saved. That change only tightens a rule.', 'ok');
    renderLocked();
    return;
  }

  editing = null;
  const sent = await requestChange({
    action: 'EDIT_LIST',
    site: before.name,
    desc: describeChange(before, next),
    payload: { list: next },
  });
  if (!sent) editing = current;
  renderLocked();
}

// ---------- go ----------

init();
