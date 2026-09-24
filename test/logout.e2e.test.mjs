// End-to-end autotest for the logout / new-session flow.
//
// It boots the REAL server, installs a tiny DOM shim, imports the REAL
// public/app.js and drives it through its actual event handlers over a live
// WebSocket, alongside an independent "peer" client. This exercises the genuine
// client reset logic plus the server session teardown.
//
// Run: node test/logout.e2e.test.mjs
import {
  PORT, delay, ok, summary, b32id, makeDom, establish, findButton,
  rawClient, bootServer, waitUntil, chatItems, bootGlobals,
} from './helpers.mjs';

async function main() {
  const server = await bootServer(PORT);
  console.log('server is up\n');
  const { wsUrl } = bootGlobals(PORT);
  const dom = makeDom();
  const cryptoMod = await import('../public/crypto.js');
  const { generateIdentity, generateEphemeral, curveFromPubB64, deriveChatKey, encryptMessage, decryptMessage } = cryptoMod;

  // Peer "Bob": accepts a request, echoes the first message back.
  const bob = rawClient('bob', wsUrl);
  bob.id = b32id();
  const bobIdentity = await generateIdentity();
  await establish(bob, bobIdentity.publicB64);
  let bobKey = null, bobPeerId = null, bobGotMessage = null, bobEchoSent = false;
  bob.ws.on('message', async (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'contact_request') {
      const eph = await generateEphemeral(curveFromPubB64(m.ephPub));
      bobKey = await deriveChatKey(eph, m.ephPub);
      bobPeerId = m.from;
      bob.json({ type: 'contact_response', requestId: m.requestId, accept: true, publicKey: bobIdentity.publicB64, ephPub: eph.publicB64 });
    } else if (m.type === 'message' && bobKey) {
      bobGotMessage = await decryptMessage(bobKey, m.ciphertext);
      bob.json({ type: 'message', to: bobPeerId, ciphertext: await encryptMessage(bobKey, 'hi from bob') });
      bobEchoSent = true;
    }
  });

  await import('../public/app.js'); // runs init()
  await delay(50);

  // 1) Create session A.
  dom.get('createBtn').onclick();
  const myIdEl = dom.get('myId');
  await waitUntil(() => !!myIdEl.dataset.real, 'A creates a session', 9000);
  const oldId = myIdEl.dataset.real;
  ok(!!oldId && /^[A-Z2-7]{12}$/.test(oldId), `session created, A id = ${oldId}`);
  ok(!dom.get('app').hidden, 'app is visible');
  ok(!!dom.get('myKey').dataset.real, 'the public key is available (masked) for the profile panel');
  ok(dom.get('qrWrap').hidden === true, 'the QR is hidden until «показать»');

  // 2) A opens a chat with Bob and exchanges a message.
  dom.get('searchInput').value = bob.id;
  dom.get('searchBtn').onclick();
  await waitUntil(() => findButton(dom.get('toasts'), 'Отправить запрос'), 'found-result block appears', 5000);
  findButton(dom.get('toasts'), 'Отправить запрос').onclick();
  await waitUntil(() => chatItems(dom).length === 1, 'chat appears in list', 5000);
  ok(chatItems(dom).length === 1, 'one chat in the list');
  ok(dom.get('messages').children.length >= 1, 'messages pane rendered (chat opened)');

  dom.get('msgInput').value = 'привет от alice';
  dom.get('sendBtn').onclick();
  await waitUntil(() => bobGotMessage === 'привет от alice', 'Bob receives decrypted message', 5000);
  ok(bobGotMessage === 'привет от alice', 'message encrypted/relayed/decrypted end-to-end');

  // 3) LOGOUT — an explicit exit, so the server must not keep the session at all.
  dom.get('logoutBtn').onclick();
  await delay(50);
  ok(!myIdEl.dataset.real || myIdEl.dataset.real !== oldId, 'A identity cleared on logout');
  ok(chatItems(dom).length === 0, 'chat list cleared on logout');
  ok(dom.get('messages').children.length === 0, 'messages cleared on logout');
  ok(dom.get('app').hidden === true && dom.get('start').hidden === false, 'back to start screen');

  await waitUntil(() => bob.inbox.some((m) => m.type === 'peer_gone' && m.id === oldId),
    'server told Bob the departure is final', 5000);
  ok(bob.inbox.some((m) => m.type === 'peer_gone' && m.id === oldId),
    'logout sends exit: peers get peer_gone immediately, no grace window');

  // 4) CREATE A NEW SESSION — the screen must be empty, without a reload.
  dom.get('createBtn').onclick();
  await waitUntil(() => myIdEl.dataset.real && myIdEl.dataset.real !== oldId, 'A gets a fresh identity', 9000);
  const newId = myIdEl.dataset.real;
  ok(!!newId && newId !== oldId, `new session started with fresh id = ${newId}`);
  ok(chatItems(dom).length === 0, 'NEW session: chat list is empty');
  ok(dom.get('messages').children.length === 0, 'NEW session: messages are empty');
  ok(dom.get('searchInput').value === '', 'NEW session: search field is empty');
  ok(dom.get('messages').hidden === true, 'NEW session: no chat pane open');
  ok(dom.get('toasts').children.length === 0, 'NEW session: no leftover notices or toasts');

  // 5) The old session is gone on the server (an observer cannot even find it).
  const observer = rawClient('observer', wsUrl);
  observer.id = b32id();
  await establish(observer, (await generateIdentity()).publicB64);
  observer.json({ type: 'search', targetId: oldId });
  const sr = await observer.wait((m) => m.type === 'search_result' && m.targetId === oldId, 5000);
  ok(sr.found === false, 'old session is removed / inactive on the server');

  const failed = summary();
  observer.ws.close(); bob.ws.close(); server.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nTEST CRASHED:', e); process.exit(1); });
