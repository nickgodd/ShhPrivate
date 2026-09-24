---
kind: dependency_management
name: npm-based dependency management with a single runtime dependency
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - .gitignore
---

## Approach

This repository uses **npm** as its package manager. There is one Node.js runtime dependency (`ws` for WebSocket communication) declared in `package.json`, and the lockfile `package-lock.json` pins exact transitive versions.

## Key files

- `package.json` — declares the project metadata, Node engine requirement, scripts, and the sole runtime dependency `ws@^8.18.0`.
- `package-lock.json` — npm lockfile that pins the full resolved dependency tree (including transitive dependencies of `ws`).
- `.gitignore` — explicitly ignores `node_modules/` and npm/yarn debug logs, indicating npm is the intended toolchain.

## Conventions and constraints

- **Single dependency**: The application depends only on `ws` for WebSocket transport; all cryptography (X25519/ECDH, HKDF, AES-256-GCM) is implemented natively using the browser's Web Crypto API and Node's built-in `crypto` module — no additional crypto libraries are vendored or declared.
- **Engine pinning**: `package.json` specifies `"engines": { "node": ">=18" }`, enforcing a minimum Node.js version at install/run time via npm's engines field.
- **ESM-only**: `"type": "module"` makes the entire package ESM by default; both `server/index.js` and the client-side modules use ES module syntax.
- **Lockfile committed**: `package-lock.json` is present at the repo root (not ignored), so reproducible installs rely on it rather than allowing arbitrary semver resolution.
- **No vendoring**: There is no `vendor/`, `third_party/`, or similar directory; third-party code is installed into `node_modules/` at install time.
- **No private registry / scoped packages**: No `.npmrc`, `GOPRIVATE`, or scoped registries are configured; dependencies are fetched from the public npm registry.
- **Scripts**: `start` runs `node server/index.js`; `dev` uses `node --watch` for hot reload during development.
- **`.gitignore` policy**: `node_modules/` is excluded from version control, while `package-lock.json` is tracked to ensure deterministic builds.