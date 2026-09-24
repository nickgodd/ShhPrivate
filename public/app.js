// shh — client application. Handles the WebSocket protocol, drives the UI, and
// performs all encryption/decryption via crypto.js. Nothing is persisted: no
// localStorage, no cookies, no IndexedDB. Close the tab => everything is gone.
import {
  randomId, generateIdentity, generateEphemeral, deriveChatKey,
  computeFingerprint, encryptMessage, decryptMessage, solvePoW, overSize,
  detectCurve, curveFromPubB64,
} from './crypto.js';

// ---- DOM refs -------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  start: $('start'), app: $('app'), createBtn: $('createBtn'), startHint: $('startHint'),
  profileBtn: $('profileBtn'), avatarDot: $('avatarDot'), searchInput: $('searchInput'),
  searchBtn: $('searchBtn'), profilePanel: $('profilePanel'),
  myId: $('myId'), myKey: $('myKey'), toggleId: $('toggleId'), toggleKey: $('toggleKey'),
  copyId: $('copyId'), logoutBtn: $('logoutBtn'),
  chatList: $('chatList'), requestList: $('requestList'),
  emptyState: $('emptyState'), chatTop: $('chatTop'), peerName: $('peerName'),
  fpChip: $('fpChip'), fpShort: $('fpShort'), fpFull: $('fpFull'),
  chatMenuBtn: $('chatMenuBtn'), chatMenu: $('chatMenu'), endChatBtn: $('endChatBtn'),
  messages: $('messages'), composer: $('composer'), msgInput: $('msgInput'),
  sendBtn: $('sendBtn'), sizeHint: $('sizeHint'), toasts: $('toasts'),
};

// ---- In-memory state ------------------------------------------------------
let ws = null;
let session = null;              // { id, identity }
const chats = new Map();         // peerId -> chat
const pendingOut = new Map();    // peerId -> { eph }   (we sent a request)
const incoming = new Map();      // requestId -> { from, ephPub, identityPub }
const notifByPeer = new Map();   // peerId -> toast element (actionable notice)
let activeChat = null;
let reconnectTimer = null;
let intentionalClose = false;

const WS_URL = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

// ---- Toasts / actionable notices -----------------------------------------
function toast(text, kind = '', ttl = 3200) {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  el.toasts.appendChild(t);
  if (ttl) setTimeout(() => t.remove(), ttl);
  return t;
}

// A persistent, dismissible notice (used for "found" / "waiting for reply").
function peerNotice(peerId, text, actionLabel, onAction) {
  dismissNotice(peerId);
  const t = document.createElement('div');
  t.className = 'toast found';
  const span = document.createElement('span');
  span.textContent = text;
  span.style.marginRight = '10px';
  t.appendChild(span);
  if (actionLabel) {
    const b = document.createElement('button');
    b.className = 'mini';
    b.textContent = actionLabel;
    b.onclick = () => onAction && onAction();
    t.appendChild(b);
  }
  el.toasts.appendChild(t);
  notifByPeer.set(peerId, t);
  return t;
}
function dismissNotice(peerId) {
  const t = notifByPeer.get(peerId);
  if (t) { t.remove(); notifByPeer.delete(peerId); }
}

// ---- WebSocket lifecycle --------------------------------------------------
function connect() {
  // Guard against re-entry (rapid clicks / overlapping reconnect) so we never
  // open two racing sockets at once.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(WS_URL());
  ws.onopen = () => requestPow();
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = () => onSocketClosed();
  ws.onerror = () => { /* handled by onclose */ };
}

function onSocketClosed() {
  el.avatarDot.classList.remove('online');
  for (const c of chats.values()) c.online = false;
  renderChatList();
  if (intentionalClose || !session) return; // no resume needed
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(), 1000); // quick reconnect within grace
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function requestPow() {
  if (session) send({ type: 'pow_challenge' }); // resume path re-solves a fresh PoW
  else {
    el.createBtn.disabled = true;
    el.startHint.hidden = false;
    send({ type: 'pow_challenge' });
  }
}

// Create (or resume) a session with the current identity.
async function authenticate() {
  const id = session ? session.id : randomId();
  const identity = session ? session.identity : await generateIdentity();
  send({
    type: 'create_session',
    id,
    publicKey: identity.publicB64,
    pow: { challenge: lastPow.challenge, nonce: lastPow.nonce },
  });
  // stash in case we must retry before server confirms
  session = { id, identity };
}

