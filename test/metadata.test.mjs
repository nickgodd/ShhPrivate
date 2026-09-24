// Metadata removal, verified on synthetic files whose metadata blocks are built
// byte by byte. This is the "в результате нет EXIF/GPS" autotest, and it runs in
// pure Node: stripMetadata() never touches canvas, so the same code path that
// ships to the browser is what gets asserted here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripMetadata, sniffFormat, randomLabel, humanSize, MAX_SIDE, QUALITY } from '../public/media.js';

const enc = (s) => Array.from(new TextEncoder().encode(s));
const u8 = (arr) => Uint8Array.from(arr);
const asciiOf = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};
// A JPEG segment: marker + 2-byte length (including itself) + payload.
const jseg = (marker, payload = []) => u8([0xff, marker, (payload.length + 2) >> 8 & 0xff, (payload.length + 2) & 0xff, ...payload]);

// little-endian EXIF APP1 with an orientation tag and a GPSInfo pointer
function exifSegment(orientation = 6, withGps = true) {
  const entries = [];
  const entry = (tag, type, value) => [
    tag & 0xff, tag >> 8, type & 0xff, type >> 8,
    1, 0, 0, 0, value & 0xff, value >> 8 & 0xff, 0, 0,
  ];
  entries.push(...entry(0x010f, 2, 0)); // Make (string pointer, unused here)
  entries.push(...entry(0x0112, 3, orientation)); // Orientation
  if (withGps) entries.push(...entry(0x8825, 4, 0x100)); // GPSInfo sub-IFD
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II, magic, IFD0 at 8
    entries.length / 12 & 0xff, (entries.length / 12) >> 8 & 0xff, ...entries, 0, 0, 0, 0,
    ...enc('GPSLatitude 55.7558'), ...enc('Nikon D850 body serial 0123456'),
  ];
  return jseg(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]); // "Exif\0\0"
}
const xmpSegment = () => jseg(0xe1, [...enc('http://ns.adobe.com/xap/1.0/\x00'), ...enc('<x:xmpmeta><rdf:Description dc:creator="Ivan Petrov"/></x:xmpmeta>')]);
const iptcSegment = () => jseg(0xed, [...enc('Photoshop 3.0\x00'), ...enc('\x1d\x02\x80Ivan Petrov')]); // APP13
const commentSegment = () => jseg(0xfe, enc('taken at home'));
const jfifSegment = () => jseg(0xe0, [...enc('JFIF\x00'), 1, 1, 0, 0x01, 0x2c, 0x2c, 0, 0]);
const iccSegment = () => jseg(0xe2, [...enc('ICC_PROFILE\x00'), 1, 1, 0xde, 0xad, 0xbe, 0xef]);
const adobeSegment = () => jseg(0xee, [0x41, 0x70, 0x70, 0x6c, 0x00, 0x42, 0x00, 0xff, 0xfb, 0x00]);
const dqtSegment = () => jseg(0xdb, [0x00, ...new Array(64).fill(0x08)]);
const sofSegment = () => jseg(0xc0, [8, 0x01, 0x2c, 0x01, 0x90, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
const dhtSegment = () => jseg(0xc4, [0x00, ...new Array(16).fill(1), ...new Array(12).fill(0)]);
const sosSegment = () => jseg(0xda, [12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
const SCAN = u8([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a, 0xbc]); // includes a stuffed 0xFF 0x00
const JPEG_IMAGE = () => u8([
  0xff, 0xd8,
  ...jfifSegment(), ...iccSegment(), ...adobeSegment(),
  ...dqtSegment(), ...sofSegment(), ...dhtSegment(), ...sosSegment(),
  ...SCAN, 0xff, 0xd9,
]);
function jpegWithMetadata() {
  const clean = JPEG_IMAGE();
  const head = clean.subarray(0, 2);
  const rest = clean.subarray(2);
  const meta = u8([...exifSegment(6), ...xmpSegment(), ...iptcSegment(), ...commentSegment()]);
  return u8([...head, ...meta, ...rest]);
}

function buildPng(extra = {}) {
  const chunk = (type, data) => {
    const len = data.length;
    return u8([len >> 24 & 255, len >> 16 & 255, len >> 8 & 255, len & 255, ...enc(type), ...data, 0, 0, 0, 0]);
  };
  const idat = chunk('IDAT', [1, 2, 3, 4, 5]);
  return u8([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', new Array(13).fill(7)),
    ...(extra.text ? chunk('tEXt', [...enc('Comment\0'), ...enc('created by Ivan')]) : []),
    ...(extra.itxt ? chunk('iTXt', [...enc('CCO\0\0\0'), ...enc('Иван Иванов')]) : []),
    ...(extra.ztxt ? chunk('zTXt', [...enc('Description\0'), 0, 1, 2, 3]) : []),
    ...(extra.exif ? chunk('eXIf', exifBody()) : []),
    ...(extra.time ? chunk('tIME', [7, 0xe9, 9, 25, 12, 0, 0]) : []),
    ...(extra.cal ? chunk('sCAL', [...enc('metric\x001 2')]) : []),
    ...idat,
    ...chunk('IEND', []),
  ]);
}
function exifBody(orientation = 8) {
  // A compact LE IFD with an orientation and a GPSInfo pointer (PNG/WebP style,
  // i.e. raw TIFF with no "Exif\0\0" prefix).
  const entry = (tag, type, value) => [tag & 255, tag >> 8, type & 255, type >> 8, 1, 0, 0, 0, value & 255, value >> 8 & 255, 0, 0];
  return u8([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 2, 0, ...entry(0x0112, 3, orientation), ...entry(0x8825, 4, 0x40), 0, 0, 0, 0]);
}

function buildWebp({ orientation = 1 } = {}) {
  const chunk = (fourcc, payload) => {
    const pad = payload.length & 1 ? [0] : [];
    return u8([...enc(fourcc), payload.length & 255, payload.length >> 8 & 255, payload.length >> 16 & 255, payload.length >> 24 & 255, ...payload, ...pad]);
  };
  // VP8X flags: ICCP 0x20 | Alpha 0x10 | EXIF 0x08 | XMP 0x04
  const vp8x = chunk('VP8X', [0x20 | 0x10 | 0x08 | 0x04, 0, 0, 0, 0xff, 0x03, 0x00, 0xff, 0x03, 0x00]);
  const iccp = chunk('ICCP', [1, 2, 3]);
  const exif = chunk('EXIF', [...exifBody(orientation), ...enc('GPSInfo')]);
  const xmp = chunk('XMP ', [...enc('<x:xmpmeta>author</x:xmpmeta>')]);
  const vp8 = chunk('VP8 ', [0x30, 1, 2, 3, 4]); // odd length -> exercises padding
  const body = u8([...vp8x, ...iccp, ...exif, ...xmp, ...vp8]);
  const total = body.length + 4;
  return u8([...enc('RIFF'), total & 255, total >> 8 & 255, total >> 16 & 255, total >> 24 & 255, ...enc('WEBP'), ...body]);
}

test('JPEG: EXIF, XMP, IPTC and comments are gone, pixels untouched', () => {
  const src = jpegWithMetadata();
  const out = stripMetadata(src);
  assert.equal(out.cleaned, true);
  assert.equal(out.format, 'jpeg');
  assert.ok(out.removed >= 4, `removed ${out.removed} segments`);
  const s = asciiOf(out.bytes);
  assert.ok(!s.includes('Exif'), 'EXIF block deleted');
  assert.ok(!s.includes('http://ns.adobe.com/xap'), 'XMP deleted');
  assert.ok(!s.includes('Photoshop'), 'IPTC/APP13 deleted');
  assert.ok(!s.includes('taken at home'), 'comment deleted');
  assert.ok(!/GPS|55\.7558|Nikon|Ivan/.test(s), 'no GPS / device / author strings survive');
  // The scan data and every structural segment must be byte-identical.
  const clean = JPEG_IMAGE();
  const kept = asciiOf(out.bytes);
  assert.ok(kept.includes(asciiOf(jfifSegment().subarray(4))), 'JFIF kept');
  assert.ok(kept.includes(asciiOf(iccSegment().subarray(4))), 'ICC profile kept');
  assert.ok(kept.includes(asciiOf(adobeSegment().subarray(4))), 'Adobe transform kept');
  assert.ok(kept.includes(asciiOf(sosSegment().subarray(4))), 'SOS kept');
  assert.ok(kept.includes(asciiOf(SCAN)), 'entropy-coded scan kept verbatim');
  assert.equal(out.bytes[0], 0xff);
  assert.equal(out.bytes[1], 0xd8);
  assert.equal(out.bytes[out.bytes.length - 2], 0xff);
  assert.equal(out.bytes[out.bytes.length - 1], 0xd9, 'ends at EOI');
});

test('JPEG: the orientation flag is reported before it is deleted', () => {
  const out = stripMetadata(jpegWithMetadata());
  assert.equal(out.orientation, 6, 'caller must bake the rotation in');
  const upright = stripMetadata(u8([0xff, 0xd8, ...jfifSegment(), ...exifSegment(1), ...JPEG_IMAGE().subarray(2)]));
  assert.equal(upright.orientation, 1);
});

test('JPEG without metadata is returned unchanged', () => {
  const clean = JPEG_IMAGE();
  const out = stripMetadata(clean);
  assert.equal(out.removed, 0);
  assert.equal(asciiOf(out.bytes), asciiOf(clean));
});

test('PNG: tEXt, iTXt, zTXt, eXIf, tIME (and sCAL) are dropped, IHDR/IDAT/IEND kept', () => {
  const src = buildPng({ text: true, itxt: true, ztxt: true, exif: true, time: true, cal: true });
  const out = stripMetadata(src);
  assert.equal(out.cleaned, true);
  const s = asciiOf(out.bytes);
  for (const bad of ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME', 'sCAL', 'Ivan', 'GPS']) {
    assert.ok(!s.includes(bad), `${bad} removed`);
  }
  assert.ok(s.includes('IHDR') && s.includes('IDAT') && s.includes('IEND'), 'structural chunks intact');
  assert.equal(out.bytes[0] & 0x89, 0x89);
  // A PNG with no text chunks must come back identical.
  const plain = buildPng({});
  assert.equal(asciiOf(stripMetadata(plain).bytes), asciiOf(plain));
});

test('WebP: EXIF and XMP chunks removed, VP8X flags cleared, RIFF size patched', () => {
  const src = buildWebp();
  const out = stripMetadata(src);
  assert.equal(out.cleaned, true);
  const s = asciiOf(out.bytes);
  assert.ok(!s.includes('<x:xmpmeta>'), 'XMP gone');
  assert.ok(!s.includes('GPSInfo') && !s.includes('EXIF'), 'no EXIF fourcc or GPS string left');
  assert.ok(!s.includes('XMP '), 'no XMP fourcc left');
  assert.ok(s.includes('VP8X') && s.includes('ICCP') && s.includes('VP8 '), 'canvas/colour/image data untouched');
  assert.equal(asciiOf(out.bytes.subarray(0, 4)), 'RIFF');
  assert.equal(asciiOf(out.bytes.subarray(8, 12)), 'WEBP');
  const riffSize = out.bytes[4] | (out.bytes[5] << 8) | (out.bytes[6] << 16) | (out.bytes[7] << 24);
  assert.equal(riffSize, out.bytes.length - 8, 'RIFF length matches');
  // The VP8X flag byte must no longer advertise EXIF (0x08) / XMP (0x04), but must
  // still advertise ICC (0x20) and Alpha (0x10).
  const flags = out.bytes[12 + 8];
  assert.equal(flags & 0x08, 0, 'EXIF flag cleared');
  assert.equal(flags & 0x04, 0, 'XMP flag cleared');
  assert.ok(flags & 0x20, 'ICC flag preserved');
  assert.ok(flags & 0x10, 'alpha flag preserved');
});

test('WebP: an EXIF orientation flag is honoured before the chunk is deleted', () => {
  const out = stripMetadata(buildWebp({ orientation: 6 }));
  assert.equal(out.orientation, 6, 'the caller must bake the rotation in, as with JPEG');
  assert.ok(!asciiOf(out.bytes).includes('EXIF'), 'the EXIF chunk itself is gone');
  const plain = stripMetadata(buildWebp({ orientation: 1 }));
  assert.equal(plain.orientation, 1);
});

test('formats that cannot be cleaned reliably are flagged, not silently passed as clean', () => {
  const gif = u8([...enc('GIF89a'), ...new Array(7).fill(1)]);
  const bmp = u8([...enc('BM'), ...new Array(12).fill(0)]);
  const heic = u8([0, 0, 0, 0x18, ...enc('ftyp'), ...enc('heic'), 0, 0, 0, 0, ...enc('mif1')]);
  const pdf = u8([...enc('%PDF-1.7\n')]);
  for (const bytes of [gif, bmp, heic, pdf]) {
    const out = stripMetadata(bytes);
    assert.equal(out.cleaned, false, `${sniffFormat(bytes).format} is not cleanable`);
    assert.equal(asciiOf(out.bytes), asciiOf(bytes), 'bytes pass through untouched for the warning path');
  }
});

test('MIME comes from the content, never from the file name', () => {
  assert.equal(sniffFormat(jpegWithMetadata()).mime, 'image/jpeg');
  assert.equal(sniffFormat(buildPng({ text: true })).mime, 'image/png');
  assert.equal(sniffFormat(buildWebp()).mime, 'image/webp');
  assert.equal(sniffFormat(u8([...enc('GIF89a'), ...new Array(8).fill(0)])).mime, 'image/gif');
  assert.equal(sniffFormat(u8([...enc('BM'), ...new Array(12).fill(0)])).mime, 'image/bmp');
  assert.equal(sniffFormat(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])).cleanable, false);
});

test('no original file name can leak through the label', () => {
  const a = randomLabel('image/jpeg');
  const b = randomLabel('image/jpeg');
  assert.match(a, /^файл-[a-z0-9]{6}\.jpg$/);
  assert.notEqual(a, b, 'labels are random per attachment');
  assert.ok(!/passport|IMG_2026|ivan/i.test(a));
});

test('compression defaults match the spec: 1600 px long edge, quality 0.8', () => {
  assert.equal(MAX_SIDE, 1600);
  assert.equal(QUALITY, 0.8);
});

test('humanSize is display-only and never leaks the real name', () => {
  assert.equal(humanSize(512), '512 Б');
  assert.equal(humanSize(64 * 1024), '64 КБ');
  assert.equal(humanSize(5 * 1024 * 1024), '5.0 МБ');
});
