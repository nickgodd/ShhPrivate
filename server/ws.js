// WebSocket relay: purely forwards ciphertext. It never sees plaintext or keys.
// ALL state is in RAM. No database. No logs. Client IPs are never stored.
import crypto from 'node:crypto';

// ---- Tunables -------------------------------------------------------------
const POW_DIFFICULTY = 4;              // leading hex zeros required
const POW_NONCE_MAX = 5_000_000;       // bound brute-force work per attempt
const GRACE_MS = 8_000;                // reconnect window after a tab closes
const CIPHER_MAX_BYTES = 2048 + 64;    // 2 KB plaintext + IV(12)+tag(16) slack
const ID_RE = /^[A-Z2-7]{12,16}$/;     // base32, 12+ chars
// File relay. The server never reassembles, stores or inspects a file: it forwards
// opaque encrypted chunks one frame at a time. These caps protect RAM only, they
// are not a confidentiality measure (the server cannot read the payload anyway).
const FILE_MAX_BYTES = 5 * 1024 * 1024;          // 5 MB per file, hard cap
const CHUNK_MAX_CIPHER_BYTES = 64 * 1024 + 64;  // 64 KB plaintext + IV(12) + tag(16)
const CHUNK_MAX_CIPHER_B64 = Math.ceil(CHUNK_MAX_CIPHER_BYTES / 3) * 4 + 8;
const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{6,24}$/;
const TRANSFER_TIMEOUT_MS = 120_000;             // abandon a half-declared transfer
const MAX_ACTIVE_TRANSFERS = 200;                // process-wide bookkeeping ceiling
const PEER_SLOW_BYTES = 4 * 1024 * 1024;         // backpressure: never queue more
// Accepted public-key base64 lengths: X25519 raw (32B -> 44 chars) or P-256 raw
// uncompressed point (65B -> 88 chars). The client negotiates the curve.
const PUBKEY_B64_LENS = new Set([44, 88]);

// Per-connection token buckets: [capacity, refillPerSec]
const LIMITS = {
  search: [10, 10 / 30],               // anti ID-enumeration
  contact: [5, 5 / 60],                // anti spam requests
  message: [40, 40 / 20],              // burst then steady
  create: [3, 3 / 60],
  file: [8, 8 / 60],                   // file declarations
  chunk: [300, 300 / 20],              // ~64 KB * 300 = 19 MB per 20 s burst
  fileBytes: [24 * 1024 * 1024, 2 * 1024 * 1024], // byte quota: 2 MB/s steady
};

// ---- In-memory state ------------------------------------------------------
const byId = new Map();    // id -> session
const bySocket = new Map(); // ws  -> conn
const requests = new Map(); // requestId -> { from, to, expiry }
// "Chat" == mutual membership in session.peers. An in-flight file transfer is
// tracked purely as metadata (ids, counters, expiry) so a client cannot stream
// frames it never declared. No file bytes are ever held here.
const transfers = new Map(); // `${from}>${to}:${transferId}` -> { expect, got, expiry }

function newId() {
  return crypto.randomBytes(10).toString('base64url');
}

function now() {
  return Date.now();
}

// ---- Rate limiting --------------------------------------------------------
class Bucket {
  constructor(cap, refill) {
    this.cap = cap;
    this.tokens = cap;
    this.refill = refill;
    this.last = now();
  }
  take(n = 1) {
    const t = now();
    this.tokens = Math.min(this.cap, this.tokens + ((t - this.last) / 1000) * this.refill);
    this.last = t;
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}

function allow(conn, action, weight = 1) {
  const [cap, refill] = LIMITS[action];
  const key = action;
  let b = conn.buckets.get(key);
  if (!b) {
    b = new Bucket(cap, refill);
    conn.buckets.set(key, b);
  }
  return b.take(weight);
}

// ---- Helpers --------------------------------------------------------------
function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* ignore broken pipe */
    }
  }
}