let lastPow = { challenge: null, nonce: null };

// ---- Message dispatch -----------------------------------------------------
async function onMessage(m) {
  switch (m.type) {
    case 'pow_challenge': {
      const nonce = await solvePoW(m.challenge, m.difficulty);
      lastPow = { challenge: m.challenge, nonce };
      await authenticate();
      break;
    }
    case 'session_created':
      el.createBtn.disabled = false;
      el.startHint.hidden = true;
      enterApp(m.resumed);
      break;

    case 'search_result':
      onSearchResult(m);
      break;
    case 'contact_request_sent':
      pendingOut.set(m.to, { requestId: m.requestId, eph: pendingOut.get(m.to)?.eph });
      peerNotice(m.to, `Запрос отправлен ${m.to}. Ожидаем ответа…`, 'Отмена', () => { dismissNotice(m.to); pendingOut.delete(m.to); });
      break;
    case 'contact_request_failed':
      dismissNotice(m.to);
      pendingOut.delete(m.to);
      toast(m.reason === 'offline' ? 'Пользователь не в сети' : 'Не удалось отправить запрос', 'err');
      break;
    case 'contact_request':
      onIncomingRequest(m);
      break;
    case 'contact_response':
      onContactResponse(m);
      break;

    case 'message':
      onIncomingMessage(m);
      break;
    case 'chat_ended':
      onChatEnded(m.id);
      break;
    case 'peer_offline':
      setPresence(m.id, false);
      break;
    case 'peer_online':
      setPresence(m.id, true);
      break;
    case 'error':
      onError(m.message);
      break;
    default:
      break;
  }
}

function onError(code) {
  el.createBtn.disabled = false;
  el.startHint.hidden = true;
  if (code.startsWith('rate_limited')) {
    const which = code.split(':')[1];
    const map = { search: 'Слишком много поисков', contact: 'Слишком много запросов', message: 'Слишком много сообщений', create: 'Слишком часто' };
    toast(map[which] || 'Слишком много действий, подождите', 'err');
  } else if (code === 'too_large') {
    toast('Сообщение превышает 2 КБ', 'err');
  } else if (code === 'id_taken' || code === 'bad_pow') {
    toast('Не удалось создать сессию. Попробуйте ещё раз', 'err');
  } else {
    // non-fatal protocol errors
    if (code !== 'no_session') toast('Ошибка: ' + code, 'err', 2600);
  }
}

// ---- Session UI -----------------------------------------------------------
function enterApp(resumed) {
  el.start.hidden = true;
  el.app.hidden = false;
  el.avatarDot.classList.add('online');
  el.myId.textContent = session.id;
  el.myId.dataset.real = session.id;
  el.myKey.textContent = session.identity.publicB64;
  el.myKey.dataset.real = session.identity.publicB64;
  maskProfile(true);
  renderChatList();
  if (resumed) toast('Сессия восстановлена', '', 2000);
}

function maskProfile(mask) {
  if (mask) {
    el.myId.textContent = '••••••••••••';
    el.myKey.textContent = '••••••••••••';
    el.toggleId.textContent = 'показать';
    el.toggleId.setAttribute('aria-pressed', 'false');
    el.toggleKey.textContent = 'показать';
    el.toggleKey.setAttribute('aria-pressed', 'false');
  } else {
    el.myId.textContent = el.myId.dataset.real;
    el.myKey.textContent = el.myKey.dataset.real;
    el.toggleId.textContent = 'скрыть';
    el.toggleId.setAttribute('aria-pressed', 'true');
    el.toggleKey.textContent = 'скрыть';
    el.toggleKey.setAttribute('aria-pressed', 'true');
  }
}

// ---- Search / contact flow ------------------------------------------------
function onSearchResult(m) {
  if (!m.found) {
    toast(`Идентификатор ${m.targetId} не найден или не в сети`, 'err');
    return;
  }
  if (chats.has(m.targetId)) { openChat(m.targetId); return; }
  peerNotice(m.targetId, `Собеседник найден: ${m.targetId}`, 'Запрос', () => sendRequest(m.targetId));
}

function sendRequest(targetId) {
  dismissNotice(targetId);
  const eph = generateEphemeral();
  pendingOut.set(targetId, { eph: ephPromise(eph) });
  eph.then((e) => {
    send({
      type: 'contact_request',
      to: targetId,
      publicKey: session.identity.publicB64,
      ephPub: e.publicB64,
    });
  });
}
function ephPromise(p) { return Promise.resolve(p); }

