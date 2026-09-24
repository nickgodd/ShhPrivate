// Shared harness for the autotests.
//
// Every test boots the REAL server as a child process, installs a tiny DOM shim,
// then imports the REAL public/app.js and drives it through its actual event
// handlers over a live WebSocket, alongside independent raw "ws" peers. That way
// the tests exercise genuine client logic and genuine server state, with no
// browser and no extra dependencies.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';
import WebSocketLib from 'ws';

export const PORT = Number(process.env.TEST_PORT || 4611);
export const HOST = `127.0.0.1:${PORT}`;
export const WS_URL = `ws://${HOST}`;
export const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const WebSocket = WebSocketLib.default || WebSocketLib;
export { delay, crypto };

let failures = 0;
export function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
  return !!cond;
}
export function summary() {
  const line = failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`;
  console.log(`\n${failures === 0 ? line + ' ✅' : line + ' ❌'}`);
  return failures;
}
export function b32id(n = 12) {
  return Array.from(crypto.randomBytes(n), (b) => B32[b & 31]).join('');
}
export function sha256hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function solvePow(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty);
  for (let n = 0; n < 5_000_000; n++) {
    if (crypto.createHash('sha256').update(`${challenge}:${n}`).digest('hex').startsWith(prefix)) return n;
  }
  throw new Error('pow_exhausted');
}

// ---------------------------------------------------------------------------
// Minimal DOM shim: only the subset app.js touches.
// ---------------------------------------------------------------------------
export class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.files = [];
    this._text = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._classes = new Set();
    this._listeners = {};
    this.onclick = null;
    this.onchange = null;
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
  setAttribute(k, v) { this[`attr_${k}`] = v; }
  getAttribute(k) { return this[`attr_${k}`] ?? null; }
  removeAttribute(k) { delete this[`attr_${k}`]; }
  // textContent behaves like the DOM: assigning replaces the subtree, reading a
  // container yields its children's text.
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set innerHTML(v) { if (v === '') { this.children.forEach((c) => (c.parent = null)); this.children = []; } }
  get innerHTML() { return ''; }
  appendChild(ch) { ch.parent = this; this.children.push(ch); return ch; }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') { const t = new El('#text'); t.textContent = n; t.parent = this; this.children.push(t); }
      else { n.parent = this; this.children.push(n); }
    }
  }
  remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
  contains(o) { if (o === this) return true; return this.children.some((c) => c.contains && c.contains(o)); }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  dispatch(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev || {})); }
  click() { if (this.onclick) this.onclick({ target: this, stopPropagation() {} }); }
  focus() {}
  // A canvas-ish element that records draw calls, so a test can assert something
  // was actually painted (the QR code) without a real 2D context.
  getContext() {
    if (!this._ctx) {
      const el = this;
      el._fills = 0;
      const noop = () => {};
      this._ctx = {
        fillRect: () => { el._fills++; },
        clearRect: noop, drawImage: noop, scale: noop, translate: noop, transform: noop,
        setTransform: noop, save: noop, restore: noop, fillText: noop,
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        fillStyle: '', strokeStyle: '', lineWidth: 1, imageSmoothingQuality: '',
      };
    }
    return this._ctx;
  }
  toBlob(cb) { cb(null); } // the canvas compression path is not exercised headless
  getBoundingClientRect() { return { width: 100, height: 100, top: 0, left: 0 }; }
}

// Globals the client expects from a browser. Each test file runs in its own
// process, so a per-file port is fine — node:test executes files concurrently.
export function bootGlobals(port) {
  global.WebSocket = WebSocket;
  global.location = { protocol: 'http:', host: `127.0.0.1:${port}` };
  // Node 24 already exposes a read-only `navigator` without mediaDevices, which
  // is exactly the shape the scanner's capability check expects.
  return { host: `127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` };
}

export function makeDom() {
  // Mirror the markup: whatever carries the `hidden` attribute in index.html
  // starts hidden here too, so "did the client open this window?" is a real
  // question in a test.
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const initiallyHidden = new Set();
  for (const tag of html.matchAll(/<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    if (/(?:^|\s)hidden(?:\s|$)/.test(tag[2])) initiallyHidden.add(tag[3]);
  }

  const byId = new Map();
  global.document = {
    getElementById: (id) => {
      if (!byId.has(id)) {
        const node = new El();
        node.hidden = initiallyHidden.has(id);
        byId.set(id, node);
      }
      return byId.get(id);
    },
    createElement: (tag) => new El(tag),
    addEventListener() {},
    dispatch() {},
    body: new El('body'),
  };
  global.window = { addEventListener() {}, devicePixelRatio: 1 };
  global.devicePixelRatio = 1;
  const blobs = new Map();
  // Node ships its own URL.createObjectURL, which a test cannot read back, so it
  // is replaced unconditionally: that is how a received attachment is verified
  // byte for byte.
  let n = 0;
  global.URL.createObjectURL = (blob) => { const u = `blob:memory/${++n}`; blobs.set(u, blob); return u; };
  global.URL.revokeObjectURL = (u) => blobs.delete(u);
  if (!global.createImageBitmap) global.createImageBitmap = async () => { throw new Error('no canvas in Node'); };
  // `blobs` lets a test read back whatever the client put into an object URL —
  // that is how a received attachment is verified byte for byte.
  return { get: (id) => global.document.getElementById(id), blobs };
}

// Depth-first search for a clickable element whose trimmed text matches.
export function findButton(root, text) {
  if (root.onclick && String(root.textContent).trim() === text) return root;
  for (const c of root.children || []) { const hit = findButton(c, text); if (hit) return hit; }
  return null;
}
export function findByClass(root, cls) {
  if (root.classList && root.classList.contains(cls)) return root;
  for (const c of root.children || []) { const hit = findByClass(c, cls); if (hit) return hit; }
  return null;
}
export function allByClass(root, cls, acc = []) {
  if (root.classList && root.classList.contains(cls)) acc.push(root);
  for (const c of root.children || []) allByClass(c, cls, acc);
  return acc;
}
export function textOf(el) { return el ? String(el.textContent).trim() : ''; }

export function chatItems(dom) {
  return dom.get('chatList').children.filter((c) => c.classList.contains('chat-item'));
}
export function messagesOf(dom) {
  return dom.get('messages').children.filter((c) => c.classList.contains('msg') && !c.classList.contains('system'));
}

// ---------------------------------------------------------------------------
// Raw client helper: the independent peer that speaks the protocol directly.
// ---------------------------------------------------------------------------
export function rawClient(name, url = WS_URL) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    let m;
    try { m = JSON.parse(d.toString()); } catch { return; }
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { clearTimeout(waiters[i].t); waiters[i].res(m); waiters.splice(i, 1); }
    }
  });
  const wait = (pred, ms = 6000) => new Promise((res, rej) => {
    const found = inbox.find(pred);
    if (found) return res(found);
    const t = setTimeout(() => rej(new Error(`${name}: timeout`)), ms);
    waiters.push({ pred, res, t });
  });
  const clear = () => { inbox.length = 0; };
  const json = (obj) => ws.send(JSON.stringify(obj));
  return { name, ws, inbox, wait, clear, json, errors: [] };
}

// PoW create-session handshake; pass `resume` = { id, publicKey } to reconnect.
export async function establish(raw, identityB64) {
  if (raw.ws.readyState !== WebSocket.OPEN) await new Promise((r) => raw.ws.on('open', r));
  raw.json({ type: 'pow_challenge' });
  const ch = await raw.wait((m) => m.type === 'pow_challenge');
  raw.json({
    type: 'create_session', id: raw.id, publicKey: identityB64,
    pow: { challenge: ch.challenge, nonce: solvePow(ch.challenge, ch.difficulty) },
  });
  return raw.wait((m) => m.type === 'session_created');
}

// A raw peer that accepts an incoming request and derives the chat key.
export async function acceptWith(cryptoMod, raw, identity, opts = {}) {
  const req = await raw.wait((m) => m.type === 'contact_request');
  const curve = cryptoMod.curveFromPubB64(req.ephPub);
  const eph = await cryptoMod.generateEphemeral(curve);
  const key = await cryptoMod.deriveChatKey(eph, req.ephPub);
  raw.json({
    type: 'contact_response', requestId: req.requestId, accept: true,
    publicKey: identity.publicB64, ephPub: eph.publicB64,
  });
  return { key, peerId: req.from, theirIdentityPub: req.publicKey, eph, request: req, fingerprint: opts.fingerprint };
}

export async function bootServer(port = PORT) {
  const entry = fileURLToPath(new URL('../server/index.js', import.meta.url));
  const server = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    let buf = '';
    server.stdout.on('data', (d) => { buf += d.toString(); if (buf.includes('listening')) resolve(); });
    server.on('exit', (code) => reject(new Error(`server exited early: ${code}`)));
    setTimeout(() => reject(new Error('server boot timeout')), 8000);
  });
  return server;
}

export async function waitUntil(pred, label, ms = 6000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let v = false;
    try { v = await pred(); } catch { v = false; }
    if (v) return true;
    if (Date.now() - start > ms) { ok(false, `TIMEOUT waiting for: ${label}`); return false; }
    await delay(40);
  }
}

// Load the vendored jsQR build in Node: it doubles as an independent decoder so
// the QR encoder can be verified without a browser. The file is a UMD bundle
// inside a "type": "module" package, so evaluate it with an explicit module object.
export function loadJsQR() {
  const url = new URL('../public/vendor/jsQR.js', import.meta.url);
  const src = fs.readFileSync(fileURLToPath(url), 'utf8');
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'self', src)(mod, mod.exports, undefined);
  const factory = mod.exports;
  return typeof factory === 'function' ? factory : factory.default;
}

// Render a QR module matrix to the RGBA buffer shape jsQR expects.
export function qrToRgba(modules, { scale = 6, quiet = 4 } = {}) {
  const size = modules.length;
  const px = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  const put = (x, y, v) => {
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const o = (((y * scale + dy) * px) + (x * scale + dx)) * 4;
        data[o] = data[o + 1] = data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dark = modules[y][x];
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        put(x + quiet, y + quiet, dark ? 0 : 255);
      }
    }
  }
  return { data, width: px, height: px };
}
