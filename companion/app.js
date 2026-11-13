// Companion page: pairing (setup), approval of requests, and the approval link.
// All request data comes from the URL fragment. The passphrase only lives in the input and in memory, never in storage.
import { generatePassphrase, normalizePassphrase, pinProblem, supportsEd25519, deriveKeyPair, sign } from './crypto.js';
import { approvalMessage, buildApprovalUrl, parseFragment } from './protocol.js';

const app = document.getElementById('app');

const DEFAULT_WHAT = {
  EXTEND: 'Asks for more time on a site.',
  REMOVE_SITE: 'Asks to remove a site from a list.',
  REMOVE_LIST: 'Asks to remove a whole list.',
  EDIT_LIST: 'Asks to loosen a list.',
  ADULT_OFF: 'Asks to turn off the adult-content block.',
  INCOGNITO_OFF: 'Asks to turn off blocking in incognito windows.',
  REPAIR: 'Asks to replace the pairing code.',
};

/** Tiny DOM builder. Strings become text nodes, so user data is never parsed as HTML. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter((c) => c !== undefined && c !== null && c !== false));
  return node;
}

function say(node, msg, isError = false) {
  node.textContent = msg;
  node.classList.toggle('error', isError);
}

/** Disables every control on the page while a key derivation runs. */
function setBusy(on, status, msg = '', isError = false) {
  app.querySelectorAll('button, input, select').forEach((c) => (c.disabled = on));
  say(status, on ? 'Working…' : msg, isError);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for contexts without the async clipboard API.
    const ta = h('textarea', { class: 'offscreen', readonly: true });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function copyButton(label, getText) {
  const button = h('button', { type: 'button', class: 'secondary copy', 'aria-live': 'polite', text: label });
  button.addEventListener('click', async () => {
    const ok = await copyText(getText());
    button.textContent = ok ? 'Copied' : 'Copy failed. Select the text and copy it by hand.';
    setTimeout(() => (button.textContent = label), 1500);
  });
  return button;
}

// ---------- Setup route ----------

// generated is set only when the page made the secret itself, so the partner can write it down.
function pairingNodes(publicKey, generated) {
  const nodes = [];
  if (generated) {
    nodes.push(
      h('h2', { text: '1. Your passphrase' }),
      h('div', { class: 'secret', text: generated }),
      copyButton('Copy passphrase', () => generated),
      h('p', { class: 'warn', text: 'Write this down. Do not tell the person you are helping.' }),
    );
  }
  nodes.push(
    h('h2', { text: generated ? '2. Pairing code' : 'Pairing code' }),
    h('div', { class: 'code', text: publicKey }),
    copyButton('Copy pairing code', () => publicKey),
    h('p', {
      class: 'hint',
      text: 'Send only this pairing code to the person you are helping. Keep your PIN to yourself: you need it to approve their requests, and it cannot be recovered.',
    }),
  );
  return nodes;
}

function renderSetup() {
  const status = h('p', { class: 'status', role: 'status' });
  const output = h('div', { 'aria-live': 'polite' });
  const field = (id, placeholder) =>
    h('input', { id, type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder });
  const pin = field('pin', 'e.g. 482915');
  const again = field('pin2', 'Same PIN again');

  async function pair(secret, generated) {
    setBusy(true, status);
    try {
      const { publicKey } = await deriveKeyPair(secret);
      output.replaceChildren(...pairingNodes(publicKey, generated ? secret : null));
      pin.value = '';
      again.value = '';
      setBusy(false, status);
    } catch {
      setBusy(false, status, 'Could not create the pairing code. Try again.', true);
    }
  }

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: (e) => {
        e.preventDefault();
        const problem = pinProblem(pin.value);
        if (problem) return say(status, problem, true);
        if (normalizePassphrase(pin.value) !== normalizePassphrase(again.value)) {
          return say(status, 'The two entries do not match.', true);
        }
        pair(pin.value, false);
      },
    },
    h(
      'div',
      {},
      h('label', { for: 'pin', text: 'Choose your PIN' }),
      pin,
      h('p', {
        class: 'hint',
        text: 'At least 6 digits (longer is safer). Only you may know it, never the person you are helping. You will type it every time you approve something.',
      }),
    ),
    h('div', {}, h('label', { for: 'pin2', text: 'Repeat your PIN' }), again),
    h('button', { type: 'submit', class: 'primary block', text: 'Show pairing code' }),
    h('p', { class: 'hint', text: 'Already set a PIN before? Enter it twice to see the same pairing code again.' }),
  );

  const generate = h('button', {
    type: 'button',
    class: 'secondary block',
    text: 'Or generate a strong random passphrase',
    onclick: () => pair(generatePassphrase(), true),
  });

  app.replaceChildren(
    h('h1', { text: 'Partner setup' }),
    h('p', { class: 'hint', text: 'Pair Brainrot Buddy once, before the person locks in their settings.' }),
    form,
    generate,
    status,
    output,
  );
}

