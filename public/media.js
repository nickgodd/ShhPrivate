// public/media.js — attachment hygiene: sniff the real format, delete metadata,
// optionally re-encode. Runs entirely in the browser, BEFORE encryption, so the
// file name, the modification date and every metadata block never reach the wire.
//
// stripMetadata() is deliberately pure byte work over Uint8Array (no canvas, no
// DOM): that keeps it unit-testable in Node and keeps the "Без сжатия" path
// pixel-identical to the original image. compressImage() is the only function
// here that touches canvas, and it is used solely for the "Сжать" path.

const PNG_DROP = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME', 'sCAL']);
// JPEG: everything private lives in APPn + COM. What we keep is rendering data,
// not personal data: APP0 (JFIF density), APP2 ICC_PROFILE (colour), APP14 Adobe
// (colour transform). Dropping the latter two shifts the picture's colours.
const JPEG_KEEP_APP = new Set([0xe0, 0xee]);

// ---- Format sniffing (by content, never by file name) ---------------------
export function sniffFormat(bytes) {
  if (!bytes || bytes.length < 12) return unknown();
  const ascii = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { format: 'jpeg', mime: 'image/jpeg', cleanable: true, ext: 'jpg' };
  }
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a) {
    return { format: 'png', mime: 'image/png', cleanable: true, ext: 'png' };
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    return { format: 'webp', mime: 'image/webp', cleanable: true, ext: 'webp' };
  }
  if (ascii(0, 3) === 'GIF') return { format: 'gif', mime: 'image/gif', cleanable: false, ext: 'gif' };
  if (ascii(0, 2) === 'BM') return { format: 'bmp', mime: 'image/bmp', cleanable: false, ext: 'bmp' };
  if (ascii(4, 4) === 'ftyp' && /heic|heix|heim|hevc|hevx|heis|mif1|msf1/.test(ascii(8, 4))) {
    return { format: 'heic', mime: 'image/heic', cleanable: false, ext: 'heic' };
  }
  return unknown();
}
function unknown() {
  return { format: 'bin', mime: 'application/octet-stream', cleanable: false, ext: 'bin' };
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function tagOf(bytes, at, n) {
  return String.fromCharCode(...bytes.subarray(at, at + n));
}

// ---- JPEG -----------------------------------------------------------------
// Walk the marker chain, copy what we keep, throw away EXIF/GPS/IPTC/XMP/COM.
// Returns { bytes, orientation, gps, removed } — if orientation > 1 the caller
// must bake the rotation into the pixels, because the flag itself is deleted.
function stripJpeg(bytes) {
  const out = [bytes.subarray(0, 2)]; // SOI
  let i = 2;
  let orientation = 1;
  let gps = false;
  let removed = 0;

  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    let m = bytes[i + 1];
    while (m === 0xff && i + 1 < bytes.length) { i++; m = bytes[i + 1]; } // skip fill
    const markerAt = i;
    i += 2;

    if (m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) continue; // standalone
    if (m === 0xd9) { out.push(bytes.subarray(markerAt, i)); break; } // EOI ends the stream

    const len = (bytes[i] << 8) | bytes[i + 1];
    if (len < 2 || i + len > bytes.length) break; // truncated: drop the remainder
    const seg = bytes.subarray(i, i + len); // payload including the 2 length bytes

    if (m === 0xda) {
      // SOS: the header and the entropy-coded scan that follows are the image.
      out.push(bytes.subarray(markerAt, i + len));
      i += len;
      const end = findScanEnd(bytes, i);
      out.push(bytes.subarray(i, end));
      i = end;
      continue;
    }

    const icc = m === 0xe2 && seg.length >= 15 && tagOf(seg, 2, 11) === 'ICC_PROFILE';
    if ((m >= 0xe1 && m <= 0xef && !JPEG_KEEP_APP.has(m) && !icc) || m === 0xfe) {
      if (m === 0xe1) {
        const exif = readExif(seg);
        if (exif) { orientation = exif.orientation; gps = gps || exif.gps; }
      }
      removed++;
      i += len;
      continue;
    }
    out.push(bytes.subarray(markerAt, i + len));
    i += len;
  }

  return { bytes: removed ? concat(out) : bytes, orientation, gps, removed };
}

