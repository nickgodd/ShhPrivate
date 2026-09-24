// Attachments end to end: an app-driven client and a raw peer that really
// decrypts and reassembles the chunks, in both directions. Verifies content
// equality byte for byte, that metadata never reaches the wire, and that an
// oversized file is refused before anything is sent.
//
// Run: node test/file.test.mjs
import {
  delay, ok, summary, b32id, makeDom, establish, findButton, rawClient,
  bootServer, waitUntil, chatItems, bootGlobals, textOf, allByClass, sha256hex,
} from './helpers.mjs';
import crypto from 'node:crypto';

const PORT = 4614;
const enc = (s) => Array.from(new TextEncoder().encode(s));
const u8 = (arr) => Uint8Array.from(arr);

// A PNG with a text chunk full of metadata and a big image payload.
function buildPng(payloadBytes) {
  const chunk = (type, data) => u8([
    data.length >> 24 & 255, data.length >> 16 & 255, data.length >> 8 & 255, data.length & 255,
    ...enc(type), ...data, 0, 0, 0, 0,
  ]);
  const idat = new Array(payloadBytes).fill(0).map((_, i) => (i * 37 + 11) & 255);
  return u8([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', new Array(13).fill(9)),
    ...chunk('tEXt', [...enc('Author\0'), ...enc('Ivan Petrovich')]),
    ...chunk('IDAT', idat),
    ...chunk('IEND', []),
  ]);
}

