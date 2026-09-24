// Protocol limits, checked at the raw socket level: size caps, undeclared
// frames, presence rules and the token buckets. Nothing here needs a browser.
//
// Run: node test/limits.test.mjs
import {
  delay, ok, summary, b32id, establish, rawClient, bootServer, bootGlobals,
} from './helpers.mjs';
import crypto from 'node:crypto';
import { generateIdentity, generateEphemeral } from '../public/crypto.js';

const PORT = 4615;
const b64 = (n) => crypto.randomBytes(n).toString('base64');

// Two sessions plus a real, accepted chat between them.
async function pair(wsUrl, name) {
  const a = rawClient(`${name}A`, wsUrl);
  const b = rawClient(`${name}B`, wsUrl);
  a.id = b32id();
  b.id = b32id();
  const idA = await generateIdentity();
  const idB = await generateIdentity();
  await establish(a, idA.publicB64);
  await establish(b, idB.publicB64);
  const ephA = await generateEphemeral();
  a.json({ type: 'contact_request', to: b.id, publicKey: idA.publicB64, ephPub: ephA.publicB64 });
  const req = await b.wait((m) => m.type === 'contact_request');
  const ephB = await generateEphemeral();
  b.json({ type: 'contact_response', requestId: req.requestId, accept: true, publicKey: idB.publicB64, ephPub: ephB.publicB64 });
  await delay(80);
  return { a, b };
}

async function main() {
  const server = await bootServer(PORT);
  const { wsUrl } = bootGlobals(PORT);
  console.log('server is up\n');

  const errOf = (client, code, ms = 3000) =>
    client.wait((m) => m.type === 'error' && m.message === code, ms).catch(() => null);
  const typeOf = (client, type, ms = 3000) =>
    client.wait((m) => m.type === type, ms).catch(() => null);

  // ---- text size ----------------------------------------------------------
  const t = await pair(wsUrl, 'text');
  t.a.json({ type: 'message', to: t.b.id, ciphertext: b64(2048 + 64 + 500) });
  ok(await errOf(t.a, 'too_large'), 'a ciphertext over the 2 KB budget is refused (too_large)');
  t.a.json({ type: 'message', to: t.b.id, ciphertext: b64(1200) });
  ok(await typeOf(t.b, 'message'), 'an in-budget message still passes');

  // A stranger with no chat adjacency cannot write to somebody.
  const lone = rawClient('lone', wsUrl);
  lone.id = b32id();
  await establish(lone, (await generateIdentity()).publicB64);
  lone.json({ type: 'message', to: t.b.id, ciphertext: b64(40) });
  ok(await typeOf(lone, 'undeliverable'), 'without a chat you cannot message a peer (undeliverable)');

  // ---- file_open validation ----------------------------------------------
  const f = await pair(wsUrl, 'file');
  f.a.json({ type: 'file_open', to: f.b.id, transferId: 'abcdef1', size: 6 * 1024 * 1024, chunks: 96 });
  ok(await errOf(f.a, 'file_too_large'), 'a declared file over 5 MB is refused (file_too_large)');

  f.a.json({ type: 'file_open', to: f.b.id, transferId: 'abcdef2', size: 1024, chunks: 0 });
  ok(await errOf(f.a, 'bad_transfer'), 'a bogus chunk count is refused (bad_transfer)');

  f.a.json({ type: 'file_open', to: f.b.id, transferId: 'x', size: 1024, chunks: 1 });
  ok(await errOf(f.a, 'bad_transfer'), 'a malformed transfer id is refused (bad_transfer)');

  f.a.json({ type: 'file_open', to: f.b.id, transferId: 'abcdef3', size: 1024, chunks: 400 });
  ok(await errOf(f.a, 'bad_transfer'), 'more chunks than the cap allows is refused (bad_transfer)');

  // ---- chunks must belong to a declared transfer --------------------------
  f.a.json({ type: 'file_chunk', to: f.b.id, transferId: 'nodeclan', index: 0, ciphertext: b64(1024) });
  ok(await errOf(f.a, 'no_transfer'), 'an undeclared chunk stream is refused (no_transfer)');

  f.a.clear();
  f.b.clear();
  f.a.json({ type: 'file_open', to: f.b.id, transferId: 'abcdef4', size: 2048, chunks: 2 });
  await typeOf(f.b, 'file_open');
  f.a.json({ type: 'file_chunk', to: f.b.id, transferId: 'abcdef4', index: 5, ciphertext: b64(1024) });
  ok(await errOf(f.a, 'bad_chunk'), 'a chunk index past the declared count is refused (bad_chunk)');

  // ---- chunk payload cap --------------------------------------------------
  const g = await pair(wsUrl, 'chunk');
  g.a.json({ type: 'file_open', to: g.b.id, transferId: 'zzz111', size: 200_000, chunks: 3 });
  await typeOf(g.b, 'file_open');
  g.a.json({ type: 'file_chunk', to: g.b.id, transferId: 'zzz111', index: 0, ciphertext: b64(64 * 1024 + 600) });
  const chunkErr = await g.a.wait((m) => m.type === 'error' && m.message === 'chunk_too_large', 3000).catch(() => null);
  ok(!!chunkErr, 'a frame over 64 KB of plaintext is refused (chunk_too_large)');
  ok(chunkErr && chunkErr.transferId === 'zzz111', 'the error names the transfer, so the client fails the right attachment');

  // ---- offline recipient: nothing is queued, nothing is delivered ---------
  const gone = rawClient('gone', wsUrl);
  gone.id = b32id();
  await establish(gone, (await generateIdentity()).publicB64);
  g.a.json({ type: 'file_open', to: gone.id, transferId: 'zzz222', size: 100, chunks: 1 });
  ok(await typeOf(g.a, 'undeliverable'), 'a file to a peer you have no live chat with is not accepted');
  gone.ws.close();

  // ---- rate limits --------------------------------------------------------
  const r = await pair(wsUrl, 'rate');
  for (let i = 0; i < 12; i++) {
    r.a.json({ type: 'file_open', to: r.b.id, transferId: `tst${1000 + i}`, size: 1000, chunks: 1 });
  }
  ok(await errOf(r.a, 'rate_limited:file'), 'file declarations are rate limited (rate_limited:file)');

  const q = await pair(wsUrl, 'msg');
  for (let i = 0; i < 60; i++) q.a.json({ type: 'message', to: q.b.id, ciphertext: b64(64) });
  ok(await errOf(q.a, 'rate_limited:message', 4000), 'messages are rate limited (rate_limited:message)');

  const s = rawClient('searcher', wsUrl);
  s.id = b32id();
  await establish(s, (await generateIdentity()).publicB64);
  for (let i = 0; i < 14; i++) s.json({ type: 'search', targetId: b32id() });
  ok(await errOf(s, 'rate_limited:search', 4000), 'search is rate limited (no ID enumeration)');

  // ---- oversized frame: the socket itself is capped ----------------------
  const big = await pair(wsUrl, 'big');
  const closed = new Promise((res) => big.a.ws.on('close', (code) => res(code)));
  big.a.json({ type: 'file_chunk', to: big.b.id, transferId: 'oversizd', index: 0, ciphertext: b64(200 * 1024) });
  const code = await Promise.race([closed, delay(4000, 'timeout')]);
  ok(code === 1009, `a 200 KB frame drops the connection instead of buffering it (code ${code})`);

  console.log('');
  const failed = summary();
  for (const c of [t.a, t.b, lone, f.a, f.b, g.a, g.b, r.a, r.b, q.a, q.b, s, big.b]) c.ws.close();
  server.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nTEST CRASHED:', e); process.exit(1); });
