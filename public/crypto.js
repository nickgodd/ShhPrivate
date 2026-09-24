// All cryptography happens here, in the browser. The server only ever relays
// opaque base64 ciphertext. Private keys never leave this module's memory.
//
// Scheme:
//   - Identity:      one X25519 keypair per session (created once, in RAM).
//   - Per-chat keys: a FRESH ephemeral X25519 keypair per chat (forward secrecy).
//   - Shared secret: ECDH(ephA_priv, ephB_pub) == ECDH(ephB_priv, ephA_pub).
//   - Key schedule:  HKDF-SHA256(ecdh, salt=sortedEphPubs, info="shh-chat-v1") -> AES-256.
//   - Message AEAD:  AES-256-GCM with a fresh random 96-bit nonce per message.
//   - Fingerprint:   SHA-256 over the identity + ephemeral public keys (MITM check).

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const INFO = new TextEncoder().encode('shh-chat-v1');
const PLAINTEXT_MAX = 2048; // 2 KB hard cap

// ---- Byte / string helpers ------------------------------------------------
export function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concatBytes(list) {
  const total = list.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

// Cryptographically-random base32 identifier, 12 chars (>= 12 required).
export function randomId() {
  const buf = crypto.getRandomValues(new Uint8Array(15));
  let s = '';
  for (let i = 0; i < 12; i++) s += BASE32[buf[i] & 31];
  return s;
}

// Anything typed, pasted or scanned is reduced to a candidate id: unambiguous
// base32, 12..16 chars, otherwise null. A key, a URL or a fragment of text can
// never be mistaken for an identity.
export function parseId(text) {
  const s = String(text || '').trim().toUpperCase().replace(/[^A-Z2-7]/g, '');
  return s.length >= 12 && s.length <= 16 ? s : null;
}

// Strict form, used for anything read out of a QR code: the whole payload must be
// an id, so a URL, a key or a message body can never be searched for by accident.
export function isId(text) {
  return /^[A-Z2-7]{12,16}$/.test(String(text || '').trim().toUpperCase());
}

// ---- Compact synchronous SHA-256 (used only to solve the PoW quickly) ------
// SHA-256 round constants are derived from the first primes so the table is
// always correct (no hand-typed magic numbers to get wrong):
//   K[i] = frac(cbrt(prime_i)) * 2^32 ;  H[j] = frac(sqrt(prime_j)) * 2^32
function firstPrimes(n) {
  const out = [];
  for (let x = 2; out.length < n; x++) {
    let prime = true;
    for (let d = 2; d * d <= x; d++) if (x % d === 0) { prime = false; break; }
    if (prime) out.push(x);
  }
  return out;
}
function fracRoot(p, root) {
  const v = Math.pow(p, 1 / root);
  return Math.floor((v - Math.floor(v)) * 4294967296) >>> 0;
}
const SHA_K = firstPrimes(64).map((p) => fracRoot(p, 3));
const SHA_H0 = firstPrimes(8).map((p) => fracRoot(p, 2));

export function sha256Bytes(msg) {
  const K = SHA_K;
  const H = SHA_H0.slice();
  const len = msg.length;
  const bitLen = len * 8;
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPad.set(msg);
  withPad[len] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
  return out;
}
function hex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

// Brute-force a nonce so that SHA-256(challenge:nonce) has `difficulty` leading
// hex zeros. Yields to the event loop periodically to keep the UI responsive.
export async function solvePoW(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty);
  const enc = new TextEncoder();
  const head = enc.encode(challenge + ':');
  const nonceBytes = new Uint8Array(16);
  for (let n = 0; n < 5_000_000; n++) {
    const tail = enc.encode(String(n));
    const buf = concatBytes([head, tail]);
    if (hex(sha256Bytes(buf)).startsWith(prefix)) return n;
    if ((n & 0x3fff) === 0) await new Promise((r) => setTimeout(r, 0)); // yield
  }
  throw new Error('pow_exhausted');
}

// ---- Key material ---------------------------------------------------------
// ECDH curve negotiation. X25519 is the intended curve (matches the spec and is
// supported by current Chrome/Firefox/Safari). If an engine lacks it, we fall
// back to P-256 so the app still works everywhere. The curve is implied by the
// raw public-key byte length (X25519 = 32, P-256 = 65), so two peers always
// agree on whichever curve the initiator used — no extra handshake needed.
const CURVES = {
  X25519: { name: 'ECDH', namedCurve: 'X25519' },
  'P-256': { name: 'ECDH', namedCurve: 'P-256' },
};
let preferredCurve = null; // resolved once via probe

