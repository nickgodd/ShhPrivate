// public/files.js — attachment plumbing: how a byte blob becomes a sequence of
// encrypted frames and how frames become a blob again. Deliberately free of DOM
// calls (except object URLs, which the caller creates) so the logic can be unit
// tested head-first.
import { CHUNK_PLAIN_MAX, FILE_MAX_BYTES, encryptChunk, decryptChunk } from './crypto.js';

export const MAX_FILE_BYTES = FILE_MAX_BYTES; // 5 MB, mirrored by the server
export const CHUNK_SIZE = CHUNK_PLAIN_MAX; // 64 KB of plaintext per frame
export const ASSEMBLY_TIMEOUT_MS = 60_000; // a half-received file is dropped, not held

export function overSize(bytes) {
  return bytes.length > MAX_FILE_BYTES;
}

export function chunkCount(size) {
  return Math.max(1, Math.ceil(size / CHUNK_SIZE));
}

// Encrypt slices one at a time, yielding after each so the UI can paint progress
// and so peak memory stays at "one chunk" instead of "twice the file".
export async function* encryptFrames(bytes, key, { signal } = {}) {
  const total = chunkCount(bytes.length);
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) return;
    const slice = bytes.subarray(i * CHUNK_SIZE, Math.min(bytes.length, (i + 1) * CHUNK_SIZE));
    const ciphertext = await encryptChunk(key, slice);
    yield { index: i, ciphertext, of: total };
  }
}

// One incoming transfer. Frames may arrive out of order; duplicates are ignored
// and nothing is rendered until every declared chunk is present.
export class Receiver {
  constructor({ transferId, size, chunks, key, ttl = ASSEMBLY_TIMEOUT_MS, onExpire }) {
    this.transferId = transferId;
    this.size = size;
    this.chunks = chunks;
    this.key = key;
    this.parts = new Array(chunks).fill(null);
    this.got = 0;
    this.bytes = 0;
    this.started = Date.now();
    this.timer = setTimeout(() => onExpire?.(this), ttl);
  }

  // Returns true when the file is complete.
  async add(index, ciphertext) {
    if (!Number.isInteger(index) || index < 0 || index >= this.chunks) return false;
    if (this.parts[index]) return this.got === this.chunks; // duplicate frame
    const plain = await decryptChunk(this.key, ciphertext); // AEAD tag rejects tampering
    this.parts[index] = plain;
    this.bytes += plain.length;
    this.got += 1;
    return this.got === this.chunks;
  }

  assemble() {
    const out = new Uint8Array(this.bytes);
    let off = 0;
    for (const p of this.parts) { out.set(p, off); off += p.length; }
    return out;
  }

  destroy() {
    clearTimeout(this.timer);
    this.parts.fill(null);
    this.key = null;
    this.bytes = 0;
  }
}

// Progress as a rounded percentage, kept away from the callers.
export function percent(done, total) {
  if (!total) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}
