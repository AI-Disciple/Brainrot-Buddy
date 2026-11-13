// Shared by the extension and the companion page (identical copies).
// Request/approval link format. All data lives in the URL fragment (#...), which is never sent to a server.

import { b64u } from './crypto.js';

export const ACTIONS = ['EXTEND', 'REMOVE_SITE', 'REMOVE_LIST', 'EDIT_LIST', 'ADULT_OFF', 'INCOGNITO_OFF', 'REPAIR'];

const ID_RE = /^[A-Za-z0-9_-]{11,22}$/; // new ids are 11 chars; longer ones from older versions still parse
const PUB_RE = /^[A-Za-z0-9_-]{43}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

export function isPublicKey(s) {
  return typeof s === 'string' && PUB_RE.test(s);
}

export function randomId() {
  return b64u.encode(crypto.getRandomValues(new Uint8Array(8))); // single-use and tied to one pending request, so 64 bits is plenty
}

/** The exact string the partner signs. minutes is 0 for every action except EXTEND. */
export function approvalMessage({ id, action, site, minutes }) {
  return [id, action, site, minutes].join('|');
}

function clip(s, max) {
  return typeof s === 'string' ? s.slice(0, max) : '';
}

function stripHash(url) {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

// Compact request format: id~actionIndex~minutes~pubFingerprint~site~note[~desc], each part URL-encoded.
// The description is only sent for actions other than EXTEND (for EXTEND the page rebuilds it).
const part = (s) => encodeURIComponent(String(s ?? '')).replace(/~/g, '%7E');

export function encodeRequest(r) {
  const fields = [r.id, ACTIONS.indexOf(r.action), r.minutes, (r.pub || '').slice(0, 8), clip(r.site, 200), clip(r.note, 500)];
  if (r.action !== 'EXTEND' && r.desc) fields.push(clip(r.desc, 500));
  return fields.map(part).join('~');
}

/** Returns a validated request object or null. pubFp is the first 8 chars of the partner's public key (typo check only). */
export function decodeRequest(str) {
  try {
    const p = String(str).split('~').map(decodeURIComponent);
    if (p.length < 6 || p.length > 7) return null;
    const [id, a, m, pubFp, site, note, desc = ''] = p;
    if (!/^\d+$/.test(a) || !/^\d+$/.test(m)) return null;
    const action = ACTIONS[Number(a)];
    const minutes = Number(m);
    if (!action || !ID_RE.test(id) || minutes > 1440 || site.length > 200 || !/^[A-Za-z0-9_-]{0,8}$/.test(pubFp)) return null;
    return {
      id,
      action,
      site,
      minutes,
      note: clip(note, 500),
      desc: clip(desc, 500) || (action === 'EXTEND' ? `${minutes} min on ${site}` : ''),
      pubFp,
    };
  } catch {
    return null;
  }
}

export function buildRequestUrl(base, req) {
  return `${stripHash(base)}#r=${encodeRequest(req)}`;
}

export function buildApprovalUrl(base, { id, minutes, signature }) {
  return `${stripHash(base)}#a=${id}.${minutes}.${signature}`;
}

/**
 * Parse a location hash. Returns one of:
 *   { type: 'setup' } | { type: 'request', req } | { type: 'approval', id, minutes, signature } | { type: 'invalid' }
 */
export function parseFragment(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (h === '' || h === 'setup') return { type: 'setup' };
  if (h.startsWith('r=')) {
    const req = decodeRequest(h.slice(2));
    return req ? { type: 'request', req } : { type: 'invalid' };
  }
  if (h.startsWith('a=')) {
    const [id, m, signature] = h.slice(2).split('.');
    const minutes = Number(m);
    if (ID_RE.test(id || '') && Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 && SIG_RE.test(signature || '')) {
      return { type: 'approval', id, minutes, signature };
    }
  }
  return { type: 'invalid' };
}
