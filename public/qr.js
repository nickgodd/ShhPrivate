// public/qr.js — self-contained QR encoder: no dependencies, no network, no
// fonts. It supports byte mode, error-correction level M, versions 1..4, which
// covers a 12–16 character session ID with room to spare (~4 KB of code instead
// of a library). Structure follows the ISO 18004 layout rules.
//
// IMPORTANT: this encodes the ID only. Keys are never put into a QR code.

const MODE_BYTE = 0b0100;
const EC_LEVEL_M_BITS = 0b00; // format bits for level M

// version -> blocks of [count, dataCodewordsPerBlock, ecCodewordsPerBlock]
const VERSIONS = {
  1: [[1, 16, 10]],
  2: [[1, 28, 16]],
  3: [[1, 44, 26]],
  4: [[2, 32, 18]],
};
// Alignment-pattern centres; version 1 has none.
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26] };
const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7 };

// ---- GF(256) arithmetic (primitive polynomial 0x11D), tables built at load --
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = mul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = mul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= mul(divisor[i], factor);
  }
  return result;
}

// ---- Codeword construction -------------------------------------------------
function pickVersion(byteLen) {
  for (const v of [1, 2, 3, 4]) {
    const capacity = VERSIONS[v].reduce((s, [c, d]) => s + c * d, 0);
    if (byteLen + 2 <= capacity) return v; // +2 ≈ mode/count + terminator
  }
  throw new Error('qr_too_long');
}

function buildCodewords(bytes) {
  const version = pickVersion(bytes.length);
  const blocks = VERSIONS[version];
  const dataCapacity = blocks.reduce((s, [c, d]) => s + c * d, 0);
  const capacityBits = dataCapacity * 8;

  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(MODE_BYTE, 4);
  push(bytes.length, 8); // byte mode, versions 1..9 -> 8-bit count
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  push(0, (8 - (bits.length % 8)) % 8); // byte align
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);

  const data = new Uint8Array(bits.length / 8);
  bits.forEach((bit, i) => { data[i >>> 3] |= bit << (7 - (i & 7)); });

  // Split into blocks, add a Reed-Solomon remainder to each, then interleave.
  const dataBlocks = [];
  const ecBlocks = [];
  let off = 0;
  for (const [count, dLen, eLen] of blocks) {
    for (let k = 0; k < count; k++) {
      const chunk = data.subarray(off, off + dLen);
      off += dLen;
      dataBlocks.push(chunk);
      ecBlocks.push(rsRemainder(chunk, rsDivisor(eLen)));
    }
  }
  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  const maxEc = Math.max(...ecBlocks.map((b) => b.length));
  for (let i = 0; i < maxEc; i++) for (const b of ecBlocks) if (i < b.length) out.push(b[i]);
  return { codewords: Uint8Array.from(out), version };
}

// ---- Matrix construction ---------------------------------------------------
function newMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  return { size, modules, isFunction, version };
}

function set(m, x, y, v, fn = true) {
  if (x < 0 || y < 0 || x >= m.size || y >= m.size) return;
  m.modules[y][x] = !!v;
  if (fn) m.isFunction[y][x] = true;
}

function drawFinders(m) {
  // Timing patterns first: the finder patterns below overwrite the parts of rows
  // 0..7 / cols 0..7 that they sit on, exactly as ISO 18004 draws them.
  for (let i = 0; i < m.size; i++) {
    set(m, 6, i, i % 2 === 0);
    set(m, i, 6, i % 2 === 0);
  }
  const pts = [[3, 3], [m.size - 4, 3], [3, m.size - 4]];
  for (const [x, y] of pts) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(m, x + dx, y + dy, dist !== 2 && dist !== 4);
      }
    }
  }
  // Dark module (always set, part of the format information).
  set(m, 8, m.size - 8, true);
}