function sendToId(id, obj) {
  const s = byId.get(id);
  if (s && s.ws) send(s.ws, obj);
}

function notifyPeers(id, obj) {
  const s = byId.get(id);
  if (!s) return;
  for (const peer of s.peers) sendToId(peer, obj);
}

function fail(conn, message) {
  send(conn.ws, { type: 'error', message });
}

// File errors also carry the transfer id, so the sender can fail the right
// attachment instead of guessing which chat is on screen.
function failFile(conn, message, transferId) {
  send(conn.ws, transferId ? { type: 'error', message, transferId } : { type: 'error', message });
}

// A chat exists only while BOTH sessions still hold each other in `peers`.
// Once a side is gone (chat ended, or the other session was torn down after the
// grace window) there is no adjacency, so delivery is refused: a leftover chat is
// read-only by construction, never a hole you can write into.
function hasChat(a, b) {
  return !!a && !!b && a !== b && a.peers.has(b.id) && b.peers.has(a.id);
}

// ---- Proof of work --------------------------------------------------------
function issuePow(conn) {
  const challenge = crypto.randomBytes(16).toString('hex');
  conn.pow = { challenge, issued: now() };
  send(conn.ws, { type: 'pow_challenge', challenge, difficulty: POW_DIFFICULTY });
}

function verifyPow(conn, challenge, nonce) {
  if (!conn.pow || conn.pow.challenge !== challenge) return false;
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > POW_NONCE_MAX) return false;
  const digest = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest('hex');
  return digest.startsWith('0'.repeat(POW_DIFFICULTY));
}

function validB64Key(s) {
  return typeof s === 'string' && PUBKEY_B64_LENS.has(s.length);
}

function validCipher(s) {
  return validCipherWithin(s, CIPHER_MAX_BYTES, CIPHER_MAX_BYTES * 2);
}

// Base64 shape check without decoding the whole payload when the length already
// gives it away. Used for both 2 KB messages and 64 KB file chunks.
function validCipherWithin(s, maxBytes, quickMaxLen) {
  if (typeof s !== 'string' || s.length === 0 || s.length > quickMaxLen) return false;
  let raw;
  try {
    raw = Buffer.from(s, 'base64');
  } catch {
    return false;
  }
  return raw.length > 0 && raw.length <= maxBytes;
}

// ---- File transfer bookkeeping -------------------------------------------
function transferKey(from, to, transferId) {
  return `${from}>${to}:${transferId}`;
}

function dropTransfersFor(id) {
  for (const [k, t] of transfers) {
    if (t.from === id || t.to === id) transfers.delete(k);
  }
}

// ---- Session lifecycle ----------------------------------------------------
function teardown(session) {
  // Fully remove a session and its chat relationships. No queues are kept.
  const peers = [...session.peers];
  byId.delete(session.id);
  dropTransfersFor(session.id);
  for (const peer of peers) {
    const p = byId.get(peer);
    if (p) p.peers.delete(session.id);
    // Tell the survivor the departure is final: its chat flips to read-only and
    // offers "Удалить чат". We must NOT send chat_ended here, or the survivor
    // would wipe history the user never asked to delete.
    if (p && p.ws) send(p.ws, { type: 'peer_gone', id: session.id });
  }
  session.peers.clear();
}

function handleDisconnect(conn) {
  bySocket.delete(conn.ws);
  dropTransfersFor(conn.session?.id);
  const session = conn.session;
  if (!session || session.ws !== conn.ws) {
    conn.ws = null;
    return;
  }
  // Immediately stop delivery (peer looks offline) and inform peers.
  session.ws = null;
  notifyPeers(session.id, { type: 'peer_left', id: session.id });

  // Small grace period: a page refresh may reconnect and reuse the id. If it
  // does, peers get peer_back and their composer unlocks; if it does not,
  // teardown() escalates to the irreversible peer_gone.
  session.graceTimer = setTimeout(() => {
    if (session.ws === null) teardown(session);
  }, GRACE_MS);
}