async function tryCurve(curve) {
  try {
    await crypto.subtle.generateKey(curve, true, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

// Resolve (and cache) the best ECDH curve this browser supports.
export async function detectCurve() {
  if (preferredCurve) return preferredCurve;
  if (await tryCurve(CURVES.X25519)) preferredCurve = CURVES.X25519;
  else if (await tryCurve(CURVES['P-256'])) preferredCurve = CURVES['P-256'];
  else preferredCurve = null;
  return preferredCurve;
}

async function ecdhKeypair(curve) {
  const c = curve || (await detectCurve());
  if (!c) throw new Error('no_ecdh_curve');
  const kp = await crypto.subtle.generateKey(c, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { privateKey: kp.privateKey, publicB64: bytesToB64(raw), publicBytes: raw };
}

export function generateIdentity() {
  return ecdhKeypair();
}
export function generateEphemeral(curve) {
  return ecdhKeypair(curve);
}

// Curve implied by a base64 public key, or null if the length is unknown.
export function curveFromPubB64(publicB64) {
  const n = b64ToBytes(publicB64).length;
  if (n === 32) return CURVES.X25519;
  if (n === 65) return CURVES['P-256'];
  return null;
}

async function importPub(publicB64) {
  const bytes = b64ToBytes(publicB64);
  const curve = bytes.length === 65 ? CURVES['P-256'] : CURVES.X25519;
  return crypto.subtle.importKey('raw', bytes, curve, true, []);
}
function sortPair(a, b) {
  return [a, b].sort((x, y) => (bytesToB64(x) < bytesToB64(y) ? -1 : 1));
}

// Derive the shared AES-256-GCM key for a chat. Both sides compute an identical
// key: ECDH + HKDF with an order-independent salt built from the ephemeral pubs.
export async function deriveChatKey(myEcdh, theirEphPubB64) {
  const theirPub = await importPub(theirEphPubB64);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirPub }, myEcdh.privateKey, 256);

  const myPubBytes = myEcdh.publicBytes;
  const theirPubBytes = b64ToBytes(theirEphPubB64);
  const [s1, s2] = sortPair(myPubBytes, theirPubBytes);
  const salt = concatBytes([s1, s2]);

  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return key;
}

// Human-checkable fingerprint. Both peers compute the same value; compare it out
// of band to rule out a man-in-the-middle. Mixes identity + ephemeral keys.
export function computeFingerprint(myIdentityB64, theirIdentityB64, myEphB64, theirEphB64) {
  const ids = sortPair(b64ToBytes(myIdentityB64), b64ToBytes(theirIdentityB64));
  const ephs = sortPair(b64ToBytes(myEphB64), b64ToBytes(theirEphB64));
  const digest = sha256Bytes(concatBytes([ids[0], ids[1], ephs[0], ephs[1], INFO]));
  const h = hex(digest).slice(0, 16).toUpperCase();
  return h.match(/.{1,4}/g).join(' ');
}

// ---- Message encryption ---------------------------------------------------
export function overSize(plaintext) {
  return new TextEncoder().encode(plaintext).length > PLAINTEXT_MAX;
}

export async function encryptMessage(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // unique 96-bit nonce
  const data = new TextEncoder().encode(plaintext);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return bytesToB64(concatBytes([iv, ct])); // base64(iv || ciphertext||tag)
}

export async function decryptMessage(key, b64) {
  const raw = b64ToBytes(b64);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(plain);
}

// ---- Attachment encryption ------------------------------------------------
// Same chat key, same AEAD, a fresh 96-bit nonce per chunk (never reused). Files
// travel as 64 KB slices so one WebSocket frame stays small and progress is
// visible. The server sees opaque base64 and cannot reassemble anything useful.
export const CHUNK_PLAIN_MAX = 64 * 1024;
export const FILE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export async function encryptChunk(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return bytesToB64(concatBytes([iv, ct]));
}

export async function decryptChunk(key, b64) {
  const raw = b64ToBytes(b64);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

// Random, non-sequential transfer id (visible to the server as an opaque label).
export function randomTransferId() {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(9)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
