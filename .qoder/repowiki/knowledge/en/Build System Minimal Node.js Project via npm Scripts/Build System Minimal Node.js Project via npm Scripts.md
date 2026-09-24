---
kind: build_system
name: 'Build System: Minimal Node.js Project via npm Scripts'
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
---

## What system/approach is used

This repository has no dedicated build toolchain. It is a plain Node.js project that relies entirely on `npm` (via `package.json`) for dependency resolution and two convenience scripts. There is no Makefile, Dockerfile, CI pipeline, release script, or cross-compile configuration.

## Key files and packages

- `package.json` — the single source of truth for the project metadata, runtime constraints, and scripts.
- `package-lock.json` — deterministic lockfile for reproducible installs.
- `node_modules/` — vendored dependencies installed by npm.

The only runtime dependency is `ws` (^8.18.0), which provides the WebSocket server used by `server/index.js`.

## Architecture and conventions

- **Module format**: The project declares `"type": "module"`, so both `server/index.js` and the browser-side files under `public/` are treated as ES modules.
- **Entry point**: `"main": "server/index.js"` identifies the server entry; there is no client build step — `public/*.js` is served directly to the browser.
- **Runtime constraint**: `"engines": { "node": ">=18" }` pins the minimum Node.js version to 18 (required for native ESM and Web Crypto API usage).
- **Scripts**:
  - `npm start` → `node server/index.js`
  - `npm run dev` → `node --watch server/index.js` (uses Node's built-in file watcher, no external dev server)
- **No bundling/transpilation**: No webpack, vite, babel, TypeScript, or minification step exists. Source files ship as-is.

## Conventions and constraints

- Dependency versions are pinned in `package.json` (`ws` ^8.18.0) and locked via `package-lock.json`; installing without a network call uses the lockfile.
- The project requires Node.js ≥ 18 at install/runtime time (enforced by npm's `engines` field).
- There is no automated test runner, linter, formatter, CI, container image, or release process present in the repository.
- Distribution is manual: users clone the repo, run `npm install`, then `npm start`.