function createSession(conn, { id, publicKey, pow }) {
  if (!allow(conn, 'create')) {
    return fail(conn, 'rate_limited:create');
  }
  if (typeof id !== 'string' || !ID_RE.test(id)) return fail(conn, 'bad_id');
  if (!validB64Key(publicKey)) return fail(conn, 'bad_key');
  if (!verifyPow(conn, pow?.challenge, pow?.nonce)) return fail(conn, 'bad_pow');

  const existing = byId.get(id);
  if (existing) {
    // Reconnect within the grace window only if the identity key matches.
    if (existing.ws || existing.publicKey !== publicKey) {
      return fail(conn, 'id_taken');
    }
    clearTimeout(existing.graceTimer);
    existing.graceTimer = null;
    existing.ws = conn.ws;
    conn.session = existing;
    bySocket.set(conn.ws, conn);
    send(conn.ws, { type: 'session_created', id, publicKey: existing.publicKey, resumed: true });
    notifyPeers(id, { type: 'peer_back', id });
    return;
  }

  const session = { id, publicKey, ws: conn.ws, peers: new Set(), graceTimer: null };
  byId.set(id, session);
  conn.session = session;
  conn.pow = null; // challenge is single-use
  send(conn.ws, { type: 'session_created', id, publicKey });
}

function search(conn, targetId) {
  if (!allow(conn, 'search')) return fail(conn, 'rate_limited:search');
  const found = byId.has(targetId) && !!byId.get(targetId).ws;
  // Only expose online presence; nothing else about the target.
  send(conn.ws, { type: 'search_result', targetId, found });
}

function contactRequest(conn, { to, fromId, publicKey, ephPub }) {
  if (!allow(conn, 'contact')) return fail(conn, 'rate_limited:contact');
  const target = byId.get(to);
  if (!target || !target.ws) return send(conn.ws, { type: 'contact_request_failed', to, reason: 'offline' });
  if (!validB64Key(publicKey) || !validB64Key(ephPub)) return fail(conn, 'bad_key');

  const requestId = newId();
  requests.set(requestId, { from: fromId, to, expiry: now() + 120_000 });
  // Tell the requester its request was delivered (pending state).
  send(conn.ws, { type: 'contact_request_sent', requestId, to });
  sendToId(to, {
    type: 'contact_request',
    requestId,
    from: fromId,
    publicKey,
    ephPub,
  });
}

function contactResponse(conn, { requestId, accept, to, fromId, publicKey, ephPub }) {
  const req = requests.get(requestId);
  if (!req || req.to !== conn.session?.id) return fail(conn, 'bad_request');
  requests.delete(requestId);

  const requester = byId.get(req.from);
  if (requester && requester.ws) {
    sendToId(req.from, {
      type: 'contact_response',
      requestId,
      from: fromId,
      accept: !!accept,
      publicKey: accept ? publicKey : undefined,
      ephPub: accept ? ephPub : undefined,
    });
  }

  if (accept && requester && requester.ws && validB64Key(ephPub) && validB64Key(publicKey)) {
    // Establish chat adjacency on both sides (metadata only, no content).
    requester.peers.add(conn.session.id);
    conn.session.peers.add(req.from);
  }
}

function relayMessage(conn, { to, ciphertext }) {
  if (!allow(conn, 'message')) return fail(conn, 'rate_limited:message');
  if (!validCipher(ciphertext)) return fail(conn, 'too_large');
  const target = byId.get(to);
  if (!hasChat(conn.session, target) || !target.ws) {
    // No store-and-forward (nothing is queued) and no writing into a chat the
    // other side has left: the frame is refused here, so a read-only chat is
    // read-only on the server too, not just in the UI.
    return send(conn.ws, { type: 'undeliverable', id: to });
  }
  sendToId(to, { type: 'message', from: conn.session.id, ciphertext });
}

