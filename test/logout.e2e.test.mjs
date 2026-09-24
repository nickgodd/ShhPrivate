// End-to-end autotest for the logout / new-session flow.
//
// It boots the REAL server as a child process, installs a tiny DOM shim, then
// imports the REAL public/app.js and drives it through its actual event handlers
// over a live WebSocket, alongside an independent "peer" client. This exercises
// the genuine client reset logic (bug #3) plus the server session teardown.
//
// Run: node test/logout.e2e.test.mjs
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import WebSocketLib from 'ws';

const PORT = Number(process.env.TEST_PORT || 4599);
const HOST = `127.0.0.1:${PORT}`;
const URL_HTTP = `http://${HOST}`;
const WS_URL = `ws://${HOST}`;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const wsWebSocket = WebSocketLib.default || WebSocketLib;

let failures = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}
function b32id(n = 12) {
  return Array.from(crypto.randomBytes(n), (b) => B32[b & 31]).join('');
}
function solvePow(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty);
  for (let n = 0; n < 5_000_000; n++) {
    if (crypto.createHash('sha256').update(`${challenge}:${n}`).digest('hex').startsWith(prefix)) return n;
  }
  throw new Error('pow_exhausted');
}

// --------------------------------------------------------------------------
// Minimal DOM shim: only the subset app.js actually touches.
// --------------------------------------------------------------------------
class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._classes = new Set();
    this._listeners = {};
    this._text = '';
    this.onclick = null;
    this.onkeydown = null;
    this.oninput = null;
  }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  get classList() {
    const s = this._classes;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      contains: (c) => s.has(c),
      toggle: (c, force) => { const on = force === undefined ? !s.has(c) : !!force; on ? s.add(c) : s.delete(c); return on; },
    };
  }
  setAttribute() {} getAttribute() { return null; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set innerHTML(v) { if (v === '') this.children.forEach((c) => (c.parent = null)), (this.children = []), (this._text = ''); }
  get innerHTML() { return ''; }
  appendChild(ch) { ch.parent = this; this.children.push(ch); return ch; }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') { const t = new El('#text'); t._text = n; t.parent = this; this.children.push(t); }
      else { n.parent = this; this.children.push(n); }
    }
  }
  remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
  contains(o) { if (o === this) return true; return this.children.some((c) => c.contains && c.contains(o)); }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  dispatch(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev || {})); }
  focus() {}
}
function makeDom() {
  const byId = new Map();
  global.document = {
    getElementById: (id) => byId.get(id) || (byId.set(id, new El()), byId.get(id)),
    createElement: (tag) => new El(tag),
    addEventListener() {},
  };
  global.window = { addEventListener() {} };
  return { get: (id) => global.document.getElementById(id) };
}
// Depth-first search for an element with exact text that has an onclick.
function findButton(root, text) {
  if (root.onclick && root.textContent.trim() === text) return root;
  for (const c of root.children || []) { const hit = findButton(c, text); if (hit) return hit; }
  return null;
}
function chatItems(dom) { return dom.get('chatList').children.filter((c) => c.classList.contains('chat-item')); }

// --------------------------------------------------------------------------
// Raw client helper (peer + observer): does the PoW create-session handshake.
// --------------------------------------------------------------------------
function rawClient(name) {
  const ws = new wsWebSocket(WS_URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { clearTimeout(waiters[i].t); waiters[i].res(m); waiters.splice(i, 1); }
    }
  });
  const wait = (pred, ms = 5000) => new Promise((res, rej) => {
    const found = inbox.find(pred);
    if (found) return res(found);
    const t = setTimeout(() => rej(new Error(`${name}: timeout`)), ms);
    waiters.push({ pred, res, t });
  });
  return { name, ws, inbox, wait };
}

async function establish(raw, identityB64) {
  if (raw.ws.readyState !== wsWebSocket.OPEN) await new Promise((r) => raw.ws.on('open', r));
  raw.ws.send(JSON.stringify({ type: 'pow_challenge' }));
  const ch = await raw.wait((m) => m.type === 'pow_challenge');
  raw.ws.send(JSON.stringify({ type: 'create_session', id: raw.id, publicKey: identityB64, pow: { challenge: ch.challenge, nonce: solvePow(ch.challenge, ch.difficulty) } }));
  return raw.wait((m) => m.type === 'session_created');
}

