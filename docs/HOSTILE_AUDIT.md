# Hostile Production Audit (TypeScript / PostgreSQL Checklist)

## Scope and verification
- Repository inventory: `rg --files src test docs scripts bin`
- Baseline checks:
  - `npm test` ✅
  - `npm run -s audit:ci` ⚠️ (registry returned `Forbidden` in this environment)
- Targeted static sweeps:
  - `rg -n "as unknown as|as any|@ts-ignore|Promise\.race|JSON\.parse\(|process\.env|spawn\(" src`
  - `wc -l $(rg --files src)`
- Phase 2 re-check focus:
  - `tsconfig.json`, `.eslintrc.js`, `package.json`
  - all timeout/catch paths in `src/mcp/client.ts`, `src/tools/bash.ts`, `src/utils/settings-manager.ts`, `src/mcp/url-policy.ts`

## PostgreSQL/SQL surgery status
There is **no PostgreSQL client, migration system, SQL query layer, or schema** in this repository snapshot. All PostgreSQL-specific checklist items are currently **N/A** for this codebase revision.

---

## PHASE 1 — Systematic decomposition findings

### Critical (P0)

1. **File:Line:Column:** `src/tools/bash.ts:283:3`
   - **Category:** Security | Architecture
   - **Specific violation:** Workspace-boundary enforcement for file paths is string-based (`path.isAbsolute`, `arg.split('/')`) and does not resolve final canonical paths for command operands. Symlink traversal can bypass containment (e.g., workspace symlink pointing outside root).
   - **Concrete fix suggestion:** In `validateArgs`, for every path-bearing operand, resolve against current working directory (`path.resolve`), canonicalize (`fs.realpath`), and enforce canonical target prefix against canonical workspace root before spawning.
   - **Risk if not fixed:** A malicious or compromised repo can exfiltrate/read files outside the workspace boundary through allowed commands (`cat`, `grep`, `rg`, etc.).

### High (P1)

2. **File:Line:Column:** `src/tools/bash.ts:292:36`
   - **Category:** Security | Type
   - **Specific violation:** Traversal checks are POSIX-only (`arg.split('/')`) and miss Windows separators (`..\\`). This is a platform-dependent path policy bypass.
   - **Concrete fix suggestion:** Normalize using `path.normalize(arg)` and reject any path whose normalized segments contain `..` via `path.sep`-aware parsing.
   - **Risk if not fixed:** On Windows (or Windows-style input), relative traversal can evade current checks.

3. **File:Line:Column:** `src/mcp/client.ts:129:3`
   - **Category:** Async | Resilience
   - **Specific violation:** `ensureServersInitialized()` sets `this.initialized = true` even when server initialization fails. Subsequent calls short-circuit and never retry, despite cooldown tracking.
   - **Concrete fix suggestion:** Set `initialized` only when all configured servers have either connected or are intentionally disabled; otherwise keep lazy reattempt behavior (or move to per-server init state).
   - **Risk if not fixed:** A transient startup error can permanently disable MCP integrations for the process lifetime.

4. **File:Line:Column:** `src/mcp/client.ts:191:7`
   - **Category:** Async | Resilience
   - **Specific violation:** Timeout uses manual `setTimeout` rejection without aborting the in-flight `server.client.callTool` request.
   - **Concrete fix suggestion:** Propagate `AbortSignal` into SDK call (or encapsulate each tool call in cancellable transport context) and ensure only one teardown path runs.
   - **Risk if not fixed:** Timed-out calls continue consuming resources, causing connection pressure and degraded throughput under latency spikes.

5. **File:Line:Column:** `src/mcp/url-policy.ts:33:1`
   - **Category:** Architecture | Resilience
   - **Specific violation:** DNS lookup depends on `globalThis.require`, which is unavailable in standard ESM runtime. For public hostnames this throws `DNS lookup unavailable in current runtime`.
   - **Concrete fix suggestion:** Replace runtime `require` probing with static import (`node:dns/promises`) and deterministic fallback policy.
   - **Risk if not fixed:** Legitimate MCP URLs may fail in production depending on module runtime mode.

