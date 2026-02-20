# Hostile Production Audit (TypeScript / PostgreSQL Checklist)

## Scope and verification method
- Repository inventory sweep: `rg --files src test docs scripts bin`
- Baseline checks:
  - `npm test` ✅
  - `npx eslint src --ext .ts,.tsx` ❌ (ESLint v9 cannot load legacy `.eslintrc.js`)
- Targeted static scans:
  - `rg -n "process\.env|JSON\.parse\(|as unknown as|as any|setTimeout\(|Promise\.race\(|spawn\(" src test`
  - `rg -n "endsWith\(\"/\"\)|startsWith\(`\$\{.*\}/`|split\(/\[\\\\/\]\+\/\)" src`
- Phase 2 adversarial re-check (config + obvious code + error paths):
  - `tsconfig.json`, `.eslintrc.js`, `package.json`
  - `src/tools/bash.ts`, `src/tools/text-editor.impl.ts`, `src/mcp/client.ts`, `src/mcp/config.ts`, `src/tools/search.ts`

## PostgreSQL / SQL surgery status
No PostgreSQL driver, SQL query builder, migration files, or schema files exist in this repository revision. All DB-specific checks are **N/A for this codebase snapshot**.

---

## PHASE 1 — Systematic decomposition findings

### Critical (P0)

1. **File:Line:Column:** `src/mcp/config.ts:80:3`
   - **Category:** Security | Architecture
   - **Specific violation:** Prototype-pollution sink via untrusted key assignment (`mcpServers[config.name] = config`) on plain objects read/write from settings.
   - **Concrete fix suggestion:** Replace object-backed storage with `Map<string, MCPServerConfig>` in-memory and serialize through `Object.create(null)` plus explicit key validation (`/^[a-zA-Z0-9._-]{1,64}$/`). Reject `__proto__`, `constructor`, `prototype`.
   - **Risk if not fixed:** A crafted server name can poison object prototypes in config handling paths, causing integrity and availability failures in control-plane config.

### High (P1)

2. **File:Line:Column:** `src/tools/bash.ts:197:24`
   - **Category:** Security | Type
   - **Specific violation:** Workspace prefix checks in `changeDirectory` are hardcoded with `'/'` instead of `path.sep`, making path containment logic platform-fragile.
   - **Concrete fix suggestion:** Canonicalize both root and target with `fs.realpath`, then compare via `path.relative(root, target)` (`!rel.startsWith('..') && !path.isAbsolute(rel)`) instead of string prefix matching.
   - **Risk if not fixed:** On Windows or mixed-separator paths, containment checks can misclassify paths and permit directory escapes or false denies.

3. **File:Line:Column:** `src/tools/text-editor.impl.ts:535:38`
   - **Category:** Security | Type
   - **Specific violation:** `resolveSafePath` also uses `'/'`-based prefix checks (`endsWith("/")`, `startsWith(rootPrefix)`) for boundary enforcement.
   - **Concrete fix suggestion:** Rework to `path.relative(workspaceRootReal, candidateRealOrResolved)` checks for existing and non-existing paths; avoid separator assumptions.
   - **Risk if not fixed:** File-edit safety gates can be bypassed or broken on non-POSIX path semantics.

4. **File:Line:Column:** `src/mcp/client.ts:207:34`
   - **Category:** Async | Resilience
   - **Specific violation:** Timeout is implemented with `Promise.race` but does not cancel the in-flight `server.client.callTool(...)` operation.
   - **Concrete fix suggestion:** Thread `AbortSignal` through MCP tool calls (if SDK supports it) or close transport immediately on timeout before rejecting, ensuring the underlying operation cannot continue.
   - **Risk if not fixed:** Timed-out calls keep consuming remote/server resources, causing latent queue buildup and cascading latency under load.

5. **File:Line:Column:** `.eslintrc.js:1:1`
   - **Category:** Testability | Quality
   - **Specific violation:** Lint configuration is legacy `.eslintrc.js` while project uses ESLint v9, so lint rules are effectively not enforced in CI/developer runs.
   - **Concrete fix suggestion:** Migrate to `eslint.config.js` flat config and wire `npm run lint` into CI/test script.
   - **Risk if not fixed:** Promise-handling and exhaustiveness regressions bypass automated gates and reach production.

