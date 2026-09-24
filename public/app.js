// shh — client application. Handles the WebSocket protocol, drives the UI, and
// performs all encryption/decryption via crypto.js. Nothing is persisted: no
// localStorage, no cookies, no IndexedDB. Close the tab => everything is gone.
import {
  randomId, generateIdentity, generateEphemeral, deriveChatKey,
  computeFingerprint, encryptMessage, decryptMessage, solvePoW, overSize,
  detectCurve, curveFromPubB64, randomTransferId, parseId, isId,
} from './crypto.js';
import { stripMetadata, compressImage, sniffFormat, randomLabel, humanSize } from './media.js';
import { renderQr } from './qr.js';
import { startScan, canScan, cameraErrorMessage } from './scan.js';
import { MAX_FILE_BYTES, chunkCount, encryptFrames, Receiver, percent } from './files.js';

// ---- DOM refs -------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  start: $('start'), app: $('app'), createBtn: $('createBtn'),
  profileBtn: $('profileBtn'), avatarDot: $('avatarDot'), searchInput: $('searchInput'),
  searchBtn: $('searchBtn'), profilePanel: $('profilePanel'),
  myId: $('myId'), toggleId: $('toggleId'),
  copyId: $('copyId'), logoutBtn: $('logoutBtn'),
  myKey: $('myKey'), qrWrap: $('qrWrap'), qrCanvas: $('qrCanvas'),
  scanBtn: $('scanBtn'), scanModal: $('scanModal'), scanVideo: $('scanVideo'),
  scanCanvas: $('scanCanvas'), scanStatus: $('scanStatus'), scanCloseBtn: $('scanCloseBtn'),
  chatList: $('chatList'), requestList: $('requestList'),
  emptyState: $('emptyState'), chatTop: $('chatTop'), peerName: $('peerName'),
  fpChip: $('fpChip'), fpShort: $('fpShort'), fpFull: $('fpFull'),
  chatMenuBtn: $('chatMenuBtn'), chatMenu: $('chatMenu'), endChatBtn: $('endChatBtn'),
  messages: $('messages'), composer: $('composer'), msgInput: $('msgInput'),
  sendBtn: $('sendBtn'), sizeHint: $('sizeHint'), toasts: $('toasts'),
  peerPlate: $('peerPlate'), plateText: $('plateText'), deleteChatBtn: $('deleteChatBtn'),
  attachBtn: $('attachBtn'), fileInput: $('fileInput'),
  dialog: $('dialog'), dialogTitle: $('dialogTitle'), dialogBody: $('dialogBody'),
  dialogActions: $('dialogActions'),
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
let scanner = null;              // active { promise, stop } while the modal is open

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
// big=true renders the "Собеседник найден" result block with a full-width
// primary action button; otherwise it is a compact pill with a mini button.
function peerNotice(peerId, text, actionLabel, onAction, big = false) {
  dismissNotice(peerId);
  const t = document.createElement('div');
  t.className = big ? 'toast notice' : 'toast found';
  const span = document.createElement('span');
  span.textContent = text;
  if (!big) span.style.marginRight = '10px';
  t.appendChild(span);
  if (actionLabel) {
    const b = document.createElement('button');
    b.className = big ? 'primary notice-action' : 'mini';
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
    case 'peer_left': // temporary: inside the grace window a refresh can undo it
      setChatLeft(m.id, 'temp');
      break;
    case 'peer_back':
      setChatLeft(m.id, '');
      break;
    case 'peer_gone': // final: the chat stays visible, read-only, until deleted
      setChatLeft(m.id, 'gone');
      break;
    case 'undeliverable':
      onUndeliverable(m.id);
      break;
    case 'file_open':
      onIncomingFileOpen(m);
      break;
    case 'file_chunk':
      onIncomingFileChunk(m);
      break;
    case 'file_aborted':
      onIncomingFileAborted(m);
      break;
    case 'error':
      onError(m);
      break;
    default:
      break;
  }
}