### Medium (P2)

6. **File:Line:Column:** `src/utils/settings-manager.ts:94:3`
   - **Category:** Performance | Resilience
   - **Specific violation:** Settings reads use synchronous filesystem I/O and unbounded `JSON.parse` on the main thread.
   - **Concrete fix suggestion:** Replace with async reads plus strict size cap before parse (e.g., reject >1MB settings) and schema validation.
   - **Risk if not fixed:** Malformed or oversized settings files can block CLI responsiveness and trigger avoidable crashes.

7. **File:Line:Column:** `.eslintrc.js:12:3`
   - **Category:** Testability | Quality
   - **Specific violation:** Lint profile omits high-value production rules (`no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, strict boolean conditions).
   - **Concrete fix suggestion:** Enable `@typescript-eslint/no-floating-promises`, `@typescript-eslint/switch-exhaustiveness-check`, and fail CI on lint.
   - **Risk if not fixed:** Async/control-flow bugs reach production undetected.

8. **File:Line:Column:** `src/tools/bash.ts:318:3`
   - **Category:** Type | Security
   - **Specific violation:** Custom tokenizer regex is not shell-accurate (escaped quotes/backslashes not modeled), so parsed argv can differ from user intent and policy checks can evaluate altered tokens.
   - **Concrete fix suggestion:** Replace with proven shell-words parser library or remove string command entrypoint and require structured `command + args` only.
   - **Risk if not fixed:** Inconsistent policy enforcement and hard-to-debug command behavior.

### Low (P3)

9. **File:Line:Column:** `src/hooks/use-input-handler.ts:1:1`
   - **Category:** Architecture
   - **Specific violation:** File is 756 lines and mixes UI input handling, command routing, edit flows, and async orchestration.
   - **Concrete fix suggestion:** Split into cohesive hooks/modules (`history`, `slash-commands`, `execution-controller`, `ui-effects`) and inject dependencies.
   - **Risk if not fixed:** Defect density and regression probability remain high for future changes.

10. **File:Line:Column:** `src/tools/text-editor.ts:1:1`
   - **Category:** Architecture | Testability
   - **Specific violation:** 570-line multipurpose tool with parsing, validation, filesystem operations, and history logic in one class.
   - **Concrete fix suggestion:** Extract validator, file adapter, and command executor into separate units with unit tests per boundary.
   - **Risk if not fixed:** Complex edits will continue to produce brittle behavior and low confidence in refactors.

---

## PHASE 2 — Adversarial re-review

### Re-examined aggressively
- Config and compiler settings: `tsconfig.json`, `.eslintrc.js`, `package.json`
- "Obvious" control-plane modules: `src/tools/bash.ts`, `src/mcp/client.ts`, `src/mcp/url-policy.ts`
- Catch/timeout/error paths: `src/utils/settings-manager.ts`, `src/mcp/client.ts`

### Phase 2 confirmations
- Highest incident risk remains workspace-boundary bypass in bash path validation.
- MCP init logic can permanently suppress server availability after transient failure.
- Timeout semantics in MCP tool execution are still non-cancellable.

---

## Immediate production-incident ranking (if deployed today)

1. **Workspace containment bypass in bash path validation** (`src/tools/bash.ts`)
   - **Blast radius:** Any workflow using BashTool can read outside the workspace when symlinks or uncanonicalized paths are present.

2. **MCP initialization lockout after transient startup failures** (`src/mcp/client.ts`)
   - **Blast radius:** All MCP-backed tools for that process become unavailable until restart.

3. **Non-cancellable MCP tool call timeouts** (`src/mcp/client.ts`)
   - **Blast radius:** Resource leakage and throughput collapse during upstream latency incidents.

4. **ESM-incompatible DNS resolver path in MCP URL policy** (`src/mcp/url-policy.ts`)
   - **Blast radius:** Production runtime mismatch can block all non-local MCP endpoint validation.