// Entropy-coded data runs until the next real marker. 0xFF 0x00 is a stuffed
// byte, 0xFF 0xFF is fill, and 0xD0..0xD7 are restart markers — all of them are
// part of the scan and must be copied, not treated as the end of it.
function findScanEnd(bytes, from) {
  for (let i = from; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 0xff) continue;
    const m = bytes[i + 1];
    if (m === 0x00 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) continue;
    return i;
  }
  return bytes.length;
}

// Minimal EXIF reader — only the two things that matter here: the orientation
// flag (must be honoured) and whether GPS data is present (must be reported).
// `t` is where the TIFF header starts and `end` where the block stops, so the
// same parser serves a JPEG APP1 segment (after the "Exif\0\0" prefix) and a
// WebP EXIF chunk (raw TIFF) without reading past the block it was given.
function parseTiff(seg, t, end = seg.length) {
  if (t + 8 > end) return null;
  const little = seg[t] === 0x49 && seg[t + 1] === 0x49;
  const big = seg[t] === 0x4d && seg[t + 1] === 0x4d;
  if (!little && !big) return null;
  const rd16 = (o) => (little ? (seg[o] | (seg[o + 1] << 8)) : ((seg[o] << 8) | seg[o + 1])) >>> 0;
  const rd32 = (o) => (little
    ? ((seg[o] | (seg[o + 1] << 8) | (seg[o + 2] << 16) | (seg[o + 3] << 24)))
    : ((seg[o + 3] | (seg[o + 2] << 8) | (seg[o + 1] << 16) | (seg[o] << 24)))) >>> 0;

  const ifd = t + rd32(t + 4);
  if (ifd + 2 > end || ifd < t) return null;
  const count = rd16(ifd);
  let orientation = 1;
  let gps = false;
  for (let e = 0; e < count; e++) {
    const entry = ifd + 2 + e * 12;
    if (entry + 12 > end) break;
    const tag = rd16(entry);
    if (tag === 0x0112) orientation = rd16(entry + 8) || 1;
    if (tag === 0x8825) gps = true; // GPSInfo sub-IFD
  }
  // Writers differ in where they put coordinates; the byte scan is a safety net
  // for a block we are about to delete anyway.
  if (!gps) {
    for (let o = t; o + 4 <= end; o++) {
      if (seg[o] === 0x47 && seg[o + 1] === 0x50 && seg[o + 2] === 0x53 && seg[o + 3] === 0x49) { gps = true; break; }
    }
  }
  return { orientation, gps };
}

function readExif(seg) {
  if (seg.length < 20 || tagOf(seg, 2, 4) !== 'Exif') return null; // also covers XMP-in-APP1
  return parseTiff(seg, 8);
}

// ---- PNG ------------------------------------------------------------------
function stripPng(bytes) {
  const out = [bytes.subarray(0, 8)]; // signature
  let i = 8;
  let removed = 0;
  while (i + 8 <= bytes.length) {
    const len = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    const type = tagOf(bytes, i + 4, 4);
    const total = 12 + len; // length(4) + type(4) + data + crc(4)
    if (i + total > bytes.length) break;
    if (PNG_DROP.has(type)) { removed++; i += total; continue; }
    out.push(bytes.subarray(i, i + total));
    i += total;
    if (type === 'IEND') break;
  }
  return { bytes: removed ? concat(out) : bytes, removed, orientation: 1, gps: false };
}