function onError(m) {
  const code = m.message;
  el.createBtn.disabled = false;
  if (code.startsWith('rate_limited')) {
    const which = code.split(':')[1];
    const map = {
      search: 'Слишком много поисков', contact: 'Слишком много запросов',
      message: 'Слишком много сообщений', create: 'Слишком часто',
      file: 'Слишком часто отправляете файлы, подождите',
    };
    toast(map[which] || 'Слишком много действий, подождите', 'err');
  } else if (code === 'too_large') {
    toast('Сообщение превышает 2 КБ', 'err');
  } else if (code === 'file_too_large') {
    toast('Файл больше 5 МБ', 'err');
    failTransfer(m.transferId, 'файл отклонён сервером');
  } else if (code === 'chunk_too_large' || code === 'bad_chunk' || code === 'no_transfer'
    || code === 'bad_transfer' || code === 'peer_slow' || code === 'server_busy') {
    toast('Передача не дошла: ' + code, 'err');
    failTransfer(m.transferId, 'передача прервана');
  } else if (code === 'chat_active') {
    toast('Сначала завершите чат', 'err');
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
  el.myKey.dataset.real = session.identity.publicB64;
  maskProfile(true);
  renderChatList();
  if (resumed) toast('Сессия восстановлена', '', 2000);
}

// The identifier, the public key and the QR are revealed together by one press
// and hidden again by the next: a shoulder-surfing proof, not a settings page.
let profileRevealed = false;
function maskProfile(mask) {
  profileRevealed = !mask;
  if (mask) {
    el.myId.textContent = '••••••••••••';
    el.myKey.textContent = '••••••••••••';
    el.qrWrap.hidden = true;
    clearQr();
    el.toggleId.textContent = 'показать';
    el.toggleId.setAttribute('aria-pressed', 'false');
  } else {
    el.myId.textContent = el.myId.dataset.real;
    el.myKey.textContent = el.myKey.dataset.real;
    showQr();
    el.toggleId.textContent = 'скрыть';
    el.toggleId.setAttribute('aria-pressed', 'true');
  }
}

// The QR carries ONLY the id — never a key, never the fingerprint seed.
function showQr() {
  el.qrWrap.hidden = false;
  try {
    renderQr(el.qrCanvas, el.myId.dataset.real, { scale: 5, quiet: 3 });
  } catch {
    el.qrWrap.hidden = true; // a browser without canvas still shows the text id
  }
}
function clearQr() {
  const c = el.qrCanvas;
  if (!c) return;
  try {
    if (c.width && c.getContext) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    c.width = 0;
    c.height = 0;
  } catch { /* nothing to release */ }
}

// ---- Search / contact flow ------------------------------------------------
function onSearchResult(m) {
  if (!m.found) {
    toast(`Идентификатор ${m.targetId} не найден или не в сети`, 'err');
    return;
  }
  if (chats.has(m.targetId)) { openChat(m.targetId); return; }
  peerNotice(m.targetId, `Собеседник найден: ${m.targetId}`, 'Отправить запрос', () => sendRequest(m.targetId), true);
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
  // A chat is always born empty. Reusing an old object here was the history bug:
  // a peer who was re-added under the same id would inherit the deleted past
  // under a brand-new key.
  if (chats.has(peerId)) purgeChat(peerId);
  const chat = {
    peerId, key, fingerprint, theirIdentityPub, myEph,
    messages: [], left: '', online: true, unread: 0,
    out: new Map(), in: new Map(), urls: new Set(),
  };
  chats.set(peerId, chat);
  renderChatList();
  openChat(peerId);
  toast('Диалог установлен');
}

// ---- Messaging ------------------------------------------------------------
function canWrite(chat) {
  return !!chat && !chat.left && !!chat.key
    && !!ws && ws.readyState === WebSocket.OPEN;
}

async function onIncomingMessage(m) {
  let chat = chats.get(m.from);
  if (!chat) return; // message for a chat we don't have: ignore (no storage)
  if (chat.left === 'temp') setChatLeft(m.from, ''); // an arriving frame proves they are back
  try {
    const text = await decryptMessage(chat.key, m.ciphertext);
    chat.messages.push({ me: false, text, ts: Date.now() });
  } catch {
    chat.messages.push({ me: false, text: '[не удалось расшифровать]', ts: Date.now() });
  }
  if (activeChat === m.from) {
    appendMessage(chat.messages[chat.messages.length - 1], true);
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
  if (!canWrite(chat)) { toast('Чат доступен только для чтения', 'err'); return; }
  const text = el.msgInput.value.replace(/\s+$/, '');
  if (!text) return;
  if (overSize(text)) { toast('Максимум 2 КБ на сообщение', 'err'); return; }
  const ciphertext = await encryptMessage(chat.key, text);
  send({ type: 'message', to: chat.peerId, ciphertext });
  chat.messages.push({ me: true, text, ts: Date.now() });
  el.msgInput.value = '';
  autosize();
  updateSizeHint();
  appendMessage(chat.messages[chat.messages.length - 1], true);
  scrollMessages();
  renderChatList();
}

// ---- Chat lifecycle: end, delete, presence -------------------------------
function endChat() {
  if (!activeChat) return;
  const peerId = activeChat;
  send({ type: 'end_chat', to: peerId });
  // The server echoes chat_ended to both sides. If the peer already left, no
  // echo comes back, so clear locally as well instead of waiting for it.
  purgeChat(peerId, { reason: 'Чат завершён' });
}

function onChatEnded(peerId) {
  purgeChat(peerId, { reason: 'Чат завершён' });
}

// «Удалить чат» — the survivor's side of a chat the other person left.
function deleteChat() {
  if (!activeChat) return;
  const peerId = activeChat;
  send({ type: 'delete_chat', to: peerId });
  purgeChat(peerId, { reason: 'Чат удалён' });
}

// The single place that removes everything a chat owns: history in memory and in
// the DOM, the chat key and the ephemeral pair, in-flight file transfers, blob
// URLs, the list row, pending contact requests and the open chat screen.
function purgeChat(peerId, { reason = '' } = {}) {
  dismissNotice(peerId);
  pendingOut.delete(peerId);
  for (const [requestId, req] of incoming) {
    if (req.from === peerId) incoming.delete(requestId);
  }
  renderRequests();

  const chat = chats.get(peerId);
  if (!chat) {
    if (activeChat === peerId) showEmptyChat();
    return;
  }
  releaseTransfers(chat);
  chat.messages.length = 0;
  chat.key = null;         // drop the derived key and the private ephemeral pair
  chat.myEph = null;
  chat.theirIdentityPub = null;
  chats.delete(peerId);

  if (activeChat === peerId) {
    activeChat = null;
    showNextChat();        // rebuilds or clears the messages pane from scratch
  } else {
    renderChatList();
  }
  if (reason) toast(reason);
}

// left: '' (normal) | 'temp' (отключился, grace window still open) | 'gone' (вышел)
function setChatLeft(peerId, left) {
  const chat = chats.get(peerId);
  if (!chat) return;
  if (chat.left === 'gone') return; // a final departure is never walked back
  chat.left = left;
  chat.online = !left;
  if (left) releaseTransfers(chat, { keepDelivered: true }); // frames cannot cross a broken connection
  if (activeChat === peerId) applyChatState(chat);
  renderChatList();
}

function onUndeliverable(peerId) {
  const chat = chats.get(peerId);
  if (chat) {
    if (!chat.left) setChatLeft(peerId, 'temp');
    toast('Собеседник не в сети — не отправлено', 'err');
  } else {
    toast('Собеседник не в сети', 'err');
  }
}

// Reflect "can this chat be written to" in the composer and the plate.
function applyChatState(chat) {
  const writing = canWrite(chat);
  el.peerPlate.hidden = !chat.left;
  el.plateText.textContent = chat.left === 'gone' ? 'Собеседник вышел' : 'Собеседник отключился';
  el.deleteChatBtn.hidden = chat.left !== 'gone';
  el.msgInput.disabled = !writing;
  el.sendBtn.disabled = !writing;
  el.attachBtn.disabled = !writing;
  el.composer.classList.toggle('readonly', !writing);
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
    row.className = 'chat-item' + (c.peerId === activeChat ? ' active' : '') + (c.left ? ' ro' : '');
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
    prev.textContent = !last ? 'Нет сообщений'
      : last.file ? `${last.me ? 'Вы: ' : ''}вложение · ${last.file.label}`
        : (last.me ? 'Вы: ' : '') + last.text;
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

  // Rebuilt from chat.messages every time: nothing that was deleted can survive
  // in the DOM, because the pane is emptied before it is filled. Bulk render is
  // not animated — a long chat must not replay a hundred animations at once.
  el.messages.innerHTML = '';
  chat.messages.forEach((m) => appendMessage(m));
  const note = document.createElement('div');
  note.className = 'msg system';
  note.textContent = 'Сообщения шифруются на вашем устройстве и не хранятся на сервере.';
  el.messages.appendChild(note);
  applyChatState(chat);
  scrollMessages();
  renderChatList();
  if (canWrite(chat)) el.msgInput.focus();
}

// Repaint the open conversation from chat.messages. Used when a transfer
// finishes, so a received image is drawn by the same code path as everything
// else — and so a deleted message can never be "restored" from the DOM.
function repaintChat() {
  const chat = chats.get(activeChat);
  if (!chat) return;
  el.messages.innerHTML = '';
  chat.messages.forEach((m) => appendMessage(m));
  scrollMessages();
}

function showNextChat() {
  if (chats.size) { openChat([...chats.keys()][0]); return; }
  showEmptyChat();
}

function showEmptyChat() {
  activeChat = null;
  clearChatView();
  el.app.dataset.pane = '';
  renderChatList();
}

function appendMessage(msg, animate = false) {
  const d = document.createElement('div');
  d.className = 'msg ' + (msg.me ? 'me' : 'peer') + (msg.file ? ' file' : '') + (animate ? ' in' : '');
  if (msg.file) {
    d.appendChild(fileBubble(msg));
    msg.el = d;
  } else {
    d.textContent = msg.text;
  }
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  d.appendChild(meta);
  el.messages.appendChild(d);
}
function scrollMessages() { el.messages.scrollTop = el.messages.scrollHeight; }

// ---- Attachments ----------------------------------------------------------
function isImage(mime) { return typeof mime === 'string' && mime.startsWith('image/'); }

function noteFor(f) {
  if (f.state === 'sending' || f.state === 'receiving') return ` · ${f.progress}%`;
  if (f.state === 'failed') return ` · ${f.note || 'не дошёл'}`;
  return '';
}

function fileBubble(msg) {
  const f = msg.file;
  const wrap = document.createElement('div');
  wrap.className = 'att' + (f.state === 'failed' ? ' failed' : '');
  if (isImage(f.mime) && f.url && f.state !== 'failed') {
    const img = document.createElement('img');
    img.className = 'att-img';
    img.src = f.url;
    img.alt = f.label;
    img.loading = 'lazy';
    img.decoding = 'async';
    wrap.appendChild(img);
  } else {
    const chip = document.createElement('div');
    chip.className = 'att-chip';
    chip.textContent = (f.label.split('.').pop() || 'file').toUpperCase();
    wrap.appendChild(chip);
  }
  const line = document.createElement('div');
  line.className = 'att-name';
  line.textContent = `${f.label} · ${humanSize(f.size)}${noteFor(f)}`;
  wrap.appendChild(line);
  const bar = document.createElement('div');
  bar.className = 'att-bar';
  const fill = document.createElement('i');
  fill.style.width = `${f.state === 'sending' || f.state === 'receiving' ? f.progress : 100}%`;
  bar.appendChild(fill);
  wrap.appendChild(bar);
  f.wrap = wrap; // refs so progress updates never rebuild the bubble
  f.line = line;
  f.bar = fill;
  return wrap;
}

function updateFileBubble(msg) {
  const f = msg.file;
  if (!msg.el || !f.bar) return;
  const running = f.state === 'sending' || f.state === 'receiving';
  f.bar.style.width = `${running ? f.progress : 100}%`;
  f.line.textContent = `${f.label} · ${humanSize(f.size)}${noteFor(f)}`;
  f.wrap.className = 'att' + (f.state === 'failed' ? ' failed' : '');
}

// Free the in-flight transfer state a chat owns: receiver buffers, timers and
// the blob previews of files that will never complete.
//
// `keepDelivered` is used when the peer only *disconnected*. The chat stays
// readable in that state, so the previews of files that already arrived must NOT
// be revoked — doing so blanks the history. They are released for real when the
// chat is purged or the session ends.
function releaseTransfers(chat, { keepDelivered = false } = {}) {
  for (const [, msg] of chat.out) {
    if (msg.file.state === 'sending') { msg.file.state = 'failed'; msg.file.note = 'прерван'; updateFileBubble(msg); }
  }
  chat.out.clear();
  for (const [, slot] of chat.in) {
    slot.receiver.destroy();
    if (slot.msg.file.state !== 'received') {
      slot.msg.file.state = 'failed'; slot.msg.file.note = 'не завершён'; updateFileBubble(slot.msg);
    }
  }
  chat.in.clear();
  if (keepDelivered) return;
  for (const url of chat.urls) { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
  chat.urls.clear();
}

// A transfer error from the server arrives without a chat context, so it is
// routed by transfer id wherever that transfer lives — not by whichever chat
// happens to be on screen when the error frame lands.
function failTransfer(transferId, note) {
  if (transferId) {
    for (const chat of chats.values()) {
      const msg = chat.out.get(transferId);
      if (msg) {
        chat.out.delete(transferId);
        msg.file.state = 'failed';
        msg.file.note = note;
        updateFileBubble(msg);
        send({ type: 'file_abort', to: chat.peerId, transferId });
        return;
      }
    }
  }
  failActiveFile(note);
}

function failActiveFile(note) {
  const chat = chats.get(activeChat);
  if (!chat || !chat.out.size) return;
  const [tid, msg] = [...chat.out.entries()].pop();
  chat.out.delete(tid);
  msg.file.state = 'failed';
  msg.file.note = note;
  updateFileBubble(msg);
}

const nextTick = () => new Promise((r) => setTimeout(r, 0));

async function onPickFiles() {
  const files = [...(el.fileInput.files || [])];
  try { el.fileInput.value = ''; } catch { /* allow picking the same file twice */ }
  for (const file of files) await sendFile(file);
}

// One file, start to finish: read → check size → sniff → clean metadata →
// (ask the user how) → encrypt in chunks → stream.
async function sendFile(file) {
  const chat = chats.get(activeChat);
  if (!canWrite(chat)) { toast('Чат доступен только для чтения', 'err'); return; }
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    toast('Не удалось прочитать файл', 'err');
    return;
  }
  if (!bytes.length) { toast('Файл пустой', 'err'); return; }
  if (bytes.length > MAX_FILE_BYTES) {
    toast(`Максимум 5 МБ, а у этого ${humanSize(bytes.length)}`, 'err');
    return;
  }

  const sniff = sniffFormat(bytes);
  let payload = bytes;
  let mime = sniff.mime;
  let note = '';

  if (sniff.cleanable) {
    const stripped = stripMetadata(bytes); // name, date, EXIF/GPS, IPTC, XMP die here
    let preview = '';
    try { preview = URL.createObjectURL(new Blob([stripped.bytes], { type: stripped.mime })); } catch { /* no preview */ }
    const choice = await askImageChoice({ preview, size: stripped.bytes.length, orientation: stripped.orientation });
    try { if (preview) URL.revokeObjectURL(preview); } catch { /* noop */ }
    if (!choice) return;

    // "Сжать" resizes and re-encodes. A rotated shot must also be re-encoded,
    // because the orientation flag is metadata we are deleting: the rotation has
    // to be baked into the pixels instead.
    if (choice === 'compress' || stripped.orientation !== 1) {
      try {
        const out = choice === 'compress'
          ? await compressImage(stripped.bytes, stripped.mime, { orientation: stripped.orientation })
          : await compressImage(stripped.bytes, stripped.mime, {
            maxSide: Infinity, quality: 0.92, orientation: stripped.orientation,
          });
        payload = out.bytes;
        mime = out.mime;
        if (choice !== 'compress') note = ' · поворот применён';
      } catch {
        toast('Браузер не обработал изображение', 'err');
        return;
      }
    } else {
      payload = stripped.bytes;
      mime = stripped.mime;
    }
  } else {
    // Formats we cannot clean reliably (GIF, BMP, HEIC, documents): the user must
    // see that metadata stays inside before anything goes out.
    const confirmed = await askMetadataWarning(sniff);
    if (!confirmed) return;
    note = ' · метаданные не удалены';
  }

  await streamFile(chat, payload, mime, note);
}

async function streamFile(chat, bytes, mime, note = '') {
  const transferId = randomTransferId();
  const chunks = chunkCount(bytes.length);
  const msg = { me: true, ts: Date.now(), file: fileState({ label: randomLabel(mime), mime, size: bytes.length, state: 'sending', note, transferId }) };
  try {
    msg.file.url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    chat.urls.add(msg.file.url);
  } catch { /* a missing preview must not block the transfer */ }
  chat.messages.push(msg);
  chat.out.set(transferId, msg);
  if (activeChat === chat.peerId) { appendMessage(msg, true); scrollMessages(); }
  renderChatList();

  send({ type: 'file_open', to: chat.peerId, transferId, size: bytes.length, chunks });
  try {
    for await (const frame of encryptFrames(bytes, chat.key)) {
      // The chat broke mid-transfer: say so, and stop the stream.
      if (!chats.has(chat.peerId) || chat.left || !chat.key) throw new Error('closed');
      send({ type: 'file_chunk', to: chat.peerId, transferId, index: frame.index, ciphertext: frame.ciphertext });
      msg.file.progress = percent(frame.index + 1, chunks);
      updateFileBubble(msg);
      await nextTick(); // let the frame paint on a slow phone
    }
  } catch {
    send({ type: 'file_abort', to: chat.peerId, transferId });
    chat.out.delete(transferId);
    msg.file.state = 'failed';
    msg.file.note = 'прерван';
    updateFileBubble(msg);
    return;
  }
  chat.out.delete(transferId);
  msg.file.state = 'sent';
  updateFileBubble(msg);
}

function fileState({ label, mime, size, state, note = '', transferId = '', url = '' }) {
  return { label, mime, size, state, note, transferId, url, progress: 0 };
}

// ---- Receiving a file ----------------------------------------------------
function onIncomingFileOpen(m) {
  const chat = chats.get(m.from);
  if (!chat) return; // no chat, no storage: refuse silently
  if (chat.left || !Number.isInteger(m.chunks) || m.chunks < 1 || m.size > MAX_FILE_BYTES) {
    send({ type: 'file_abort', to: m.from, transferId: m.transferId });
    return;
  }
  const msg = { me: false, ts: Date.now(), file: fileState({ label: randomLabel('application/octet-stream'), mime: '', size: m.size, state: 'receiving', transferId: m.transferId }) };
  chat.messages.push(msg);
  const receiver = new Receiver({
    transferId: m.transferId, size: m.size, chunks: m.chunks, key: chat.key,
    onExpire: () => abortIncoming(chat, m.transferId, 'не дошёл'),
  });
  chat.in.set(m.transferId, { receiver, msg });
  if (activeChat === chat.peerId) { appendMessage(msg, true); scrollMessages(); }
  renderChatList();
}

async function onIncomingFileChunk(m) {
  const chat = chats.get(m.from);
  const slot = chat && chat.in.get(m.transferId);
  if (!slot) return; // unknown or already discarded transfer
  let complete = false;
  try {
    complete = await slot.receiver.add(m.index, m.ciphertext);
  } catch {
    abortIncoming(chat, m.transferId, 'повреждён'); // AEAD tag mismatch: drop it
    return;
  }
  slot.msg.file.progress = percent(slot.receiver.got, slot.receiver.chunks);
  updateFileBubble(slot.msg);
  if (!complete) return;

  const bytes = slot.receiver.assemble();
  slot.receiver.destroy();
  chat.in.delete(m.transferId);
  const sniff = sniffFormat(bytes); // the type comes from the bytes, never from a name
  try {
    slot.msg.file.url = URL.createObjectURL(new Blob([bytes], { type: sniff.mime }));
    chat.urls.add(slot.msg.file.url);
  } catch { /* no preview, the file is still complete */ }
  slot.msg.file.state = 'received';
  slot.msg.file.mime = sniff.mime;
  slot.msg.file.size = bytes.length;
  slot.msg.file.label = randomLabel(sniff.mime); // the real name never existed here; now the extension fits the bytes
  if (activeChat === chat.peerId) repaintChat(); else renderChatList();
}

function abortIncoming(chat, transferId, note) {
  const slot = chat && chat.in.get(transferId);
  if (!slot) return;
  slot.receiver.destroy();
  chat.in.delete(transferId);
  slot.msg.file.state = 'failed';
  slot.msg.file.note = note;
  updateFileBubble(slot.msg);
}

function onIncomingFileAborted(m) {
  abortIncoming(chats.get(m.id), m.transferId, 'прерван');
}

// ---- Dialogs (image options, metadata warning) ---------------------------
let dialogResolve = null;

function showDialog({ title, lines = [], preview = '', actions = [] }) {
  el.dialogTitle.textContent = title;
  el.dialogBody.innerHTML = '';
  if (preview) {
    const img = document.createElement('img');
    img.className = 'dialog-preview';
    img.src = preview;
    img.alt = '';
    el.dialogBody.appendChild(img);
  }
  for (const line of lines) {
    const p = document.createElement('div');
    p.className = 'dialog-line';
    p.textContent = line;
    el.dialogBody.appendChild(p);
  }
  el.dialogActions.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = a.kind || 'mini';
    b.textContent = a.label;
    b.onclick = () => closeDialog(a.value);
    el.dialogActions.appendChild(b);
  }
  el.dialog.hidden = false;
  return new Promise((res) => { dialogResolve = res; });
}

function closeDialog(value) {
  if (el.dialog.hidden) return;
  el.dialog.hidden = true;
  el.dialogBody.innerHTML = '';
  el.dialogActions.innerHTML = '';
  const res = dialogResolve;
  dialogResolve = null;
  if (res) res(value);
}

function askImageChoice({ preview, size, orientation }) {
  const lines = [
    'Метаданные удаляются до шифрования: имя файла, дата, EXIF, GPS, IPTC, XMP.',
    `После очистки: ${humanSize(size)}.`,
  ];
  if (orientation !== 1) lines.push('У снимка есть флаг поворота — он будет запечён в пиксели, файл перекодируется.');
  return showDialog({
    title: 'Отправить изображение',
    lines,
    preview,
    actions: [
      { label: 'Сжать', kind: 'primary small', value: 'compress' },
      { label: 'Без сжатия', kind: 'mini', value: 'raw' },
      { label: 'Отмена', kind: 'danger', value: null },
    ],
  });
}

function askMetadataWarning(sniff) {
  return showDialog({
    title: 'Метаданные не удаляются',
    lines: [
      `Формат файла: ${sniff.format}. Надёжно вычистить метаданные из него браузер не может.`,
      'Внутри могут остаться имя файла, дата съёмки, геопозиция и автор.',
    ],
    actions: [
      { label: 'Отправить всё равно', kind: 'primary small', value: true },
      { label: 'Отмена', kind: 'danger', value: false },
    ],
  });
}

// ---- QR scanner ----------------------------------------------------------
async function openScanner() {
  if (scanner) return;
  if (!canScan()) {
    toast('Камера недоступна в этом браузере — введите ID вручную', 'err');
    return;
  }
  el.scanModal.hidden = false;
  el.scanStatus.textContent = 'Запрашиваем доступ к камере…';
  try {
    scanner = await startScan({ video: el.scanVideo, canvas: el.scanCanvas });
    // The permission prompt can outlive the window: if the user closed it while
    // the camera was being acquired, release the stream right now.
    if (el.scanModal.hidden) {
      scanner.stop();
      scanner = null;
      return;
    }
    el.scanStatus.textContent = 'Наведите камеру на QR-код собеседника.';
    const value = await scanner.promise;
    onScanResult(value);
  } catch (err) {
    const message = String(err && err.message || '');
    if (message === 'stopped') {
      /* closed by the user */
    } else if (message.startsWith('camera_denied:')) {
      toast(message.slice('camera_denied:'.length), 'err');
    } else if (message === 'decoder_unavailable' || message === 'camera_unavailable') {
      toast('Браузер не может читать QR — введите ID вручную', 'err');
    } else {
      toast('Не удалось включить камеру', 'err');
    }
  } finally {
    closeScanner();
  }
}

function closeScanner() {
  if (scanner) {
    try { scanner.stop(); } catch { /* already stopped */ }
    scanner = null;
  }
  el.scanModal.hidden = true;
  el.scanStatus.textContent = 'Наведите камеру на QR-код собеседника. Изображение никуда не отправляется.';
}

// The scanned payload starts a search immediately, that is the point of a scan;
// what is never automatic is the contact request itself — the user confirms it
// with the «Отправить запрос» button the search result shows.
function onScanResult(raw) {
  if (!isId(raw)) {
    toast('В этом QR нет идентификатора shh', 'err');
    return;
  }
  const id = String(raw).trim().toUpperCase();
  el.searchInput.value = id;
  send({ type: 'search', targetId: id });
}

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
// Hide and empty the chat pane (header, messages, composer) back to the empty
// state. Used on logout and whenever no chat is selected.
function clearChatView() {
  el.messages.innerHTML = '';
  el.chatTop.hidden = true;
  el.messages.hidden = true;
  el.composer.hidden = true;
  el.chatMenu.hidden = true;
  el.emptyState.hidden = false;
  el.peerName.textContent = '';
  el.fpShort.textContent = '';
  el.fpFull.textContent = '';
  el.msgInput.value = '';
  el.peerPlate.hidden = true;
  el.deleteChatBtn.hidden = true;
  el.composer.classList.remove('readonly');
  el.msgInput.disabled = false;
  el.sendBtn.disabled = false;
  el.attachBtn.disabled = false;
}

// Full client reset used by "Выйти". Clears every piece of state and DOM and
// closes the WebSocket (so the server drops the session + its chats), so a
// brand-new session always starts from a clean screen without a page reload.
function resetAll() {
  intentionalClose = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  // Tell the server this is a deliberate exit, not a dropped tab: it tears the
  // session down at once and marks every chat around it as read-only.
  send({ type: 'exit' });

  if (ws) {
    // Detach handlers first: a late 'close' from the old socket must never touch
    // the session we are about to create.
    try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; } catch { /* noop */ }
    try { ws.close(); } catch { /* noop */ }
  }
  ws = null;

  closeScanner();
  closeDialog(null);
  for (const chat of chats.values()) releaseTransfers(chat); // revoke blob URLs, kill timers
  session = null;
  lastPow = { challenge: null, nonce: null };
  activeChat = null;
  chats.clear();
  pendingOut.clear();
  incoming.clear();

  // Clear every transient UI element: chat list, open chat, messages, contact
  // requests, the search field and its results, and all toasts/notices.
  notifByPeer.forEach((t) => t.remove());
  notifByPeer.clear();
  el.toasts.innerHTML = '';
  el.searchInput.value = '';
  clearChatView();
  renderChatList();
  renderRequests();

  delete el.myId.dataset.real;
  delete el.myKey.dataset.real;
  el.myId.textContent = '••••••••••••';
  el.myKey.textContent = '••••••••••••';
  el.qrWrap.hidden = true;
  clearQr();
  profileRevealed = false;
  el.toggleId.textContent = 'показать';
  el.avatarDot.classList.remove('online');
  el.profilePanel.hidden = true;

  el.app.hidden = true;
  el.app.dataset.pane = '';
  el.start.hidden = false;
  el.createBtn.disabled = false;
  intentionalClose = false;
}

