# Hostile Production Audit (TypeScript/PostgreSQL Criteria) — 2026-02-21

## Scope & Method
- Phase 1: file-by-file static review of `src/`, `test/`, and build/runtime configs.
- Phase 2: adversarial re-pass focused on error paths, config, and dependency controls.
- Validation commands run:
  - `npm run -s typecheck`
  - `npm run -s lint`
  - `npm test --silent`
  - `npm audit --json` (registry endpoint blocked in this environment with HTTP 403)

## Important Context
- No PostgreSQL driver, migrations, schema, SQL query layer, or DB access code is present in this repository. SQL/Postgres checks are therefore **not applicable to current code artifacts** and are reported as architectural gap only.

---

## 1) Critical (P0)
- **No verified P0 defect found in this repository revision.**

---

## 2) High (P1)

### P1-1
- **File:Line:Column:** `src/utils/settings-manager.ts:169:23`
- **Category:** Security
- **Violation:** `ensureSecureDirectory()` and `ensureSecureDirectorySync()` use `stat()` instead of `lstat()`, so symlinked settings directories are treated as trusted directories.
- **Concrete fix:** Change `fs.stat`/`fsSync.statSync` to `lstat`/`lstatSync`; explicitly reject `isSymbolicLink()` before chmod/write. Then resolve canonical path and verify it equals expected directory root before writing.
- **Risk if not fixed:** Local privilege/path redirection attack can redirect settings writes (including trusted MCP fingerprints and user config) to attacker-controlled locations, causing config tampering and persistence compromise.

### P1-2
- **File:Line:Column:** `src/tools/text-editor.impl.ts:33:35`
- **Category:** Security | Data Integrity
- **Violation:** `createFileNoFollow()` opens with `O_CREAT | O_TRUNC | O_NOFOLLOW` but **without `O_EXCL`**, so “create” can overwrite existing files.
- **Concrete fix:** Change flags to `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`; in caller, return explicit “file already exists” error when `EEXIST` is raised.
- **Risk if not fixed:** Destructive overwrite of existing files through a path that users/operators expect to be non-destructive “create”, causing irreversible data loss.

### P1-3
- **File:Line:Column:** `src/mcp/transports.ts:71:25`, `src/mcp/transports.ts:108:17`
- **Category:** Security
- **Violation:** Stdio MCP child inherits high-value parent environment (`HOME`, `PATH`, `USER`, `SHELL`, etc.) and only partially constrains overrides; untrusted MCP servers still receive ambient environment context.
- **Concrete fix:** Reduce default env to minimal deterministic baseline (`PATH` + explicit MCP vars only), add explicit opt-in pass-through list for additional env vars, and require signed/trusted server metadata before non-minimal inheritance.
- **Risk if not fixed:** Untrusted/compromised MCP server process can exfiltrate environment-derived secrets or host metadata; increases blast radius of any MCP supply-chain compromise.

---

## 3) Medium (P2)

### P2-1
- **File:Line:Column:** `tsconfig.ci.json:2:3`, `tsconfig.strict.json:6:5`
- **Category:** Type
- **Violation:** `noUncheckedIndexedAccess` exists only in `tsconfig.strict.json` and is not used by CI `typecheck` script (`tsconfig.ci.json`).
- **Concrete fix:** Enable `"noUncheckedIndexedAccess": true` in base `tsconfig.json` or `tsconfig.ci.json`, then fix resulting unsafe index access sites incrementally.
- **Risk if not fixed:** Silent `undefined` propagation from index lookups remains possible in production builds despite strict mode, especially in parser and command-argument handling paths.

### P2-2
- **File:Line:Column:** `src/mcp/transports.ts:143:22`
- **Category:** Type | Architecture
- **Violation:** Double cast `as unknown as { process?: { pid?: number } }` breaks type guarantees and couples to SDK internals.
- **Concrete fix:** Replace with maintained adapter abstraction (store child PID at transport creation if SDK exposes it) or contribute upstream typed accessor; fail safely when PID is unavailable.
- **Risk if not fixed:** SDK upgrades can silently break teardown path, leaving orphaned child processes and eventual resource exhaustion under repeated reconnect/timeouts.

### P2-3
- **File:Line:Column:** `src/index.tsx:67:5`
- **Category:** Resilience
- **Violation:** `process.exit()` is called directly after async cleanup race; abrupt exit can truncate buffered logs/stdout under pressure.
- **Concrete fix:** Set `process.exitCode`, await stream drains (`stdout.write('', cb)` / `stderr.write('', cb)`), then allow natural exit.
- **Risk if not fixed:** Loss of forensic logs and partial output during incident windows, degrading incident response and postmortem fidelity.

---

## 4) Low (P3)

### P3-1
- **File:Line:Column:** `package.json:19:5` onward
- **Category:** Architecture | Supply Chain
- **Violation:** Runtime dependencies are version-ranged with `^` and no CI-enforced frozen install policy documented in scripts.
- **Concrete fix:** Enforce `npm ci` in CI and release pipeline, add lockfile integrity gate, and pin high-risk runtime deps to exact versions for release branches.
- **Risk if not fixed:** Non-deterministic dependency drift can introduce unreviewed behavior/security changes between builds.

### P3-2
- **File:Line:Column:** `src/agent/vision.ts:19:5`, `src/mcp/marketplace.ts:3:5`
- **Category:** Observability
- **Violation:** Mixed logging style (`console.log` ad hoc + structured logger) reduces consistency and redaction guarantees.
- **Concrete fix:** Route operational logs through `logger.*` only; keep direct `console.log` for user-facing CLI responses.
- **Risk if not fixed:** Inconsistent log shape and potential future secret redaction bypass in newly added ad hoc logs.

---

## Phase 2 Adversarial Re-check Notes
- Rechecked "obvious" hardened surfaces (`bash.ts`, `search.ts`, MCP manager timeout paths) for timeout/teardown race windows.
- Rechecked catch blocks and fallback paths in `settings-manager.ts`, `mcp/client.ts`, `index.tsx`.
- Rechecked configs (`tsconfig*.json`, `eslint.config.js`) and package controls (`package.json`, lockfile usage assumptions).
- Rechecked for PostgreSQL-specific artifacts; none present.

---

## Immediate Production Incident Ranking (if deployed now)
1. **P1-1 (settings symlink trust bypass)** — Blast radius: user-level config integrity compromise; trusted MCP fingerprint and runtime endpoint tampering.
2. **P1-2 (create overwrites existing file)** — Blast radius: destructive data loss in workspace files during normal editing operations.
3. **P1-3 (ambient env exposure to MCP child)** — Blast radius: host metadata/secret leakage to any compromised or malicious MCP server process.
4. **P2-2 (unsafe SDK internals cast)** — Blast radius: orphaned subprocess accumulation and eventual service degradation during repeated timeout events.