// ---- WebP -----------------------------------------------------------------
function stripWebp(bytes) {
  const out = [bytes.subarray(0, 12)]; // 'RIFF' size 'WEBP' — size patched at the end
  let i = 12;
  let removed = 0;
  let orientation = 1;
  let gps = false;
  while (i + 8 <= bytes.length) {
    const fourcc = tagOf(bytes, i, 4);
    const size = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
    const padded = size + (size & 1); // RIFF chunks are 2-byte aligned
    if (i + 8 + padded > bytes.length) break;
    if (fourcc === 'EXIF' || fourcc === 'XMP ') {
      // A WebP EXIF chunk is raw TIFF: read the orientation before deleting it,
      // otherwise a rotated photo would silently arrive sideways.
      if (fourcc === 'EXIF') {
        const exif = parseTiff(bytes, i + 8, i + 8 + size);
        if (exif) { orientation = exif.orientation; gps = gps || exif.gps; }
      }
      removed++;
      i += 8 + padded;
      continue;
    }
    let chunk = bytes.subarray(i, i + 8 + padded);
    if (fourcc === 'VP8X') {
      // Clear the EXIF (0x08) and XMP (0x04) flag bits, otherwise a decoder keeps
      // looking for chunks that are gone. libwebp also uses ICCP 0x20, Alpha 0x10,
      // Anim 0x02 — those stay.
      const copy = Uint8Array.from(chunk);
      copy[8] &= ~(0x08 | 0x04);
      chunk = copy;
    }
    out.push(chunk);
    i += 8 + padded;
  }
  if (!removed) return { bytes, removed: 0, orientation: 1, gps: false };
  const result = concat(out);
  const total = result.length - 8;
  result[4] = total & 0xff;
  result[5] = (total >>> 8) & 0xff;
  result[6] = (total >>> 16) & 0xff;
  result[7] = (total >>> 24) & 0xff;
  return { bytes: result, removed, orientation, gps };
}

// ---- Public entry point ---------------------------------------------------
// `cleaned: false` marks formats where metadata is entangled with the payload or
// simply not safely removable (GIF, BMP, HEIC, documents): those must go through
// the explicit warning path instead.
export function stripMetadata(bytes) {
  const info = sniffFormat(bytes);
  if (!info.cleanable) return { ...info, bytes, orientation: 1, removed: 0, cleaned: false };
  const r = info.format === 'jpeg' ? stripJpeg(bytes)
    : info.format === 'png' ? stripPng(bytes)
      : stripWebp(bytes);
  return { ...info, bytes: r.bytes, orientation: r.orientation || 1, removed: r.removed, cleaned: true };
}

export const MAX_SIDE = 1600;
export const QUALITY = 0.8;

// "Сжать": cap the long edge at MAX_SIDE px and re-encode (quality ~0.8) via
// canvas. EXIF is already gone, so the orientation flag is applied by hand here;
// canvas output carries no metadata, and we strip it again rather than trust it.
export async function compressImage(bytes, mime, {
  maxSide = MAX_SIDE, quality = QUALITY, orientation = 1,
} = {}) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  const swap = orientation >= 5;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const sw = Math.max(1, Math.round(bitmap.width * scale));
  const sh = Math.max(1, Math.round(bitmap.height * scale));
  const w = swap ? sh : sw;
  const h = swap ? sw : sh;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx.imageSmoothingQuality !== undefined) ctx.imageSmoothingQuality = 'high';
  applyOrientation(ctx, orientation, w, h);
  ctx.drawImage(bitmap, 0, 0, sw, sh);
  bitmap.close?.();

  const outMime = mime === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((res) => canvas.toBlob(res, outMime, quality));
  if (!blob) throw new Error('encode_failed');
  const encoded = new Uint8Array(await blob.arrayBuffer());
  const again = stripMetadata(encoded);
  return { bytes: again.bytes, mime: outMime, width: w, height: h };
}

// Canvas transform for each EXIF orientation value (1..8).
function applyOrientation(ctx, orientation, w, h) {
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, w, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, w, h); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, h); break;
    default: break; // 1 or unknown: nothing to do
  }
}

// Display-only label for the sender's own bubble. The real name never leaves the
// device and the receiver re-derives the type from the decrypted bytes.
export function randomLabel(mime) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const r = new Uint8Array(6);
  globalThis.crypto.getRandomValues(r);
  let s = '';
  for (const b of r) s += alphabet[b % alphabet.length];
  return `файл-${s}.${extOf(mime)}`;
}
function extOf(mime) {
  return ({
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/heic': 'heic', 'image/bmp': 'bmp',
  })[mime] || 'bin';
}

export function humanSize(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1)} МБ`;
}