// ---- File relay: opaque encrypted chunks, one per frame -------------------
function fileOpen(conn, { to, transferId, size, chunks }) {
  if (!allow(conn, 'file')) return fail(conn, 'rate_limited:file');
  const session = conn.session;
  const target = byId.get(to);
  if (!hasChat(session, target) || !target.ws) return send(conn.ws, { type: 'undeliverable', id: to });
  if (typeof transferId !== 'string' || !TRANSFER_ID_RE.test(transferId)) return failFile(conn, 'bad_transfer', transferId);
  if (!Number.isInteger(size) || size <= 0 || size > FILE_MAX_BYTES) return failFile(conn, 'file_too_large', transferId);
  if (!Number.isInteger(chunks) || chunks <= 0 || chunks > 200) return failFile(conn, 'bad_transfer', transferId);
  if (transfers.size >= MAX_ACTIVE_TRANSFERS) return failFile(conn, 'server_busy', transferId);

  const key = transferKey(session.id, to, transferId);
  if (transfers.has(key)) return failFile(conn, 'bad_transfer', transferId);
  // Only metadata is remembered: who, to whom, how many frames, when to forget.
  transfers.set(key, { from: session.id, to, expect: chunks, got: 0, expiry: now() + TRANSFER_TIMEOUT_MS });
  sendToId(to, { type: 'file_open', from: session.id, transferId, size, chunks });
}

function fileChunk(conn, { to, transferId, index, ciphertext }) {
  const session = conn.session;
  const key = transferKey(session.id, to, transferId);
  const t = transfers.get(key);
  // A chunk that was never declared by file_open is refused: that is what keeps
  // the byte and rate caps honest.
  if (!t) return failFile(conn, 'no_transfer', transferId);
  const target = byId.get(to);
  if (!hasChat(session, target) || !target.ws) {
    transfers.delete(key);
    return send(conn.ws, { type: 'file_aborted', id: to, transferId });
  }
  if (!Number.isInteger(index) || index < 0 || index >= t.expect) {
    transfers.delete(key);
    return failFile(conn, 'bad_chunk', transferId);
  }
  if (!validCipherWithin(ciphertext, CHUNK_MAX_CIPHER_BYTES, CHUNK_MAX_CIPHER_B64)) {
    transfers.delete(key);
    return failFile(conn, 'chunk_too_large', transferId);
  }
  if (!allow(conn, 'chunk') || !allow(conn, 'fileBytes', Math.ceil((ciphertext.length * 3) / 4))) {
    transfers.delete(key);
    return failFile(conn, 'rate_limited:file', transferId);
  }
  if (target.ws.bufferedAmount > PEER_SLOW_BYTES) {
    // The receiver cannot keep up: drop the transfer instead of growing the
    // server's socket buffers.
    transfers.delete(key);
    return failFile(conn, 'peer_slow', transferId);
  }
  sendToId(to, { type: 'file_chunk', from: session.id, transferId, index, ciphertext });
  t.got += 1;
  t.expiry = now() + TRANSFER_TIMEOUT_MS;
  if (t.got >= t.expect) transfers.delete(key); // finished -> forgotten
}

function fileAbort(conn, { to, transferId }) {
  if (!conn.session) return;
  transfers.delete(transferKey(conn.session.id, to, transferId));
  sendToId(to, { type: 'file_aborted', id: conn.session.id, transferId });
}

// ---- Chat teardown / deletion --------------------------------------------
function dropTransfersBetween(a, b) {
  for (const [k, t] of transfers) {
    if ((t.from === a && t.to === b) || (t.from === b && t.to === a)) transfers.delete(k);
  }
}

function dropRequestsBetween(a, b) {
  for (const [k, r] of requests) {
    if ((r.from === a && r.to === b) || (r.from === b && r.to === a)) requests.delete(k);
  }
}

