---
kind: configuration_system
name: Minimal Environment-Based Configuration (PORT only, no config files)
category: configuration_system
scope:
    - '**'
source_files:
    - package.json
    - server/index.js
    - public/app.js
---

## What system/approach is used

The repository uses an extremely minimal configuration approach: **no configuration files, no environment variable loader library, no feature flags, and no secrets management**. The only runtime configuration point is the server port, read directly from `process.env.PORT` with a hard-coded fallback.

## Key files and where configuration lives

- `package.json` — declares the Node.js engine requirement (`node >= 18`) and the entry point (`server/index.js`). It also contains npm scripts (`start`, `dev`) that launch the server. This is the closest thing to a manifest-style configuration in the repo.
- `server/index.js` — the sole place where external configuration is consumed:
  - `const PORT = Number(process.env.PORT) || 3000;` — reads the HTTP/WebSocket listen port from the process environment, defaulting to `3000`.
  - All other "configuration" is inlined as constants inside the file: MIME type map, Content Security Policy directives, security headers, WebSocket `maxPayload` (16 KiB), and the static asset directory path resolved relative to `__dirname`.
- `public/app.js` — the browser client has no configuration file either. The WebSocket URL is derived at runtime from `location.protocol` and `location.host`, so it always connects back to the same origin without any configurable endpoint.

## Architecture and conventions

- **Zero-config by design.** The project description explicitly states "in-memory only, no database, no logs." There are no `.env`, `.yaml`, `.toml`, `.json` config files, no `config/` directory, and no dotenv parsing. Everything that could be configured is either a constant or an environment variable.
- **Environment variables are not validated.** `Number(process.env.PORT)` will coerce `undefined` to `NaN` if `PORT` is set to a non-numeric string, which would cause `server.listen(NaN)` to fail at startup. There is no validation or error handling around env var parsing.
- **Runtime behavior is controlled via code, not config.** Hardened defaults are baked into source: strict CSP, disabled logging, 2 KB message size limit enforced on both client and server, 16 KiB max WebSocket payload, and `no-store` cache control for all assets. These are not exposed as tunables.
- **No secrets mechanism.** Identity keys, ephemeral keys, and chat keys are generated in-memory on each client session and never persisted. The server stores nothing on disk. There is no concept of shared secrets, API keys, or certificates managed through configuration.

## Conventions and constraints

Observed patterns (descriptive):
- External configuration is limited to a single optional `PORT` environment variable; everything else is hardcoded.
- The application runs as an ESM module (`"type": "module"` in `package.json`) and imports Node built-ins directly rather than using a configuration abstraction layer.
- The browser side derives its connection target from the page's origin (`ws`/`wss` + `location.host`), so deployment location is the only factor determining connectivity.

Constraints enforced by the implementation:
- The server listens on `process.env.PORT` if set, otherwise `3000`; there is no alternative configuration mechanism.
- No persistent state is written to disk, so there is no need for paths, data directories, or database URIs in configuration.
- No request/connection logging occurs (only a boot confirmation line), eliminating log-level or log-path configuration.