// Ending a chat must erase everything on BOTH sides and on the server, and a
// re-created chat must not inherit the deleted history (the old bug: the peer
// vanished from the list while the transcript stayed readable/writable).
//
// Run: node test/chat_end.test.mjs
import {
  delay, ok, summary, b32id, makeDom, establish, findButton, rawClient,
  bootServer, waitUntil, chatItems, messagesOf, bootGlobals, textOf,
} from './helpers.mjs';

const PORT = 4613;

async function main() {
  const server = await bootServer(PORT);
  const { wsUrl } = bootGlobals(PORT);
  const dom = makeDom();
  const { generateIdentity, generateEphemeral, curveFromPubB64, deriveChatKey, encryptMessage, decryptMessage } =
    await import('../public/crypto.js');
  console.log('server is up\n');

  const bob = rawClient('bob', wsUrl);
  bob.id = b32id();
  const bobIdentity = await generateIdentity();
  await establish(bob, bobIdentity.publicB64);
  let bobKey = null, bobPeerId = null, bobLastText = null;
  bob.ws.on('message', async (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'contact_request') {
      const eph = await generateEphemeral(curveFromPubB64(m.ephPub));
      bobKey = await deriveChatKey(eph, m.ephPub);
      bobPeerId = m.from;
      bob.json({ type: 'contact_response', requestId: m.requestId, accept: true, publicKey: bobIdentity.publicB64, ephPub: eph.publicB64 });
    } else if (m.type === 'message' && bobKey) {
      bobLastText = await decryptMessage(bobKey, m.ciphertext);
    }
  });

  await import('../public/app.js');
  await delay(50);
  const myIdEl = dom.get('myId');
  dom.get('createBtn').onclick();
  await waitUntil(() => !!myIdEl.dataset.real, 'session', 9000);
  const aliceId = myIdEl.dataset.real;

  async function openChatWithBob() {
    dom.get('searchInput').value = bob.id;
    dom.get('searchBtn').onclick();
    await waitUntil(() => findButton(dom.get('toasts'), 'Отправить запрос'), 'search result', 5000);
    findButton(dom.get('toasts'), 'Отправить запрос').onclick();
    await waitUntil(() => chatItems(dom).length === 1, 'chat established', 5000);
  }
  async function sendHello(text) {
    dom.get('msgInput').value = text;
    dom.get('sendBtn').onclick();
    await waitUntil(() => bobLastText === text, 'Bob receives it', 5000);
  }

  await openChatWithBob();
  await sendHello('секретное письмо');
  ok(messagesOf(dom).length >= 1, 'transcript has the message before the chat is ended');

  // 1) Alice ends the chat through the ⋯ menu.
  dom.get('chatMenuBtn').onclick({ stopPropagation() {} });
  dom.get('endChatBtn').onclick();
  await delay(150);

  ok(chatItems(dom).length === 0, 'initiator: the row is gone from the list');
  ok(dom.get('messages').children.length === 0, 'initiator: the transcript is gone from the DOM');
  ok(dom.get('messages').hidden === true && dom.get('emptyState').hidden === false,
    'initiator: the open chat screen was closed');
  ok(dom.get('msgInput').value === '', 'initiator: the composer draft is cleared');
  await waitUntil(() => bob.inbox.some((m) => m.type === 'chat_ended' && m.id === aliceId),
    'peer is told the chat ended', 5000);
  ok(bob.inbox.some((m) => m.type === 'chat_ended' && m.id === aliceId),
    'peer receives chat_ended (and must wipe the same way the client does)');

  // 2) The server has no chat left: writing into it is refused.
  bob.clear();
  bob.json({ type: 'message', to: aliceId, ciphertext: Buffer.from('a'.repeat(40)).toString('base64') });
  const refused = await bob.wait((m) => m.type === 'undeliverable' || m.type === 'error', 4000).catch(() => null);
  ok(!!refused, 'the server refuses a message to the ended chat');

  // 3) Sending from a client with no open chat does nothing at all.
  const before = messagesOf(dom).length;
  dom.get('msgInput').value = 'в никуда';
  dom.get('sendBtn').onclick();
  await delay(120);
  ok(messagesOf(dom).length === before, 'no message can be written into the dead chat');

  // 4) Regression: a chat re-created with the same peer starts EMPTY.
  await openChatWithBob();
  ok(chatItems(dom).length === 1, 'a new chat with the same peer is established');
  ok(messagesOf(dom).every((m) => !textOf(m).includes('секретное письмо')),
    'the deleted history did not come back');
  ok(!textOf(dom.get('chatList')).includes('секретное письмо'), 'and not through the list preview either');

  // 5) Now the PEER ends it: the receiving client must purge identically.
  const transcriptLen = messagesOf(dom).length;
  bob.clear();
  bob.json({ type: 'end_chat', to: aliceId });
  await delay(200);
  ok(chatItems(dom).length === 0, 'receiver: the row is gone');
  ok(dom.get('messages').children.length === 0, 'receiver: the transcript is wiped from the DOM');
  ok(transcriptLen >= 0 && dom.get('emptyState').hidden === false, 'receiver: the chat screen is closed');
  ok(dom.get('toasts').children.length >= 0 && !textOf(dom.get('toasts')).includes('секретное письмо'),
    'receiver: no leftover notice carries the old content');

  console.log('');
  const failed = summary();
  bob.ws.close(); server.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nTEST CRASHED:', e); process.exit(1); });
