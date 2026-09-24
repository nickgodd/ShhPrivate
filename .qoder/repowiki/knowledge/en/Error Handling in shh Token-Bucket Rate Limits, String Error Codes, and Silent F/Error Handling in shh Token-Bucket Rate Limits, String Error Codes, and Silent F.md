---
kind: error_handling
name: 'Error Handling in shh: Token-Bucket Rate Limits, String Error Codes, and Silent Failures'
category: error_handling
scope:
    - '**'
source_files:
    - server/ws.js
    - server/index.js
    - public/app.js
    - public/crypto.js
---

## Overview

The `shh` codebase uses a minimal, string-based error signaling model with no custom error classes. Errors flow from the Node.js WebSocket server to the browser client via a uniform `{ type: 'error', message }` JSON frame. The server enforces input validation and rate limits by returning short string codes; the client maps those codes to user-facing toast messages. There is no centralized error middleware, no structured logging, and no persistence of errors — consistent with the project's privacy-first design ("ALL state is in RAM. No database. No logs.").

## Server-side error handling (`server/ws.js`, `server/index.js`)

- **Centralized failure helper**: `fail(conn, message)` (ws.js:89–91) sends `{ type: 'error', message }` over the socket. Every validation or policy violation calls this helper rather than throwing, so the connection stays alive for subsequent requests.
- **Input validation failures** return specific string codes:
  - `bad_id`, `bad_key`, `bad_pow`, `bad_request` — malformed session creation, public keys, proof-of-work, or contact responses.
  - `no_session` — any action taken before `create_session` succeeds.
  - `too_large` — ciphertext exceeds the 2 KB + overhead limit enforced by `validCipher`.
  - `offline` / `rate_limited:*` — peer not reachable or token bucket exhausted.
- **Rate limiting as error source**: A per-connection `Bucket` class (ws.js:37–65) implements sliding-window token buckets keyed by action (`search`, `contact`, `message`, `create`). Exhaustion returns `rate_limited:<action>` (e.g. `rate_limited:message`). This is the primary mechanism preventing abuse (ID enumeration, spam requests, flooding).
- **Silent drops on protocol-level issues**:
  - Malformed JSON frames are parsed inside a try/catch and dropped silently (ws.js:264–269). No error is sent back; the client must rely on timeouts/reconnects.
  - Unknown `msg.type` values are ignored (default branch at ws.js:294–295).
  - WebSocket `error` events are swallowed (ws.js:300–302) — only cleanup happens.
  - Broken pipe writes in `send()` are caught and ignored (ws.js:70–75).
- **HTTP layer** (`server/index.js`): Static file serving returns plain text bodies (`'Bad request'`, `'Not found'`, `'Method not allowed'`) with appropriate status codes (400, 404, 405). Path traversal is rejected with 404. No HTTP error middleware exists; each handler returns directly.

## Client-side error handling (`public/app.js`, `public/crypto.js`)

- **Protocol error dispatch**: `onMessage` (app.js:125–176) switches on `m.type`. An incoming `{ type: 'error' }` is routed to `onError(code)` (app.js:178–193), which maps known codes to localized Russian toast messages:
  - `rate_limited:search|contact|message|create` → "Слишком много …" (Too many …)
  - `too_large` → "Сообщение превышает 2 КБ"
  - `id_taken`, `bad_pow` → generic session creation failure
  - `no_session` is suppressed (non-fatal)
  - Any other code falls through to `Ошибка: <code>`.
- **Crypto-layer exceptions**: `crypto.js` throws `new Error('pow_exhausted')` when the PoW loop hits its bound, and `new Error('no_ecdh_curve')` when Web Crypto lacks ECDH support. These bubble up to the caller; `app.js` handles curve detection by disabling the create button instead of catching the error.
- **Graceful degradation on decryption failure**: When decrypting an inbound message fails, the UI inserts `[не удалось расшифровать]` into the chat instead of crashing (app.js:328–333).
- **Non-blocking UI operations**: Clipboard write and WebSocket close are wrapped in try/catch with noop catches to avoid surfacing benign browser permission errors.
- **Reconnect strategy**: `onSocketClosed` triggers a 1-second reconnect timer unless `intentionalClose` is set (logout). This turns network errors into transient UI state changes rather than fatal failures.

## Architecture & Conventions

1. **Errors are strings, not objects.** The server never throws to the client; it serializes a short identifier string. This keeps the wire format tiny and avoids leaking stack traces.
2. **Validation precedes action.** Every handler checks inputs (`validB64Key`, `validCipher`, regex on `id`, `verifyPow`) before mutating state, failing fast with `fail()`.
3. **Rate limiting is first-class error semantics.** Many "errors" are really rate-limit rejections; the `rate_limited:` prefix lets the client distinguish throttling from genuine protocol violations.
4. **No logging, no persistence.** The server intentionally writes no logs and stores no error history. Errors are ephemeral, delivered once, then forgotten — aligning with the anonymity goal.
5. **Client treats most errors as non-fatal.** Even `bad_pow` and `id_taken` result in a toast and a retry path rather than terminating the app. Only missing crypto support disables functionality entirely.
6. **WebSocket `error` events are swallowed.** The server does not log connection errors; clients infer problems from `onclose` and auto-reconnect.