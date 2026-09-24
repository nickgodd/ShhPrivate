// WebSocket relay: purely forwards ciphertext. It never sees plaintext or keys.
// ALL state is in RAM. No database. No logs. Client IPs are never stored.
import crypto from 'node:crypto';

// ---- Tunables -------------------------------------------------------------
const POW_DIFFICULTY = 4;              // leading hex zeros required
const POW_NONCE_MAX = 5_000_000;       // bound brute-force work per attempt
const GRACE_MS = 8_000;                // reconnect window after a tab closes
const CIPHER_MAX_BYTES = 2048 + 64;    // 2 KB plaintext + IV(12)+tag(16) slack
const ID_RE = /^[A-Z2-7]{12,16}$/;     // base32, 12+ chars
// Accepted public-key base64 lengths: X25519 raw (32B -> 44 chars) or P-256 raw
// uncompressed point (65B -> 88 chars). The client negotiates the curve.
const PUBKEY_B64_LENS = new Set([44, 88]);

// Per-connection token buckets: [capacity, refillPerSec]
const LIMITS = {
  search: [10, 10 / 30],               // anti ID-enumeration
  contact: [5, 5 / 60],                // anti spam requests
  message: [40, 40 / 20],              // burst then steady
  create: [3, 3 / 60],
};

// ---- In-memory state ------------------------------------------------------
const byId = new Map();    // id -> session
const bySocket = new Map(); // ws  -> conn
const requests = new Map(); // requestId -> { from, to, expiry }

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
  take() {
    const t = now();
    this.tokens = Math.min(this.cap, this.tokens + ((t - this.last) / 1000) * this.refill);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

function allow(conn, action) {
  const [cap, refill] = LIMITS[action];
  const key = action;
  let b = conn.buckets.get(key);
  if (!b) {
    b = new Bucket(cap, refill);
    conn.buckets.set(key, b);
  }
  return b.take();
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
  if (typeof s !== 'string' || s.length === 0 || s.length > CIPHER_MAX_BYTES * 2) return false;
  let raw;
  try {
    raw = Buffer.from(s, 'base64');
  } catch {
    return false;
  }
  return raw.length > 0 && raw.length <= CIPHER_MAX_BYTES;
}

// ---- Session lifecycle ----------------------------------------------------
function teardown(session) {
  // Fully remove a session and its chat relationships. No queues are kept.
  byId.delete(session.id);
  for (const peer of session.peers) {
    const p = byId.get(peer);
    if (p) p.peers.delete(session.id);
  }
  session.peers.clear();
}

function handleDisconnect(conn) {
  bySocket.delete(conn.ws);
  const session = conn.session;
  if (!session || session.ws !== conn.ws) {
    conn.ws = null;
    return;
  }
  // Immediately stop delivery (peer looks offline) and inform peers.
  session.ws = null;
  notifyPeers(session.id, { type: 'peer_offline', id: session.id });

  // Small grace period: a page refresh may reconnect and reuse the id.
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
    notifyPeers(id, { type: 'peer_online', id });
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
  if (!target || !target.ws) {
    // No store-and-forward: nothing is queued. If offline, it is not delivered.
    return send(conn.ws, { type: 'peer_offline', id: to });
  }
  sendToId(to, { type: 'message', from: conn.session.id, ciphertext });
}

function endChat(conn, { to }) {
  const session = conn.session;
  if (!session || !byId.has(to)) {
    // still clean adjacency locally if the peer object exists
  }
  if (session) {
    session.peers.delete(to);
    const peer = byId.get(to);
    if (peer) peer.peers.delete(session.id);
    sendToId(to, { type: 'chat_ended', id: session.id });
  }
  // Ack to the initiator too, so both UIs reset their notification state.
  send(conn.ws, { type: 'chat_ended', id: to });
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

  // Periodically prune expired pending requests (no data retained).
  setInterval(() => {
    const t = now();
    for (const [k, v] of requests) {
      if (v.expiry < t) requests.delete(k);
    }
  }, 30_000).unref?.();
}
