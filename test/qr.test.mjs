// QR code: the encoder must produce a scannable code that contains ONLY the
// session id. Verified with the vendored jsQR build acting as an independent
// decoder, so this is a real end-to-end check, not a self-consistency test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr } from '../public/qr.js';
import { loadJsQR, qrToRgba, b32id } from './helpers.mjs';

const jsQR = loadJsQR();

function roundTrip(text) {
  const qr = encodeQr(text);
  const img = qrToRgba(qr.modules);
  const code = jsQR(img.data, img.width, img.height);
  assert.ok(code, `jsQR could not decode ${JSON.stringify(text)} (v${qr.version})`);
  return code.data;
}

test('a 12-char session id survives a real QR decode', () => {
  for (let i = 0; i < 8; i++) {
    const id = b32id(12);
    assert.equal(roundTrip(id), id, `id ${id}`);
  }
});

test('a 16-char id (the longest the server accepts) decodes too', () => {
  for (let i = 0; i < 4; i++) {
    const id = b32id(16);
    assert.equal(roundTrip(id), id);
  }
});

test('the payload is the bare id: no key material, no prefixes', () => {
  const id = b32id(12);
  const qr = encodeQr(id);
  const decoded = roundTrip(id);
  assert.equal(decoded, id);
  assert.equal(decoded.length, id.length);
  assert.doesNotMatch(decoded, /=|publicKey|shh:/, 'nothing but the id is encoded');
  // Version 1-4 only: an id must never push the matrix beyond 33x33 modules.
  assert.ok(qr.size <= 33, `matrix size ${qr.size}`);
});

test('every QR is structurally valid: finders, timing, dark module', () => {
  const { modules, size } = encodeQr(b32id(12));
  assert.equal(modules[3][3], true, 'finder centre top-left');
  assert.equal(modules[size - 4][3], true, 'finder centre bottom-left');
  assert.equal(modules[size - 8][8], true, 'dark module at (8, size-8)');
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0, `timing row at ${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `timing col at ${i}`);
  }
});