function onIncomingRequest(m) {
  incoming.set(m.requestId, { from: m.from, ephPub: m.ephPub, identityPub: m.publicKey });
  renderRequests();
}

async function acceptRequest(requestId) {
  const req = incoming.get(requestId);
  if (!req) return;
  // Use the initiator's curve (implied by their ephemeral key length) so both
  // sides derive the same key even across X25519 / P-256 fallback.
  const peerCurve = curveFromPubB64(req.ephPub);
  if (!peerCurve) {
    incoming.delete(requestId);
    renderRequests();
    send({ type: 'contact_response', requestId, accept: false });
    toast('Неподдерживаемый тип ключа собеседника', 'err');
    return;
  }
  incoming.delete(requestId);
  renderRequests();

  const myEph = await generateEphemeral(peerCurve);
  const key = await deriveChatKey(myEph, req.ephPub);
  const fingerprint = computeFingerprint(
    session.identity.publicB64, req.identityPub, myEph.publicB64, req.ephPub,
  );
  send({
    type: 'contact_response',
    requestId, accept: true,
    publicKey: session.identity.publicB64,
    ephPub: myEph.publicB64,
  });
  createAndOpenChat(req.from, { key, fingerprint, theirIdentityPub: req.identityPub, myEph });
}

function rejectRequest(requestId) {
  const req = incoming.get(requestId);
  if (!req) return;
  send({ type: 'contact_response', requestId, accept: false });
  incoming.delete(requestId);
  renderRequests();
}

async function onContactResponse(m) {
  dismissNotice(m.from);
  const pending = pendingOut.get(m.from);
  pendingOut.delete(m.from);
  if (!m.accept) {
    toast(`Собеседник ${m.from} отклонил запрос`, 'err');
    return;
  }
  if (!pending || !pending.eph) { toast('Не найден исходный запрос', 'err'); return; }
  const myEph = await pending.eph;
  const key = await deriveChatKey(myEph, m.ephPub);
  const fingerprint = computeFingerprint(
    session.identity.publicB64, m.publicKey, myEph.publicB64, m.ephPub,
  );
  createAndOpenChat(m.from, { key, fingerprint, theirIdentityPub: m.publicKey, myEph });
}

function createAndOpenChat(peerId, { key, fingerprint, theirIdentityPub, myEph }) {
  dismissNotice(peerId);
  const chat = chats.get(peerId) || { messages: [] };
  Object.assign(chat, {
    peerId, key, fingerprint, theirIdentityPub, myEph, online: true, unread: 0,
  });
  chats.set(peerId, chat);
  renderChatList();
  openChat(peerId);
  toast('Диалог установлен');
}

// ---- Messaging ------------------------------------------------------------
async function onIncomingMessage(m) {
  let chat = chats.get(m.from);
  if (!chat) return; // message for a chat we don't have: ignore (no storage)
  try {
    const text = await decryptMessage(chat.key, m.ciphertext);
    chat.messages.push({ me: false, text, ts: Date.now() });
  } catch {
    chat.messages.push({ me: false, text: '[не удалось расшифровать]', ts: Date.now() });
  }
  if (activeChat === m.from) {
    appendMessage(chat.messages[chat.messages.length - 1]);
    scrollMessages();
  } else {
    chat.unread = (chat.unread || 0) + 1;
    toast('Новое сообщение');
  }
  renderChatList();
}

async function sendMessage() {
  if (!activeChat) return;
  const chat = chats.get(activeChat);
  const text = el.msgInput.value.replace(/\s+$/, '');
  if (!text) return;
  if (overSize(text)) { toast('Максимум 2 КБ на сообщение', 'err'); return; }
  const ciphertext = await encryptMessage(chat.key, text);
  send({ type: 'message', to: chat.peerId, ciphertext });
  chat.messages.push({ me: true, text, ts: Date.now() });
  el.msgInput.value = '';
  autosize();
  updateSizeHint();
  appendMessage(chat.messages[chat.messages.length - 1]);
  scrollMessages();
  renderChatList();
}

// ---- Chat end / presence --------------------------------------------------
function endChat() {
  if (!activeChat) return;
  const peerId = activeChat;
  send({ type: 'end_chat', to: peerId });
  hardRemoveChat(peerId);
  selectNextChat();
}

