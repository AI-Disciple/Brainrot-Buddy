// Brainrot timer: counts down, then lets the site load. It only counts while this tab is visible and focused.
const $ = (id) => document.getElementById(id);
const u = new URLSearchParams(location.search).get('u') || '';
let timer = null;
let finished = false;

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

const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function fail(text) {
  $('error').textContent = text;
  $('error').hidden = false;
}

$('back').addEventListener('click', async () => {
  finished = true;
  clearInterval(timer);
  try {
    await chrome.tabs.update({ url: 'chrome://newtab' });
  } catch {
    history.back();
  }
});

// Only time spent actively on this tab counts: the tab must be visible and the window focused.
const isActive = () => document.visibilityState === 'visible' && document.hasFocus();

function start(secs) {
  const total = secs * 1000;
  let left = total;
  let last = performance.now();
  let wasActive = isActive();

  // Counts the time since the last sample, but only if the tab was active for all of it.
  // Time away is never added back, and one step is capped so a stalled tab can't skip ahead.
  const sample = () => {
    const now = performance.now();
    const active = isActive();
    if (active && wasActive) left = Math.max(0, left - Math.min(now - last, 1000));
    wasActive = active;
    last = now;
    return active;
  };

  const tick = async () => {
    const active = sample();
    $('count').textContent = fmt(Math.ceil(left / 1000));
    $('count').classList.toggle('paused', !active);
    $('fill').style.width = `${Math.min(100, ((total - left) * 100) / total)}%`;
    $('note').textContent = active ? 'The site opens when the timer ends.' : 'Paused. Come back to this tab to continue.';
    if (left === 0 && !finished) {
      finished = true;
      clearInterval(timer);
      await send({ type: 'delayDone', url: u });
      go();
    }
  };

  // Sampling on these events keeps a quick tab switch from being counted as time on the page.
  document.addEventListener('visibilitychange', sample);
  window.addEventListener('blur', sample);
  window.addEventListener('focus', sample);

  timer = setInterval(tick, 250);
  tick();
}

async function init() {
  if (!u) return fail('No address to check.');
  const res = await send({ type: 'getBlockInfo', url: u });
  if (!res.ok || !res.decision) return fail(res.error || 'Could not check this site.');
  const d = res.decision;
  if (d.action !== 'delay') return go();
  $('site').textContent = d.site || '';
  start(Number(d.delaySeconds) || 0);
}

init();