// ---------- Request route ----------

function approvalNodes(url) {
  const box = h('textarea', { class: 'link', readonly: true, rows: 4, 'aria-label': 'Approval link' });
  box.value = url;
  box.addEventListener('click', () => box.select());
  return [
    h('h2', { text: 'Approval link' }),
    box,
    copyButton('Copy link', () => url),
    h('p', { class: 'hint', text: 'Send this link back to them. It only works on their computer.' }),
  ];
}

function renderRequest(req) {
  const isExtend = req.action === 'EXTEND';
  const status = h('p', { class: 'status', role: 'status' });
  const output = h('div', { 'aria-live': 'polite' });

  const passInput = h('input', {
    id: 'pp',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'pp-hint',
  });

  // Starts at the requested minutes; the partner can type or step to any whole number from 1 to 1440 (24 hours).
  const select = h('input', {
    id: 'mins',
    type: 'number',
    min: '1',
    max: '1440',
    step: '1',
    inputmode: 'numeric',
    value: String(Math.min(1440, Math.max(1, Math.round(req.minutes) || 10))),
  });

  const approve = h('button', { type: 'button', class: 'primary', text: 'Approve' });
  const deny = h('button', { type: 'button', class: 'secondary', text: 'Deny' });

  // After approving or denying, nothing else can be changed on this request.
  const lock = () => [approve, deny, passInput, select].forEach((c) => (c.disabled = true));

  approve.addEventListener('click', async () => {
    const passphrase = passInput.value;
    const problem = pinProblem(passphrase);
    if (problem) return say(status, `Enter your PIN. ${problem}`, true);
    const minutes = isExtend ? Number(select.value) : 0;
    if (isExtend && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
      return say(status, 'Enter a whole number of minutes from 1 to 1440 (24 hours).', true);
    }
    setBusy(true, status);
    try {
      const { privateKey, publicKey } = await deriveKeyPair(passphrase);
      if (req.pubFp && !publicKey.startsWith(req.pubFp)) return setBusy(false, status, 'Wrong PIN.', true);
      const signature = await sign(
        privateKey,
        approvalMessage({ id: req.id, action: req.action, site: req.site, minutes }),
      );
      const url = buildApprovalUrl(location.origin + location.pathname, { id: req.id, minutes, signature });
      passInput.value = '';
      output.replaceChildren(...approvalNodes(url));
      lock();
      say(status, 'Approved.');
      status.classList.add('ok');
    } catch {
      setBusy(false, status, 'Something went wrong. Try again.', true);
    }
  });

  deny.addEventListener('click', () => {
    lock();
    say(status, 'Denied: tell the user no');
  });

  // The headline already names the site and minutes, so only add them when it does not.
  const what = req.desc || DEFAULT_WHAT[req.action] || 'Asks for a change.';
  const showSite = req.site && !what.includes(req.site);

  app.replaceChildren(
    h('h1', { text: 'Approval request' }),
    h(
      'div',
      { class: 'summary' },
      h('p', { class: 'what', text: what }),
      showSite ? h('p', { class: 'hint', text: req.site }) : null,
      req.note ? h('p', { class: 'note', text: req.note }) : null,
    ),
    h(
      'div',
      { class: 'fields' },
      isExtend ? h('div', {}, h('label', { for: 'mins', text: 'Duration' }), select) : null,
      h('div', {}, h('label', { for: 'pp', text: 'Your PIN' }), passInput),
    ),
    h('p', {
      id: 'pp-hint',
      class: 'hint',
      text: `Your PIN is used only to sign here. It is never sent anywhere.`,
    }),
    h('div', { class: 'actions' }, approve, deny),
    status,
    output,
  );
}

// ---------- Other routes ----------

function renderApproval() {
  app.replaceChildren(
    h('h1', { text: 'Brainrot Buddy' }),
    h('p', { text: 'This approval link only works on the computer running Brainrot Buddy. Open it there.' }),
  );
}

function renderInvalid() {
  app.replaceChildren(
    h('h1', { text: 'Link not valid' }),
    h('p', { text: 'This link is incomplete or damaged. Ask the person to send it again.' }),
    h('p', {}, h('a', { href: '#setup', text: 'Partner setup' })),
  );
}

function renderUnsupported() {
  app.replaceChildren(
    h('h1', { text: 'Browser not supported' }),
    h('p', {
      text: 'This page needs a recent browser (Microsoft Edge 137+, Chrome 137+, Safari 17+ or Firefox 129+). If you opened the link inside another app, open it in your regular browser instead.',
    }),
  );
}

async function route() {
  const r = parseFragment(location.hash);
  if ((r.type === 'request' || r.type === 'setup') && !(await supportsEd25519())) return renderUnsupported();
  if (r.type === 'request') renderRequest(r.req);
  else if (r.type === 'approval') renderApproval();
  else if (r.type === 'invalid') renderInvalid();
  else renderSetup();
}

window.addEventListener('hashchange', route);
route();