function onChatEnded(peerId) {
  // Server notifies BOTH sides. Reset every related notification & state.
  dismissNotice(peerId);
  incoming.forEach((v, k) => { if (v.from === peerId) incoming.delete(k); });
  pendingOut.delete(peerId);
  const existed = chats.has(peerId);
  if (existed) {
    hardRemoveChat(peerId);
    if (activeChat === peerId) selectNextChat();
    toast('Чат завершён');
  }
  renderRequests();
}

function hardRemoveChat(peerId) {
  chats.delete(peerId);
  if (activeChat === peerId) { activeChat = null; }
  renderChatList();
}

function setPresence(peerId, online) {
  const chat = chats.get(peerId);
  if (!chat) return;
  chat.online = online;
  renderChatList();
  if (activeChat === peerId) el.peerName.title = online ? 'в сети' : 'не в сети';
}

// ---- Rendering ------------------------------------------------------------
function renderChatList() {
  el.chatList.innerHTML = '';
  const items = [...chats.values()].sort((a, b) => (b.messages.at(-1)?.ts || 0) - (a.messages.at(-1)?.ts || 0));
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'list-empty';
    e.textContent = 'Пока нет чатов. Найдите собеседника по ID.';
    el.chatList.appendChild(e);
    return;
  }
  for (const c of items) {
    const row = document.createElement('div');
    row.className = 'chat-item' + (c.peerId === activeChat ? ' active' : '');
    row.onclick = () => openChat(c.peerId);

    const dot = document.createElement('span');
    dot.className = 'ci-dot' + (c.online ? ' on' : '');

    const main = document.createElement('div');
    main.className = 'ci-main';
    const id = document.createElement('div');
    id.className = 'ci-id';
    id.textContent = c.peerId;
    const prev = document.createElement('div');
    prev.className = 'ci-preview';
    const last = c.messages.at(-1);
    prev.textContent = last ? (last.me ? 'Вы: ' : '') + last.text : 'Нет сообщений';
    main.append(id, prev);

    row.append(dot, main);
    if (c.unread) {
      const b = document.createElement('span');
      b.className = 'ci-badge';
      b.textContent = c.unread > 9 ? '9+' : c.unread;
      row.appendChild(b);
    }
    el.chatList.appendChild(row);
  }
}

function renderRequests() {
  el.requestList.innerHTML = '';
  for (const [requestId, req] of incoming) {
    const card = document.createElement('div');
    card.className = 'req';
    const top = document.createElement('div');
    top.className = 'req-top';
    const code = document.createElement('code');
    code.textContent = req.from;
    top.append('Запрос на диалог: ', code);

    const actions = document.createElement('div');
    actions.className = 'req-actions';
    const accept = document.createElement('button');
    accept.className = 'req-accept';
    accept.textContent = 'Принять';
    accept.onclick = () => acceptRequest(requestId);
    const reject = document.createElement('button');
    reject.className = 'req-reject';
    reject.textContent = 'Отклонить';
    reject.onclick = () => rejectRequest(requestId);
    actions.append(accept, reject);
    card.append(top, actions);
    el.requestList.appendChild(card);
  }
}

function openChat(peerId) {
  activeChat = peerId;
  const chat = chats.get(peerId);
  if (!chat) return;
  chat.unread = 0;
  el.app.dataset.pane = 'chat';

  el.emptyState.hidden = true;
  el.chatTop.hidden = false;
  el.messages.hidden = false;
  el.composer.hidden = false;

  el.peerName.textContent = peerId;
  el.peerName.title = chat.online ? 'в сети' : 'не в сети';
  el.fpShort.textContent = chat.fingerprint.slice(0, 9);
  el.fpFull.textContent = chat.fingerprint;
  el.chatMenu.hidden = true;

  el.messages.innerHTML = '';
  chat.messages.forEach(appendMessage);
  const note = document.createElement('div');
  note.className = 'msg system';
  note.textContent = 'Сообщения шифруются на вашем устройстве и не хранятся на сервере.';
  el.messages.appendChild(note);
  scrollMessages();
  renderChatList();
  el.msgInput.focus();
}

function selectNextChat() {
  if (chats.size) { openChat([...chats.keys()][0]); }
  else {
    activeChat = null;
    el.emptyState.hidden = false;
    el.chatTop.hidden = true;
    el.messages.hidden = true;
    el.composer.hidden = true;
    el.app.dataset.pane = '';
    renderChatList();
  }
}

