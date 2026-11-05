// Shared by the extension and the companion page (identical copies).
// Pure WebCrypto Ed25519, no dependencies. Works in browsers, MV3 service workers and Node 20+.

const enc = new TextEncoder();

export const b64u = {
  encode(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const p = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

// No I, L, O, 0, 1 to avoid mix-ups when the partner writes the code down.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PBKDF2_SALT = 'brainrot-buddy-v2';
const PBKDF2_ITERATIONS = 1000000; // slows down guessing a short PIN against the public key
export const PIN_MIN = 6;
export const PIN_MAX = 64;
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** 20 random characters in 5 groups of 4 (about 99 bits), e.g. "K7QM-X2PD-9RTA-WN4H-C6VB". */
export function generatePassphrase() {
  const chars = [];
  const limit = 256 - (256 % ALPHABET.length); // rejection sampling, no modulo bias
  while (chars.length < 20) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && chars.length < 20) chars.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return chars.join('').match(/.{4}/g).join('-');
}

/** The partner's secret can be a PIN or any passphrase. Spaces, dashes and letter case don't matter. */
export function normalizePassphrase(s) {
  return String(s).normalize('NFKC').toUpperCase().replace(/[\s-]/g, '');
}

/** Returns an error message for an unusable PIN/passphrase, or '' if it is fine. */
export function pinProblem(s) {
  const n = normalizePassphrase(s).length;
  if (n < PIN_MIN) return `Use at least ${PIN_MIN} characters.`;
  if (n > PIN_MAX) return `Use at most ${PIN_MAX} characters.`;
  return '';
}

/** False in browsers without WebCrypto Ed25519 (older in-app browsers), so the page can say so instead of failing. */
export async function supportsEd25519() {
  try {
    await crypto.subtle.generateKey('Ed25519', false, ['sign']);
    return true;
  } catch {
    return false;
  }
}

/** Derive the partner's Ed25519 keypair from their PIN/passphrase. Returns { privateKey, publicKey } (publicKey = base64url raw, 43 chars). */
export async function deriveKeyPair(passphrase) {
  const normalized = normalizePassphrase(passphrase);
  const problem = pinProblem(passphrase);
  if (problem) throw new Error(problem);
  const material = await crypto.subtle.importKey('raw', enc.encode(normalized), 'PBKDF2', false, ['deriveBits']);
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(PBKDF2_SALT), iterations: PBKDF2_ITERATIONS },
      material,
      256,
    ),
  );
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  return { privateKey, publicKey: jwk.x };
}

/** Sign a UTF-8 string, returns the base64url signature (86 chars). */
export async function sign(privateKey, message) {
  const sig = await crypto.subtle.sign('Ed25519', privateKey, enc.encode(message));
  return b64u.encode(new Uint8Array(sig));
}

/** Verify a base64url signature against a base64url raw public key. Never throws. */
export async function verify(publicKey, message, signature) {
  try {
    const key = await crypto.subtle.importKey('raw', b64u.decode(publicKey), 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, b64u.decode(signature), enc.encode(message));
  } catch {
    return false;
  }
}
