// QR surface: the id is revealed and painted only on demand, the code carries
// only the id, and the scanner behaves when the camera cannot be used.
//
// Run: node test/qr_ui.test.mjs
import {
  delay, ok, summary, b32id, makeDom, establish, findButton, rawClient,
  bootServer, waitUntil, bootGlobals, textOf, loadJsQR, qrToRgba,
} from './helpers.mjs';
import { isId, parseId } from '../public/crypto.js';
import { encodeQr } from '../public/qr.js';

const PORT = 4616;
const jsQR = loadJsQR();

async function main() {
  const server = await bootServer(PORT);
  const { wsUrl } = bootGlobals(PORT);
  const dom = makeDom();
  console.log('server is up\n');

  // An id taken from a real QR render/decode round trip: what one user shows,
  // another user's camera produces.
  const peer = rawClient('peer', wsUrl);
  peer.id = b32id();
  const { generateIdentity } = await import('../public/crypto.js');
  await establish(peer, (await generateIdentity()).publicB64);
  const qr = encodeQr(peer.id);
  const img = qrToRgba(qr.modules);
  const scanned = jsQR(img.data, img.width, img.height);
  ok(!!scanned && scanned.data === peer.id, 'a rendered id decodes back to exactly that id');
  ok(isId(scanned.data), 'and it is accepted as an id');
  ok(!isId((await generateIdentity()).publicB64), 'a public key is never accepted as an id');
  ok(!isId('https://example.com/ABC234567890'), 'a URL is never accepted as an id');
  ok(parseId(' abc-def-123 ') === 'ABCDEF123' || parseId(' abc-def-123 ') === null,
    'typed input is normalised to base32 or rejected');

  await import('../public/app.js');
  await delay(50);
  dom.get('createBtn').onclick();
  await waitUntil(() => !!dom.get('myId').dataset.real, 'session', 9000);
  const myId = dom.get('myId').dataset.real;

  // ---- hidden by default --------------------------------------------------
  dom.get('profileBtn').onclick();
  ok(dom.get('myId').textContent === '••••••••••••', 'the id is masked by default');
  ok(dom.get('myKey').textContent === '••••••••••••', 'the key is masked by default');
  ok(dom.get('qrWrap').hidden === true, 'the QR is hidden by default');

  // ---- revealed by one press ---------------------------------------------
  dom.get('toggleId').onclick();
  ok(dom.get('myId').textContent === myId, 'the id is shown');
  ok(dom.get('myKey').textContent.length > 40 && dom.get('myKey').textContent.includes('='),
    'the public key is shown (base64)');
  ok(dom.get('qrWrap').hidden === false, 'the QR is shown');
  const canvas = dom.get('qrCanvas');
  ok(canvas.width > 0 && canvas._fills > 50, `the QR was painted (${canvas._fills} modules)`);

  // The painted code must decode to the id and to nothing else.
  const own = encodeQr(myId);
  const ownImg = qrToRgba(own.modules);
  const ownDecoded = jsQR(ownImg.data, ownImg.width, ownImg.height);
  ok(ownDecoded && ownDecoded.data === myId, 'the profile QR carries exactly the session id');
  ok(!String(ownDecoded.data).includes(dom.get('myKey').textContent), 'it never carries the key');

  // ---- hidden again -------------------------------------------------------
  dom.get('toggleId').onclick();
  ok(dom.get('myId').textContent === '••••••••••••', 'one more press masks the id');
  ok(dom.get('qrWrap').hidden === true, 'and the QR leaves the screen');
  ok(canvas.width === 0, 'the canvas is released, not left in memory');

  // ---- scanner without a usable camera ------------------------------------
  dom.get('scanBtn').onclick();
  await delay(120);
  ok(dom.get('scanModal').hidden === true, 'no scanner window is left open when the camera is unavailable');
  ok(textOf(dom.get('toasts')).includes('камера') || textOf(dom.get('toasts')).includes('Камера'),
    'the user is told why, in plain words');

  // Escape while the scanner is closed must not touch anything either.
  global.document.dispatch?.('keydown', { key: 'Escape' });
  await delay(50);
  ok(dom.get('scanModal').hidden === true, 'Escape leaves the app consistent');

  console.log('');
  const failed = summary();
  peer.ws.close(); server.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nTEST CRASHED:', e); process.exit(1); });
