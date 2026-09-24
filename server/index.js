// HTTP static server + security headers + WebSocket upgrade wiring.
// This app stores NOTHING on disk and writes NO logs. All state lives in RAM.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { attachWs } from './ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// Strict CSP: only same-origin assets, no external fonts/scripts/trackers.
// connect-src allows same-origin + ws/wss (needed for the WebSocket relay).
// img-src additionally allows data: and blob:, which is how a decrypted
// attachment is shown in the chat: the bytes go from WebCrypto straight into an
// in-memory object URL and never touch the network or the disk.
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "font-src 'none'",
  "worker-src 'none'",
  "manifest-src 'self'",
].join('; ');

function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (urlPath === '/') urlPath = '/index.html';

  // Resolve and guard against path traversal.
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return send(res, 404, 'Not found');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // no-store everywhere: privacy-focused, and guarantees clients always run
      // the current crypto code instead of a stale cached module.
      'Cache-Control': 'no-store',
    });
  });
}

const server = http.createServer((req, res) => {
  // Security headers on every HTTP response.
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Camera is used ONLY by the in-app QR scanner, on this origin, and only after
  // an explicit click. Everything else stays denied.
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // HSTS is only meaningful over TLS (Railway terminates TLS for you).
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed');
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({
  noServer: true,
  // Text messages stay tiny (2 KB ciphertext); the cap exists so a single file
  // chunk (64 KB plaintext -> ~87 KB base64) fits in one frame. Nothing larger
  // is ever accepted, and the server still buffers no file data at all.
  maxPayload: 128 * 1024,
  // Never log or retain IPs: we only accept the connection, nothing is recorded.
});

server.on('upgrade', (req, socket, head) => {
  // Reject non-WebSocket upgrades quietly.
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

attachWs(wss);

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  // Intentionally no request/connection logging. This line only confirms boot.
  console.log(`shh listening on :${PORT}`);
});