### Medium (P2)

6. **File:Line:Column:** `src/tools/search.ts:316:45`
   - **Category:** Type | Architecture
   - **Specific violation:** Relative path derivation assumes POSIX separator (`${this.currentDirectory}/`), causing cross-platform inconsistency and path mis-formatting.
   - **Concrete fix suggestion:** Replace with `path.relative(this.currentDirectory, fullPath)` and normalize output explicitly for display.
   - **Risk if not fixed:** Incorrect file references and brittle behavior on Windows paths.

7. **File:Line:Column:** `src/agent/grok-agent.ts:267:20`
   - **Category:** Security | Resilience
   - **Specific violation:** Tool arguments are parsed from raw JSON (`JSON.parse(argsRaw)`) without schema-level validation/size guard before dispatch.
   - **Concrete fix suggestion:** Enforce per-tool zod/io-ts schemas and reject payloads above bounded size before parse.
   - **Risk if not fixed:** Malformed or oversized tool-call payloads can trigger avoidable runtime failures and denial-of-service style slowdowns.

8. **File:Line:Column:** `src/utils/settings-manager.ts:95:3`
   - **Category:** Performance | Resilience
   - **Specific violation:** Hot-path settings reads use synchronous filesystem calls (`existsSync`, `statSync`, `readFileSync`) in process control flow.
   - **Concrete fix suggestion:** Convert `readJsonFile` to async I/O and cache invalidation strategy; keep current file-size guard.
   - **Risk if not fixed:** Event-loop stalls under slow filesystem conditions degrade CLI responsiveness and startup latency.

### Low (P3)

9. **File:Line:Column:** `src/types/index.ts:45:1`
   - **Category:** Type
   - **Specific violation:** Brand constructors (`asMCPServerName`, etc.) are unchecked casts with no runtime invariant enforcement.
   - **Concrete fix suggestion:** Add parse/validate functions returning `Result`-style objects and reserve `as*` for internal trusted boundaries only.
   - **Risk if not fixed:** Branded types provide limited real safety at untrusted boundaries.

10. **File:Line:Column:** `src/tools/text-editor.impl.ts:7:1`
   - **Category:** Architecture | Testability
   - **Specific violation:** Large multipurpose class (editing, diffing, history, safety checks, confirmation orchestration) increases blast radius per change.
   - **Concrete fix suggestion:** Split into `PathSafetyService`, `EditExecutor`, `HistoryStore`, and `ConfirmationPolicy` modules with focused tests.
   - **Risk if not fixed:** Higher regression probability and slower incident remediation.

---

## PHASE 2 — Adversarial review (assume missed bugs)

### Rechecked areas
1. **Config trapdoors:** `tsconfig.json`, `.eslintrc.js`, `package.json`.
2. **“Obvious” code likely to hide defects:** path-boundary logic and settings/config code.
3. **Error and timeout paths:** MCP call timeout path, JSON parse and settings read failures.

### Phase 2 confirmations
- The strongest immediate security concern is config-key prototype pollution in MCP server persistence.
- Cross-platform path-boundary logic still relies on separator-sensitive string checks in multiple modules.
- Timeout handling still lacks cancellation semantics for MCP calls.
- Lint guardrails are presently non-functional due config/runtime mismatch.

---

## Immediate production-incident ranking (if deployed today)

1. **Prototype pollution in MCP config storage** (`src/mcp/config.ts`)  
   **Blast radius:** Entire MCP config/control-plane behavior; potential corruption of object lookups and unsafe state mutations.

2. **Path-boundary containment flaws in directory/file safety checks** (`src/tools/bash.ts`, `src/tools/text-editor.impl.ts`)  
   **Blast radius:** File-system safety controls for command execution and editor operations on non-POSIX path semantics.

3. **Non-cancellable MCP tool-call timeout path** (`src/mcp/client.ts`)  
   **Blast radius:** Resource exhaustion and degraded availability during upstream slowness/high latency.

4. **Lint enforcement disabled by ESLint v9 config mismatch** (`.eslintrc.js`)  
   **Blast radius:** Quality gate bypass across the entire TypeScript codebase.