function ascii(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
function concatParts(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function main() {
  const server = await bootServer(PORT);
  const { wsUrl } = bootGlobals(PORT);
  const dom = makeDom();
  const dialogButton = (text) => findButton(dom.get('dialogActions'), text);
  const { generateIdentity, generateEphemeral, curveFromPubB64, deriveChatKey } =
    await import('../public/crypto.js');
  const { stripMetadata } = await import('../public/media.js');
  console.log('server is up\n');

  // Bob: a raw peer that derives the chat key and reassembles file transfers.
  const bob = rawClient('bob', wsUrl);
  bob.id = b32id();
  const bobIdentity = await generateIdentity();
  await establish(bob, bobIdentity.publicB64);
  let bobKey = null;
  const bobTransfers = new Map();
  const bobFrames = [];
  async function decryptFrame(b64) {
    const raw = Buffer.from(b64, 'base64');
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, 12) }, bobKey, raw.subarray(12),
    ));
  }
  bob.ws.on('message', async (d) => {
    const m = JSON.parse(d.toString());
    bobFrames.push(m);
    if (m.type === 'contact_request') {
      const eph = await generateEphemeral(curveFromPubB64(m.ephPub));
      bobKey = await deriveChatKey(eph, m.ephPub);
      bob.json({
        type: 'contact_response', requestId: m.requestId, accept: true,
        publicKey: bobIdentity.publicB64, ephPub: eph.publicB64,
      });
    } else if (m.type === 'file_open') {
      bobTransfers.set(m.transferId, { parts: new Array(m.chunks).fill(null), got: 0, size: m.size, chunks: m.chunks });
    } else if (m.type === 'file_chunk' && bobKey) {
      const t = bobTransfers.get(m.transferId);
      if (!t || t.parts[m.index]) return;
      t.parts[m.index] = await decryptFrame(m.ciphertext);
      t.got += 1;
    }
  });
  const bobComplete = () => [...bobTransfers.values()].find((t) => t.got === t.chunks) || null;

  await import('../public/app.js');
  await delay(50);
  const myIdEl = dom.get('myId');
  dom.get('createBtn').onclick();
  await waitUntil(() => !!myIdEl.dataset.real, 'session', 9000);

  dom.get('searchInput').value = bob.id;
  dom.get('searchBtn').onclick();
  await waitUntil(() => findButton(dom.get('toasts'), 'Отправить запрос'), 'search result', 5000);
  findButton(dom.get('toasts'), 'Отправить запрос').onclick();
  await waitUntil(() => chatItems(dom).length === 1, 'chat established', 5000);

  // ---- 1) Alice -> Bob: pick a PNG, choose "no compression" ----------------
  const source = buildPng(220_000);
  const expected = stripMetadata(source); // what the client must actually send
  ok(expected.removed > 0, 'the fixture really contained metadata');
  ok(ascii(expected.bytes).includes('IEND') && !ascii(expected.bytes).includes('tEXt'),
    'the expected payload is already clean');

  dom.get('fileInput').files = [new File([source], 'passport-IVAN_PETROVICH.png', { type: 'image/png' })];
  dom.get('fileInput').onchange({ target: dom.get('fileInput') });
  await waitUntil(() => !!dialogButton('Без сжатия'), 'choice dialog', 5000);
  ok(!!dialogButton('Сжать'), 'the dialog offers "Сжать"');
  ok(!!dialogButton('Без сжатия'), 'the dialog offers "Без сжатия"');
  ok(dom.get('dialog').hidden === false, 'the dialog is open before anything is sent');
  dialogButton('Без сжатия').onclick();
  await delay(250);

  await waitUntil(() => !!bobComplete(), 'Bob reassembles the file', 8000);
  const received = concatParts(bobComplete().parts);
  ok(received.length === expected.bytes.length, `received ${received.length} B equals the cleaned file`);
  ok(sha256hex(received) === sha256hex(expected.bytes), 'the bytes Bob decrypted are exactly the cleaned file');
  ok(!ascii(received).includes('Ivan Petrovich'), 'the author string is gone from the delivered file');
  ok(!ascii(received).includes('tEXt'), 'no text chunk survived');

  // The wire must carry no file name, no MIME, nothing identifying the sender.
  const frames = bobFrames.filter((m) => m.type === 'file_open' || m.type === 'file_chunk');
  const wire = JSON.stringify(frames);
  const wireFields = [...new Set(frames.flatMap((m) => Object.keys(m)))];
  ok(!wire.includes('passport') && !wire.includes('IVAN'), 'no file name in any frame');
  ok(!wireFields.some((k) => /name|mime|file/i.test(k)), `frames carry no name/MIME field (${wireFields.join(',')})`);
  const open = bobFrames.find((m) => m.type === 'file_open');
  ok(open.chunks === Math.ceil(expected.bytes.length / 65536), `file_open declares ${open.chunks} 64 KB chunks`);
  ok(bobFrames.filter((m) => m.type === 'file_chunk').length === open.chunks, 'exactly that many chunk frames arrive');
  ok(typeof open.transferId === 'string' && open.transferId.length >= 6, 'the transfer id is opaque');

  // The sender's own bubble: a random label, a size, progress that reached 100 %.
  const bubbles = allByClass(dom.get('messages'), 'att');
  ok(bubbles.length === 1, 'the sender sees one attachment bubble');
  const bubbleText = textOf(bubbles[0]);
  ok(/файл-[a-z0-9]{6}\.png/.test(bubbleText), `the bubble shows a generated name (${bubbleText.slice(0, 24)})`);
  ok(!/passport|IVAN/i.test(bubbleText), 'and never the original name');
  const bar = allByClass(bubbles[0], 'att-bar')[0];
  ok(bar && bar.children[0].style.width === '100%', 'the progress bar reached 100 %');

  // ---- 2) Bob -> Alice: the receiver sees the file inside the chat ---------
  const inboundClean = stripMetadata(buildPng(70_000)).bytes;
  const tid = 'tx' + crypto.randomBytes(8).toString('hex').slice(0, 8);
  const chunks = Math.ceil(inboundClean.length / 65536);
  bob.json({ type: 'file_open', to: myIdEl.dataset.real, transferId: tid, size: inboundClean.length, chunks });
  for (let i = 0; i < chunks; i++) {
    const slice = inboundClean.subarray(i * 65536, Math.min(inboundClean.length, (i + 1) * 65536));
    const iv = crypto.randomBytes(12);
    const ct = Buffer.from(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, bobKey, slice));
    bob.json({
      type: 'file_chunk', to: myIdEl.dataset.real, transferId: tid, index: i,
      ciphertext: Buffer.concat([iv, ct]).toString('base64'),
    });
  }
  const wantHash = sha256hex(inboundClean);
  const aliceGotIt = async () => {
    for (const blob of dom.blobs.values()) {
      const b = new Uint8Array(await blob.arrayBuffer());
      if (b.length === inboundClean.length && sha256hex(b) === wantHash) return true;
    }
    return false;
  };
  await waitUntil(aliceGotIt, 'Alice received and decrypted the file', 8000);
  ok(await aliceGotIt(), 'Alice decrypted exactly what Bob sent');
  const allBubbles = allByClass(dom.get('messages'), 'att');
  ok(allBubbles.length === 2, 'the received attachment is shown inside the chat');
  ok(allByClass(allBubbles[1], 'att-img').length === 1, 'an image attachment is rendered as a preview');

  // ---- 3) Oversize is refused locally, before any frame leaves the device --
  const big = new Uint8Array(6 * 1024 * 1024);
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  dom.get('fileInput').files = [new File([big], 'huge.png', { type: 'image/png' })];
  dom.get('fileInput').onchange({ target: dom.get('fileInput') });
  await delay(250);
  ok(bobFrames.filter((m) => m.type === 'file_open').length === 1, 'a 6 MB file never opens a transfer');
  ok(allByClass(dom.get('messages'), 'att').length === 2, 'and no phantom bubble is added');
  ok(textOf(dom.get('toasts')).includes('5 МБ'), 'the user is told why');

  // ---- 4) A format that cannot be cleaned goes through the warning --------
  const gif = u8([...enc('GIF89a'), ...new Array(64).fill(7)]);
  dom.get('fileInput').files = [new File([gif], 'sketch.gif', { type: 'image/gif' })];
  dom.get('fileInput').onchange({ target: dom.get('fileInput') });
  await waitUntil(() => !!dialogButton('Отправить всё равно'), 'warning dialog', 5000);
  ok(textOf(dom.get('dialogTitle')).length > 0, 'the metadata warning has a title');
  dialogButton('Отмена').onclick();
  await delay(150);
  ok(bobFrames.filter((m) => m.type === 'file_open').length === 1, 'cancelling the warning sends nothing');

  // ---- 5) A transfer that never finishes is dropped with the chat ---------
  // Half-received chunks live in memory; ending the chat must free them without
  // throwing (this path used to crash on receiver.destroy()). The frames are
  // genuinely encrypted, otherwise the receiver would reject the transfer
  // instead of holding it open.
  const slowTid = 'tx' + crypto.randomBytes(8).toString('hex').slice(0, 8);
  const encFrame = async (n) => {
    const iv = crypto.randomBytes(12);
    const ct = Buffer.from(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) }, bobKey, new Uint8Array(n).fill(3),
    ));
    return Buffer.concat([iv, ct]).toString('base64');
  };
  bob.json({ type: 'file_open', to: myIdEl.dataset.real, transferId: slowTid, size: 300_000, chunks: 5 });
  for (let i = 0; i < 2; i++) {
    bob.json({ type: 'file_chunk', to: myIdEl.dataset.real, transferId: slowTid, index: i, ciphertext: await encFrame(65536) });
  }
  await delay(200);
  ok(allByClass(dom.get('messages'), 'att').length === 3, 'the partially received file is shown as in progress');
  bob.json({ type: 'end_chat', to: myIdEl.dataset.real });
  await delay(250);
  ok(chatItems(dom).length === 0, 'the chat is gone');
  ok(dom.get('messages').children.length === 0, 'and its attachment bubbles left the DOM');
  ok(dom.blobs.size === 0, 'every blob URL was revoked, nothing is held in memory');

  console.log('');
  const failed = summary();
  bob.ws.close(); server.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nTEST CRASHED:', e); process.exit(1); });
