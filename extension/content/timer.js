// On-page countdown (top-left corner) for timed sites. Plain content script: no imports, no page access.
// The background decides what is timed; this only draws it. Counts down locally and re-syncs every few seconds.
(() => {
  if (window.top !== window) return;

  const SYNC_MS = 5000;
  let host = null; // element holding the shadow root
  let label = null;
  let endsAt = 0; // 0 = nothing to show

  function format(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function hide() {
    if (host) host.remove();
    host = label = null;
  }

  function show() {
    if (host) return;
    host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .t { position: fixed; top: 8px; left: 8px; z-index: 2147483647; pointer-events: none;
           font: 600 13px/1 system-ui, sans-serif; color: #fff; background: rgba(20, 20, 24, 0.78);
           padding: 6px 9px; border-radius: 8px; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
           font-variant-numeric: tabular-nums; }
      .t.low { background: rgba(190, 30, 30, 0.92); }`;
    label = document.createElement('div');
    label.className = 't';
    root.append(style, label);
    document.documentElement.append(host);
  }

  function render() {
    // An element in fullscreen already covers this overlay; hiding it explicitly keeps it from reappearing oddly.
    if (!endsAt || document.fullscreenElement) return hide();
    show();
    const left = endsAt - Date.now();
    label.textContent = format(left);
    label.classList.toggle('low', left < 60000);
  }

  async function sync() {
    if (document.visibilityState !== 'visible') return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'timerInfo' });
      const t = res && res.ok ? res.timer : null;
      endsAt = t ? Date.now() + t.remainingMs : 0;
    } catch {
      endsAt = 0; // extension was reloaded or removed
    }
    render();
  }

  setInterval(render, 1000);
  setInterval(sync, SYNC_MS);
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('focus', sync);
  document.addEventListener('fullscreenchange', render);
  sync();
})();