// --------------------------------------------------------------------------
async function main() {
  // 1) Boot the server as a child process and wait until it is listening.
  const server = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    let buf = '';
    server.stdout.on('data', (d) => { buf += d.toString(); if (buf.includes('listening')) resolve(); });
    server.on('exit', (code) => reject(new Error(`server exited early: ${code}`)));
    setTimeout(() => reject(new Error('server boot timeout')), 8000);
  });
  console.log('server is up\n');

  // 2) Install globals BEFORE importing app.js.
  global.WebSocket = wsWebSocket;
  global.location = { protocol: 'http:', host: HOST };
  const dom = makeDom();
  const { generateIdentity, generateEphemeral, curveFromPubB64, deriveChatKey, encryptMessage, decryptMessage } =
    await import('../public/crypto.js');

  // Peer "Bob" (independent raw client that accepts a request and replies).
  const bob = rawClient('bob');
  bob.id = b32id();
  const bobIdentity = await generateIdentity();
  await establish(bob, bobIdentity.publicB64);
  let bobKey = null, bobPeerId = null, bobGotMessage = null;
  bob.ws.on('message', async (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'contact_request') {
      const curve = curveFromPubB64(m.ephPub);
      const eph = await generateEphemeral(curve);
      bobKey = await deriveChatKey(eph, m.ephPub);
      bobPeerId = m.from;
      bob.ws.send(JSON.stringify({ type: 'contact_response', requestId: m.requestId, accept: true, publicKey: bobIdentity.publicB64, ephPub: eph.publicB64 }));
    } else if (m.type === 'message' && bobKey) {
      bobGotMessage = await decryptMessage(bobKey, m.ciphertext);
      const ct = await encryptMessage(bobKey, 'hi from bob');
      bob.ws.send(JSON.stringify({ type: 'message', to: bobPeerId, ciphertext: ct }));
    }
  });

  // 3) Import the real client (runs init()).
  await import('../public/app.js');
  await delay(50);

  // 4) Create session A.
  dom.get('createBtn').onclick();
  const myIdEl = dom.get('myId');
  await waitUntil(() => !!myIdEl.dataset.real, 'A creates a session', 8000);
  const oldId = myIdEl.dataset.real;
  ok(!!oldId && /^[A-Z2-7]{12}$/.test(oldId), `session created, A id = ${oldId}`);
  ok(!dom.get('app').hidden, 'app is visible');

  // 5) A opens a chat with Bob.
  dom.get('searchInput').value = bob.id;
  dom.get('searchBtn').onclick();
  await waitUntil(() => findButton(dom.get('toasts'), 'Отправить запрос'), 'found-result block appears', 5000);
  ok(!!findButton(dom.get('toasts'), 'Отправить запрос'), '"Отправить запрос" button is present');
  findButton(dom.get('toasts'), 'Отправить запрос').onclick();
  await waitUntil(() => chatItems(dom).length === 1, 'chat appears in list', 5000);
  ok(chatItems(dom).length === 1, 'one chat in the list');
  ok(dom.get('messages').children.length >= 1, 'messages pane rendered (chat opened)');

  // 6) Exchange a message so the chat is definitely non-empty.
  dom.get('msgInput').value = 'привет от alice';
  await dom.get('sendBtn').onclick();
  await waitUntil(() => bobGotMessage === 'привет от alice', 'Bob receives decrypted message', 5000);
  ok(bobGotMessage === 'привет от alice', 'message encrypted/relayed/decrypted end-to-end');

  // 7) LOGOUT.
  dom.get('logoutBtn').onclick();
  await delay(30);
  ok(!myIdEl.dataset.real || myIdEl.dataset.real !== oldId, 'A identity cleared on logout');
  ok(chatItems(dom).length === 0, 'chat list cleared on logout');
  ok(dom.get('messages').children.length === 0, 'messages cleared on logout');
  ok(dom.get('app').hidden === true && dom.get('start').hidden === false, 'back to start screen');

  // 8) Server side: Bob (peer) is told A went offline.
  await waitUntil(() => bob.inbox.some((m) => m.type === 'peer_offline' && m.id === oldId), 'server notified Bob', 5000);
  ok(bob.inbox.some((m) => m.type === 'peer_offline' && m.id === oldId), 'server marked old session offline (delivery stopped)');

  // 9) CREATE A NEW SESSION — must start empty, no reload.
  dom.get('createBtn').onclick();
  await waitUntil(() => myIdEl.dataset.real && myIdEl.dataset.real !== oldId, 'A gets a fresh identity', 8000);
  const newId = myIdEl.dataset.real;
  ok(!!newId && newId !== oldId, `new session started with fresh id = ${newId}`);
  ok(chatItems(dom).length === 0, 'NEW session: chat list is empty');
  ok(dom.get('messages').children.length === 0, 'NEW session: messages are empty');
  ok(dom.get('searchInput').value === '', 'NEW session: search field is empty');
  ok(dom.get('messages').hidden === true, 'NEW session: no chat pane open');

  // 10) Server side: old session is fully gone (searching old id from a new observer => not found).
  const observer = rawClient('observer');
  observer.id = b32id();
  await establish(observer, (await generateIdentity()).publicB64);
  observer.ws.send(JSON.stringify({ type: 'search', targetId: oldId }));
  const sr = await observer.wait((m) => m.type === 'search_result' && m.targetId === oldId, 5000);
  ok(sr.found === false, 'old session is removed / inactive on the server');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED ✅' : failures + ' CHECK(S) FAILED ❌'}`);
  observer.ws.close(); bob.ws.close(); server.kill();
  process.exit(failures === 0 ? 0 : 1);
}

// Poll a predicate; throw+record on timeout.
async function waitUntil(pred, label, ms) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let v = false;
    try { v = await pred(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - start > ms) { ok(false, `TIMEOUT waiting for: ${label}`); return false; }
    await delay(40);
  }
}

main().catch((e) => { console.error('\nTEST CRASHED:', e); process.exit(1); });