function endChat(conn, { to }) {
  const session = conn.session;
  if (!session) return;
  session.peers.delete(to);
  const peer = byId.get(to);
  if (peer) peer.peers.delete(session.id);
  // Anything in flight for this pair dies with it.
  dropTransfersBetween(session.id, to);
  dropRequestsBetween(session.id, to);
  sendToId(to, { type: 'chat_ended', id: session.id });
  // Ack to the initiator too, so both UIs reset their notification state.
  send(conn.ws, { type: 'chat_ended', id: to });
}

// Local deletion of a chat that is already broken (the other side left). The
// server holds no history, so this only forgets the adjacency (if a ghost of it
// survived) and any transfer metadata. A live chat must be ended with end_chat.
function deleteChat(conn, { to }) {
  const session = conn.session;
  if (!session) return;
  const peer = byId.get(to);
  if (hasChat(session, peer)) return fail(conn, 'chat_active');
  session.peers.delete(to);
  if (peer) peer.peers.delete(session.id);
  dropTransfersBetween(session.id, to);
}

// Explicit "Выйти": no grace window, the session and every chat around it are
// finished right now, and each peer is told the departure is final.
function exitSession(conn) {
  const session = conn.session;
  if (!session || session.ws !== conn.ws) return;
  clearTimeout(session.graceTimer);
  session.graceTimer = null;
  session.ws = null;
  conn.session = null; // so the impending 'close' cannot re-arm the grace timer
  bySocket.delete(conn.ws);
  teardown(session);
}

// ---- Connection handler ---------------------------------------------------
export function attachWs(wss) {
  wss.on('connection', (ws) => {
    const conn = { ws, buckets: new Map(), session: null, pow: null };
    bySocket.set(ws, conn);

    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString('utf8'));
      } catch {
        return; // malformed frame, drop silently
      }
      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'pow_challenge':
          return issuePow(conn);
        case 'create_session':
          return createSession(conn, msg);
        case 'search':
          if (!conn.session) return fail(conn, 'no_session');
          return search(conn, String(msg.targetId || ''));
        case 'contact_request':
          if (!conn.session) return fail(conn, 'no_session');
          return contactRequest(conn, { ...msg, fromId: conn.session.id });
        case 'contact_response':
          if (!conn.session) return fail(conn, 'no_session');
          return contactResponse(conn, { ...msg, fromId: conn.session.id, publicKey: msg.publicKey, ephPub: msg.ephPub });
        case 'message':
          if (!conn.session) return fail(conn, 'no_session');
          return relayMessage(conn, msg);
        case 'end_chat':
          if (!conn.session) return fail(conn, 'no_session');
          return endChat(conn, msg);
        case 'delete_chat':
          if (!conn.session) return fail(conn, 'no_session');
          return deleteChat(conn, msg);
        case 'file_open':
          if (!conn.session) return fail(conn, 'no_session');
          return fileOpen(conn, msg);
        case 'file_chunk':
          if (!conn.session) return fail(conn, 'no_session');
          return fileChunk(conn, msg);
        case 'file_abort':
          if (!conn.session) return fail(conn, 'no_session');
          return fileAbort(conn, msg);
        case 'exit':
          return exitSession(conn);
        case 'ping':
          return send(ws, { type: 'pong' });
        default:
          return; // unknown type ignored
      }
    });

    ws.on('close', () => handleDisconnect(conn));
    ws.on('error', () => {
      /* swallow: never log, just clean up */
    });
  });

  // Periodically prune expired pending requests and half-finished file
  // transfers. Nothing is retained: both maps only ever hold metadata.
  setInterval(() => {
    const t = now();
    for (const [k, v] of requests) {
      if (v.expiry < t) requests.delete(k);
    }
    for (const [k, v] of transfers) {
      if (v.expiry < t) transfers.delete(k);
    }
  }, 30_000).unref?.();
}