function appendMessage(msg) {
  const d = document.createElement('div');
  d.className = 'msg ' + (msg.me ? 'me' : 'peer');
  d.textContent = msg.text;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  d.appendChild(meta);
  el.messages.appendChild(d);
}
function scrollMessages() { el.messages.scrollTop = el.messages.scrollHeight; }

// ---- Composer helpers -----------------------------------------------------
function autosize() {
  const t = el.msgInput;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 160) + 'px';
}
function updateSizeHint() {
  const bytes = new Blob([el.msgInput.value]).size;
  el.sizeHint.textContent = `${bytes} / 2048`;
  el.sizeHint.classList.toggle('over', bytes > 2048);
}

// ---- Logout / reset -------------------------------------------------------
function resetAll() {
  intentionalClose = true;
  clearTimeout(reconnectTimer);
  if (ws) { try { ws.close(); } catch { /* noop */ } }
  ws = null;
  session = null;
  lastPow = { challenge: null, nonce: null };
  chats.clear();
  pendingOut.clear();
  incoming.clear();
  notifByPeer.forEach((t) => t.remove());
  notifByPeer.clear();
  activeChat = null;
  intentionalClose = false;

  el.app.hidden = true;
  el.start.hidden = false;
  el.app.dataset.pane = '';
  delete el.myId.dataset.real;
  delete el.myKey.dataset.real;
  renderRequests();
}

// ---- Wire up events -------------------------------------------------------
let cryptoOk = true;

function init() {
  detectCurve().then((curve) => {
    cryptoOk = !!curve;
    if (!curve) {
      el.createBtn.disabled = true;
      el.startHint.hidden = false;
      el.startHint.textContent = 'Браузер не поддерживает ECDH в Web Crypto (X25519/P-256). Обновите браузер.';
    }
  });

  el.createBtn.onclick = () => {
    if (!cryptoOk) { toast('Браузер не поддерживает необходимую криптографию', 'err'); return; }
    el.createBtn.disabled = true;
    el.startHint.hidden = false;
    el.startHint.textContent = 'Подключение и решение задачи…';
    connect();
  };

  el.profileBtn.onclick = () => { el.profilePanel.hidden = !el.profilePanel.hidden; };
  el.toggleId.onclick = () => {
    const show = el.toggleId.textContent === 'показать';
    el.myId.textContent = show ? el.myId.dataset.real : '••••••••••••';
    el.toggleId.textContent = show ? 'скрыть' : 'показать';
    el.toggleId.setAttribute('aria-pressed', String(show));
  };
  el.toggleKey.onclick = () => {
    const show = el.toggleKey.textContent === 'показать';
    el.myKey.textContent = show ? el.myKey.dataset.real : '••••••••••••';
    el.toggleKey.textContent = show ? 'скрыть' : 'показать';
    el.toggleKey.setAttribute('aria-pressed', String(show));
  };
  el.copyId.onclick = async () => {
    try { await navigator.clipboard.writeText(session.id); toast('Идентификатор скопирован'); }
    catch { toast('Не удалось скопировать', 'err'); }
  };
  el.logoutBtn.onclick = () => { el.profilePanel.hidden = true; resetAll(); };

  const doSearch = () => {
    const q = el.searchInput.value.trim().toUpperCase().replace(/[^A-Z2-7]/g, '');
    el.searchInput.value = q;
    if (q.length < 12) { toast('Введите идентификатор (мин. 12 символов)', 'err'); return; }
    send({ type: 'search', targetId: q });
  };
  el.searchBtn.onclick = doSearch;
  el.searchInput.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };

  el.chatMenuBtn.onclick = (e) => { e.stopPropagation(); el.chatMenu.hidden = !el.chatMenu.hidden; };
  el.fpChip.onclick = () => { el.chatMenu.hidden = false; };
  document.addEventListener('click', (e) => {
    if (!el.chatMenu.hidden && !el.chatMenu.contains(e.target) && e.target !== el.chatMenuBtn) el.chatMenu.hidden = true;
    if (!el.profilePanel.hidden && !el.profilePanel.contains(e.target) && !el.profileBtn.contains(e.target)) el.profilePanel.hidden = true;
  });
  el.endChatBtn.onclick = endChat;

  el.sendBtn.onclick = sendMessage;
  el.msgInput.addEventListener('input', () => { autosize(); updateSizeHint(); });
  el.msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Data only lives in RAM: warn that closing the tab ends the session.
  window.addEventListener('beforeunload', () => { /* graceful ws close handled by OS; server prunes after grace */ });
}

init();
