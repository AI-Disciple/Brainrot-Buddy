// Blocked screen: explains the block and, when the list is locked and a partner is paired, lets the user ask for time.
const $ = (id) => document.getElementById(id);
const u = new URLSearchParams(location.search).get('u') || '';
let site = '';
let link = '';

async function send(msg) {
  try {
    return (await chrome.runtime.sendMessage(msg)) || { ok: false, error: 'No response.' };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// Only web addresses are ever handed back to the browser.
function go() {
  if (/^https?:\/\//i.test(u)) location.replace(u);
}

function showError(text) {
  $('error').textContent = text || '';
  $('error').hidden = !text;
}

function reasonText(d) {
  if (d.reason === 'adult') return 'Adult content is blocked.';
  if (d.reason === 'schedule') return 'This site is blocked right now.';
  if (d.reason === 'budget') return `Daily limit reached (used ${Math.round(d.usedMinutes)} of ${d.budgetMinutes} min).`;
  return 'This site is blocked.';
}

function renderBlock(d) {
  site = d.site || '';
  $('site').textContent = site;
  $('reason').textContent = reasonText(d);
  $('message').textContent = d.message || '';
  $('message').hidden = !d.message;
}

// name: 'form' | 'waiting' | 'link'
function showPanel(name) {
  $('form').hidden = name !== 'form';
  $('waiting').hidden = name !== 'waiting';
  $('linkBox').hidden = name !== 'link';
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function renderPartner(res) {
  const canAsk = res.config.phase === 'locked' && !!res.config.hasPartner;
  $('partner').hidden = !canAsk;
  if (!canAsk) return;
  const waiting = !!res.pending && res.pending.expiresAt > Date.now();
  showPanel(waiting ? 'waiting' : 'form');
}

$('ask').addEventListener('click', async () => {
  const minutes = Number($('minutes').value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return showError('Enter a whole number of minutes from 1 to 1440 (24 hours).');
  const note = $('note').value.trim().slice(0, 200);
  showError('');
  const res = await send({
    type: 'createRequest',
    action: 'EXTEND',
    site,
    minutes,
    note,
    desc: `${minutes} min on ${site}`,
    payload: {},
    originUrl: u,
  });
  if (!res.ok || !res.url) return showError(res.error || 'Could not create the request.');
  link = res.url;
  $('link').value = link;
  const copied = await copy(link);
  $('copyState').textContent = copied ? 'Copied to clipboard.' : 'Could not copy automatically. Use Copy again.';
  showPanel('link');
});

$('copyAgain').addEventListener('click', async () => {
  const copied = await copy(link);
  $('copyState').textContent = copied ? 'Copied to clipboard.' : 'Copy failed. Select the text and copy it.';
});

async function cancelRequest() {
  showError('');
  const res = await send({ type: 'cancelRequest' });
  if (!res.ok) return showError(res.error || 'Could not cancel the request.');
  showPanel('form');
}

$('cancelWaiting').addEventListener('click', cancelRequest);
$('cancelLink').addEventListener('click', cancelRequest);
$('newRequest').addEventListener('click', () => showPanel('form'));
$('link').addEventListener('focus', (e) => e.target.select());

// Only checks whether the block has lifted; the panel state is left alone so typing is not lost.
async function poll() {
  const res = await send({ type: 'getBlockInfo', url: u });
  if (res.ok && res.decision && res.decision.action === 'allow') go();
}

async function init() {
  if (!u) return showError('No address to check.');
  const res = await send({ type: 'getBlockInfo', url: u });
  if (!res.ok || !res.decision) return showError(res.error || 'Could not check this site.');
  if (res.decision.action === 'allow') return go();
  renderBlock(res.decision);
  renderPartner(res);
  setInterval(poll, 5000);
}

init();