// ---- Wire up events -------------------------------------------------------
let cryptoOk = true;

function init() {
  detectCurve().then((curve) => {
    cryptoOk = !!curve;
    if (!curve) el.createBtn.disabled = true;
  });

  el.createBtn.onclick = () => {
    if (!cryptoOk) { toast('Браузер не поддерживает необходимую криптографию', 'err'); return; }
    el.createBtn.disabled = true;
    connect();
  };

  el.profileBtn.onclick = () => { el.profilePanel.hidden = !el.profilePanel.hidden; };
  el.toggleId.onclick = () => maskProfile(profileRevealed);
  el.copyId.onclick = async () => {
    try { await navigator.clipboard.writeText(session.id); toast('Идентификатор скопирован'); }
    catch { toast('Не удалось скопировать', 'err'); }
  };
  el.logoutBtn.onclick = () => { el.profilePanel.hidden = true; resetAll(); };

  const doSearch = () => {
    const q = parseId(el.searchInput.value) || el.searchInput.value.trim().toUpperCase().replace(/[^A-Z2-7]/g, '');
    el.searchInput.value = q;
    if (q.length < 12) { toast('Введите идентификатор (мин. 12 символов)', 'err'); return; }
    send({ type: 'search', targetId: q });
  };
  el.searchBtn.onclick = doSearch;
  el.searchInput.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };

  el.scanBtn.onclick = openScanner;
  el.scanCloseBtn.onclick = closeScanner;

  el.chatMenuBtn.onclick = (e) => { e.stopPropagation(); el.chatMenu.hidden = !el.chatMenu.hidden; };
  el.fpChip.onclick = () => { el.chatMenu.hidden = false; };
  document.addEventListener('click', (e) => {
    if (!el.chatMenu.hidden && !el.chatMenu.contains(e.target) && e.target !== el.chatMenuBtn) el.chatMenu.hidden = true;
    if (!el.profilePanel.hidden && !el.profilePanel.contains(e.target) && !el.profileBtn.contains(e.target)) el.profilePanel.hidden = true;
  });
  el.endChatBtn.onclick = endChat;
  el.deleteChatBtn.onclick = deleteChat;

  el.sendBtn.onclick = sendMessage;
  el.attachBtn.onclick = () => { if (!el.attachBtn.disabled) el.fileInput.click(); };
  el.fileInput.onchange = onPickFiles;
  el.msgInput.addEventListener('input', () => { autosize(); updateSizeHint(); });
  el.msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Escape and a click outside always tear the camera down — an open shutter is
  // the one thing this app must never leave running.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.scanModal.hidden) closeScanner();
    else if (!el.dialog.hidden) closeDialog(null);
    else { el.chatMenu.hidden = true; el.profilePanel.hidden = true; }
  });
  el.scanModal.addEventListener?.('click', (e) => { if (e.target === el.scanModal) closeScanner(); });
  el.dialog.addEventListener?.('click', (e) => { if (e.target === el.dialog) closeDialog(null); });

  // Data only lives in RAM: closing the tab drops the connection, the server
  // waits out the grace window and then removes the session and its chats.
  window.addEventListener('beforeunload', () => { /* graceful ws close handled by OS; server prunes after grace */ });
}

init();
