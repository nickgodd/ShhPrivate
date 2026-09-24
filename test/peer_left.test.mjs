// Peer leaving the session: the plate, the blocked composer, the reversible
// grace window, the final "вышел" state and "Удалить чат" — plus the proof that
// the server itself refuses to deliver into a chat with no second side.
//
// Run: node test/peer_left.test.mjs
import {
  delay, ok, summary, b32id, makeDom, establish, findButton, rawClient,
  bootServer, waitUntil, chatItems, messagesOf, bootGlobals, textOf, findByClass,
  allByClass,
} from './helpers.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import nodeCrypto from 'node:crypto';

const PORT = 4612;

// A tiny but structurally valid PNG, so the receiver treats it as an image.
function png() {
  const enc = (s) => Array.from(new TextEncoder().encode(s));
  const chunk = (type, data) => [
    data.length >> 24 & 255, data.length >> 16 & 255, data.length >> 8 & 255, data.length & 255,
    ...enc(type), ...data, 0, 0, 0, 0,
  ];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', new Array(13).fill(9)),
    ...chunk('IDAT', new Array(500).fill(4)),
    ...chunk('IEND', []),
  ]);
}

async function main() {
  const server = await bootServer(PORT);
  const { wsUrl } = bootGlobals(PORT);
  const dom = makeDom();
  const cryptoMod = await import('../public/crypto.js');
  const { generateIdentity, generateEphemeral, curveFromPubB64, deriveChatKey } = cryptoMod;
  console.log('server is up\n');

  // Bob: raw client that accepts whatever request arrives.
  let bob = rawClient('bob', wsUrl);
  const bobId = b32id();
  const bobIdentity = await generateIdentity();
  bob.id = bobId;
  await establish(bob, bobIdentity.publicB64);
  let bobKey = null;
  bob.ws.on('message', async (d) => {
    const m = JSON.parse(d.toString());
    if (m.type !== 'contact_request') return;
    const eph = await generateEphemeral(curveFromPubB64(m.ephPub));
    bobKey = await deriveChatKey(eph, m.ephPub);
    bob.json({ type: 'contact_response', requestId: m.requestId, accept: true, publicKey: bobIdentity.publicB64, ephPub: eph.publicB64 });
  });
  // Send one encrypted file frame as Bob.
  const bobFrame = async (transferId, index, bytes, to) => {
    const iv = nodeCrypto.randomBytes(12);
    const ct = Buffer.from(await nodeCrypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, bobKey, bytes));
    bob.json({
      type: 'file_chunk', to, transferId, index,
      ciphertext: Buffer.concat([iv, ct]).toString('base64'),
    });
  };

  await import('../public/app.js');
  await delay(50);

  const myIdEl = dom.get('myId');
  dom.get('createBtn').onclick();
  await waitUntil(() => !!myIdEl.dataset.real, 'Alice creates a session', 9000);

  dom.get('searchInput').value = bobId;
  dom.get('searchBtn').onclick();
  await waitUntil(() => findButton(dom.get('toasts'), 'Отправить запрос'), 'search result', 5000);
  findButton(dom.get('toasts'), 'Отправить запрос').onclick();
  await waitUntil(() => chatItems(dom).length === 1, 'chat established', 5000);
  ok(chatItems(dom).length === 1, 'chat is open with Bob');
  ok(dom.get('msgInput').disabled === false && dom.get('sendBtn').disabled === false, 'composer enabled while both are present');
  ok(dom.get('peerPlate').hidden === true, 'no plate while both are present');

  // 1) Bob closes his tab: a temporary disconnect, reversible inside the grace window.
  bob.ws.close();
  await waitUntil(() => dom.get('peerPlate').hidden === false, 'plate appears', 5000);
  ok(textOf(dom.get('plateText')) === 'Собеседник отключился', `plate says "отключился" (got "${textOf(dom.get('plateText'))}")`);
  ok(dom.get('msgInput').disabled === true, 'textarea disabled');
  ok(dom.get('sendBtn').disabled === true, 'send button disabled');
  ok(dom.get('attachBtn').disabled === true, 'attach button disabled');
  ok(dom.get('deleteChatBtn').hidden === true, 'no delete button yet — this may still be a refresh');
  ok(chatItems(dom).length === 1, 'the chat stays in the list');
  ok(!!findByClass(chatItems(dom)[0], 'ro'), 'the list row is marked read-only');

  // Client-side sending is impossible: nothing new reaches the transcript.
  const before = messagesOf(dom).length;
  dom.get('msgInput').value = 'в никуда';
  dom.get('sendBtn').onclick();
  await delay(120);
  ok(messagesOf(dom).length === before, 'a disabled composer cannot add messages');

  // 2) Bob reconnects with the same identity inside the grace window.
  bob = rawClient('bob2', wsUrl);
  bob.id = bobId;
  const resumed = await establish(bob, bobIdentity.publicB64);
  ok(!!resumed && resumed.type === 'session_created', 'Bob resumed the same session');
  await waitUntil(() => dom.get('peerPlate').hidden === true, 'plate disappears', 5000);
  ok(dom.get('peerPlate').hidden === true, 'peer_back hides the plate');
  ok(dom.get('msgInput').disabled === false && dom.get('sendBtn').disabled === false, 'composer unlocked again');
  ok(!findByClass(chatItems(dom)[0], 'ro'), 'the row is no longer marked read-only');

  // 2b) Bob delivers one complete file and starts one that never finishes.
  const aliceId = myIdEl.dataset.real;
  const whole = png();
  const tidDone = 'done' + b32id(6).toLowerCase();
  bob.json({ type: 'file_open', to: aliceId, transferId: tidDone, size: whole.length, chunks: 1 });
  await bobFrame(tidDone, 0, whole, aliceId);
  await waitUntil(() => allByClass(dom.get('messages'), 'att-img').length === 1, 'file received', 5000);
  const delivered = allByClass(dom.get('messages'), 'att-img')[0];
  const deliveredUrl = delivered.src;
  ok(!!deliveredUrl && dom.blobs.has(deliveredUrl), 'the delivered attachment holds a live preview');

  const tidHalf = 'half' + b32id(6).toLowerCase();
  bob.json({ type: 'file_open', to: aliceId, transferId: tidHalf, size: 200_000, chunks: 3 });
  await bobFrame(tidHalf, 0, png(), aliceId);
  await delay(150);
  ok(allByClass(dom.get('messages'), 'att').length === 2, 'the incomplete transfer is shown as in progress');
  const historyAtDisconnect = messagesOf(dom).length;

  // 3) Bob leaves for good: after the grace window the chat is read-only forever.
  bob.ws.close();
  await waitUntil(() => dom.get('peerPlate').hidden === false, 'plate returns', 5000);
  ok(textOf(dom.get('plateText')) === 'Собеседник отключился', 'the departure starts as temporary');
  // A temporary disconnect must not eat the history: the preview that already
  // arrived stays valid, only the unfinished transfer is given up on.
  ok(dom.blobs.has(deliveredUrl), 'a disconnect does not revoke previews of delivered files');
  ok(allByClass(dom.get('messages'), 'att-img').length === 1, 'the delivered preview is still rendered');
  ok(textOf(dom.get('messages')).includes('не завершён'), 'the unfinished transfer is given up on');
  await sleep(9000); // GRACE_MS on the server is 8 s
  await waitUntil(() => textOf(dom.get('plateText')) === 'Собеседник вышел', 'plate escalates', 4000);
  ok(textOf(dom.get('plateText')) === 'Собеседник вышел', 'plate escalates to "вышел" after the grace window');
  ok(dom.get('deleteChatBtn').hidden === false, '«Удалить чат» is offered');
  ok(dom.get('msgInput').disabled === true, 'still read-only');
  ok(messagesOf(dom).length === historyAtDisconnect, 'history is still readable, and it did not grow');
  ok(dom.blobs.has(deliveredUrl), 'the delivered preview survived all the way to the final state');

  // 4) «Удалить чат» wipes the chat locally: row, transcript, open pane.
  dom.get('deleteChatBtn').onclick();
  await delay(120);
  ok(chatItems(dom).length === 0, 'chat removed from the list');
  ok(messagesOf(dom).length === 0 && dom.get('messages').children.length === 0, 'transcript gone from the DOM');
  ok(dom.get('peerPlate').hidden === true, 'plate gone with the chat');
  ok(dom.get('messages').hidden === true && dom.get('emptyState').hidden === false, 'the chat screen is closed');
  ok(dom.blobs.size === 0, '«Удалить чат» releases every blob the chat held');

  // 5) Server side: a chat with no second side refuses delivery outright.
  const { generateIdentity: gid } = cryptoMod;
  const carol = rawClient('carol', wsUrl);
  const dan = rawClient('dan', wsUrl);
  carol.id = b32id();
  dan.id = b32id();
  const carolId = await gid();
  const danId = await gid();
  await establish(carol, carolId.publicB64);
  await establish(dan, danId.publicB64);

  const carolEph = await generateEphemeral();
  carol.json({ type: 'contact_request', to: dan.id, publicKey: carolId.publicB64, ephPub: carolEph.publicB64 });
  const req = await dan.wait((m) => m.type === 'contact_request');
  const danEph = await generateEphemeral(curveFromPubB64(req.ephPub));
  dan.json({ type: 'contact_response', requestId: req.requestId, accept: true, publicKey: danId.publicB64, ephPub: danEph.publicB64 });
  await delay(100);

  const frame = { type: 'message', to: dan.id, ciphertext: Buffer.from('a'.repeat(40)).toString('base64') };
  carol.json(frame);
  await dan.wait((m) => m.type === 'message');
  ok(true, 'baseline: a live chat relays messages both ways');

  carol.ws.close(); // Carol is gone; after the grace window Dan must not be able to write
  await sleep(9000);
  dan.clear();
  dan.json({ type: 'message', to: carol.id, ciphertext: Buffer.from('a'.repeat(40)).toString('base64') });
  const refused = await dan.wait((m) => m.type === 'undeliverable' || m.type === 'error', 4000).catch(() => null);
  ok(!!refused && (refused.type === 'undeliverable' || refused.message === 'no_chat'),
    `server refuses to write into a read-only chat (${refused ? refused.type + (refused.message || '') : 'nothing back'})`);

  console.log('');
  const failed = summary();
  dan.ws.close(); carol.ws.close(); server.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nTEST CRASHED:', e); process.exit(1); });