function drawAlignments(m) {
  const pos = ALIGN[m.version];
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const x = pos[i];
      const y = pos[j];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(m, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
}

function reserveFormatArea(m) {
  // Mark the format-information cells as function modules so the data placement
  // and the mask skip them. Values are written later by drawFormatBits; the two
  // cells of the timing pattern that sit inside this area, (6,8) and (8,6), keep
  // the timing value they were already given.
  const reserve = (x, y) => {
    if (x < 0 || y < 0 || x >= m.size || y >= m.size) return;
    m.isFunction[y][x] = true;
    if (x !== 6 && y !== 6) m.modules[y][x] = false;
  };
  for (let i = 0; i <= 8; i++) { reserve(8, i); reserve(i, 8); }
  for (let i = 0; i < 8; i++) { reserve(8, m.size - 1 - i); reserve(m.size - 1 - i, 8); }
  reserve(8, m.size - 8);
}

function drawFormatBits(m, mask) {
  const data = (EC_LEVEL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) !== 0;

  for (let i = 0; i <= 5; i++) set(m, 8, i, bit(i));
  set(m, 8, 7, bit(6));
  set(m, 8, 8, bit(7));
  set(m, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(m, 14 - i, 8, bit(i));

  for (let i = 0; i < 8; i++) set(m, m.size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(m, 8, m.size - 15 + i, bit(i));
  set(m, 8, m.size - 8, true); // the dark module is part of the format area
}

function placeData(m, codewords) {
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  for (let i = 0; i < REMAINDER_BITS[m.version]; i++) bits.push(0);

  let k = 0;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < m.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;
        if (!m.isFunction[y][x] && k < bits.length) {
          m.modules[y][x] = bits[k] === 1;
          k++;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, mask) {
  const fn = MASKS[mask];
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.isFunction[y][x]) continue;
      if (fn(x, y)) m.modules[y][x] = !m.modules[y][x];
    }
  }
}

// Penalty scoring per ISO 18004 so the chosen mask stays readable everywhere.
function penalty(m) {
  const size = m.size;
  const dark = m.modules.flat().filter(Boolean).length;
  let score = 0;

  // Rule 1: runs of 5+ identical modules, rows and columns.
  const runs = (get) => {
    let s = 0;
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (get(i, j) === get(i, j - 1)) { run++; continue; }
        if (run >= 5) s += 3 + (run - 5);
        run = 1;
      }
      if (run >= 5) s += 3 + (run - 5);
    }
    return s;
  };
  score += runs((i, j) => m.modules[i][j]) + runs((i, j) => m.modules[j][i]);

  // Rule 2: 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = m.modules[y][x];
      if (v === m.modules[y][x + 1] && v === m.modules[y + 1][x] && v === m.modules[y + 1][x + 1]) score += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with 4 light modules on one side.
  const P1 = [true, false, true, true, true, false, true, false, false, false, false];
  const P2 = [...P1].reverse();
  const matchAt = (get, i, j, p) => p.every((v, k) => j + k < size && get(i, j + k) === v);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      if (matchAt((a, b) => m.modules[a][b], i, j, P1) || matchAt((a, b) => m.modules[a][b], i, j, P2)) score += 40;
      if (matchAt((a, b) => m.modules[b][a], i, j, P1) || matchAt((a, b) => m.modules[b][a], i, j, P2)) score += 40;
    }
  }

  // Rule 4: deviation from a 50% dark ratio.
  const percent = (dark / (size * size)) * 100;
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

// ---- Public API ------------------------------------------------------------
// Returns { size, modules: boolean[][] } (top-left origin, no quiet zone).
export function encodeQr(text) {
  const bytes = new TextEncoder().encode(String(text));
  const { codewords, version } = buildCodewords(bytes);
  const m = newMatrix(version);
  reserveFormatArea(m);
  drawFinders(m);
  drawAlignments(m);
  placeData(m, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const copy = { ...m, modules: m.modules.map((r) => r.slice()), isFunction: m.isFunction };
    applyMask(copy, mask);
    drawFormatBits(copy, mask);
    const p = penalty(copy);
    if (best === null || p < best.p) best = { p, mask };
  }
  applyMask(m, best.mask);
  drawFormatBits(m, best.mask);
  return { size: m.size, modules: m.modules, version, mask: best.mask };
}

// Paint a QR code into a canvas at device resolution. Kept in the same file as
// the encoder so there is nothing else to load.
export function renderQr(canvas, text, { scale = 6, quiet = 4 } = {}) {
  const qr = encodeQr(text);
  const px = (qr.size + quiet * 2) * scale;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  canvas.width = px * dpr;
  canvas.height = px * dpr;
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  // Scanners need dark modules on a light background, so the code itself is
  // black-on-white even though the app is monochrome dark. It sits in the
  // profile panel as a small tile, which is also why it is hidden by default.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }
  return qr;
}
