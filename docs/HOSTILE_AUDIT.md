# Hostile Production Audit (TypeScript/PostgreSQL Readiness)

## Scope and verification protocol
- File inventory pass (TypeScript + config + SQL presence):
  - `rg --files -g '*.ts' -g '*.tsx' -g '*.sql' -g 'package.json' -g 'tsconfig*.json' --glob '!node_modules/**'`
- Targeted static pattern passes for unsafe async/control-flow/input handling:
  - `rg -n "as unknown as|Promise\.race|process\.exit\(|JSON\.parse\(|AbortController|spawn\(|--max-count|-maxdepth|unhandledRejection|uncaughtException" src --glob '!node_modules/**'`
- Large-file architecture sweep (>300 LOC):
  - `python - <<'PY' ...` (line-count script)
- Independent verification pass #1: threat-model review (security/data-loss/outage paths).
- Independent verification pass #2: reliability/config/error-path review.

Validation commands run:
- `npm run -s typecheck` ✅
- `npm run -s lint` ✅
- `npm test -s` ✅
- `npm run -s audit:ci` ⚠️ (`npm audit` returned `Forbidden`; SBOM fallback executed)

## Phase 1 — Systematic decomposition findings

### Critical (P0)
1. **File:Line:Column** `src/mcp/client.ts:283:7`  
   **Category:** Security | Async | Data Integrity  
   **Violation:** Tool execution timeout is local-only (`Promise.race` + abort + teardown), but there is no protocol-level cancellation acknowledgement or idempotency key passed to the remote MCP tool call. A timed-out call can still commit remotely and then be retried, causing duplicate side effects.  
   **Concrete fix:** Add a mandatory idempotency token to every mutable MCP tool call and enforce server-side deduplication; add explicit cancellation RPC/ack before retry eligibility.  
   **Risk if not fixed:** Duplicate writes/side-effects under latency spikes, with direct financial/data-integrity exposure.

### High (P1)
2. **File:Line:Column** `src/utils/settings-manager.ts:188:9`  
   **Category:** Concurrency | Data Integrity  
   **Violation:** `loadUserSettings(forceReload)` and `loadProjectSettings(forceReload)` return cached values when `pendingWriteCount > 0` even if `forceReload=true`, creating stale-read windows during concurrent updates.  
   **Concrete fix:** Convert load paths to async and `await this.flushWrites()` when `forceReload` is true; otherwise include monotonic versioning and reject stale cache return when writes are pending.  
   **Risk if not fixed:** Lost-update and stale-config behavior during concurrent operations.

3. **File:Line:Column** `src/tools/bash.ts:397:5`  
   **Category:** Security | Performance | Resource Control  
   **Violation:** Guardrails claim `find requires -maxdepth <= 8` and `grep/rg requires --max-count <= 500`, but code checks only flag presence, not numeric bounds or parse validity.  
   **Concrete fix:** Parse and validate numeric flag values (`Number.isInteger`, range check) and hard-fail if missing/out-of-range.  
   **Risk if not fixed:** Runaway scans and self-inflicted denial-of-service under adversarial prompts.

4. **File:Line:Column** `src/index.tsx:107:7`  
   **Category:** Resilience | Architecture  
   **Violation:** Direct `process.exit()` is used in CLI paths instead of going through shared shutdown; cleanup hooks (`removeServer`, timeout-bounded teardown) can be bypassed.  
   **Concrete fix:** Replace direct exits with `await shutdown("CLI_EXIT", code)` and centralize all process termination in one path.  
   **Risk if not fixed:** Abrupt termination, leaked in-flight operations, nondeterministic teardown behavior.

### Medium (P2)
5. **File:Line:Column** `src/utils/settings-manager.ts:133:5`  
   **Category:** Architecture | Multi-tenant isolation  
   **Violation:** `SettingsManager` is a process-global singleton that binds `projectSettingsPath` from `process.cwd()` once at construction. Later workspace changes can operate against an unintended project settings file.  
   **Concrete fix:** Remove singleton or key instances by canonical workspace root; recompute project settings path on context switch.  
   **Risk if not fixed:** Cross-project config bleed and hard-to-reproduce state contamination.

6. **File:Line:Column** `src/commands/mcp.ts:173:20`  
   **Category:** Security | Input validation  
   **Violation:** JSON config input is parsed directly from CLI string with no explicit size/depth bound prior to parse.  
   **Concrete fix:** Enforce max input length before parse (e.g., 64KB), and reject deeply nested/oversized structures before constructing transport config.  
   **Risk if not fixed:** Memory pressure or parse-time denial-of-service from oversized payloads.

7. **File:Line:Column** `src/grok/client.ts:294:3`  
   **Category:** Resilience | Retry policy  
   **Violation:** Retry classifier only checks HTTP status codes; no special handling/backoff strategy for transport-level errors (DNS/TLS/socket reset) and no dead-letter/circuit-breaker behavior.  
   **Concrete fix:** Extend `isRetryable` to include explicit network error classes/codes and add circuit-breaker/open-state after repeated upstream failure windows.  
   **Risk if not fixed:** Cascading latency/failure amplification during provider instability.

### Low (P3)
8. **File:Line:Column** `src/utils/confirmation-service.ts:28:1`  
   **Category:** Architecture | Testability  
   **Violation:** Global singleton + EventEmitter-based mutable queue complicates deterministic tests and introduces hidden cross-test state unless reset perfectly.  
   **Concrete fix:** Inject `ConfirmationService` via interface/factory per app instance; reserve singleton only for top-level wiring.  
   **Risk if not fixed:** Flaky tests and harder fault injection for concurrency edge cases.

9. **File:Line:Column** `src/types/globals.d.ts:3:5`  
   **Category:** Type Safety  
   **Violation:** Global EventEmitter declaration broadens listener signatures to `unknown[]`, reducing compile-time signal quality for event payloads.  
   **Concrete fix:** Replace global augmentation with narrow typed event interfaces at call sites.  
   **Risk if not fixed:** Easier accidental event-contract drift.

## PostgreSQL/SQL surgery status
- No PostgreSQL query layer, ORM model, migration directory, or `.sql` files were found in-repo during this audit (`rg --files -g '*.sql'` returned no matches).
- SQL-specific controls requested (N+1, transaction isolation, migration reversibility, index fit, lock hierarchy, timestamptz usage) are **not verifiable in this repository snapshot** because the DB layer is absent here.

## Phase 2 — Adversarial re-review
Rechecked all high-risk paths with explicit second pass emphasis on:
- Timeout/race/error boundaries (`src/mcp/client.ts`, `src/index.tsx`).
- File-system state consistency and cache behavior (`src/utils/settings-manager.ts`).
- Command sandbox constraints (`src/tools/bash.ts`).
- Config/dependency controls (`tsconfig.json`, `.eslintrc.js`, `package.json`).

No additional P0 issues were discovered beyond the timeout/idempotency gap above.

## Immediate incident ranking (deploy-today risk)
1. **P0: MCP timeout without remote idempotency/cancel acknowledgement** (`src/mcp/client.ts:283`).  
   **Blast radius:** Any mutating MCP tool call under packet loss/latency; duplicate irreversible external actions.
2. **P1: Settings stale-read under pending writes** (`src/utils/settings-manager.ts:188`, `:273`).  
   **Blast radius:** User/project configuration coherence across interactive sessions and concurrent writes.
3. **P1: Bash guardrail bypass via unbounded `-maxdepth` / `--max-count` values** (`src/tools/bash.ts:397`, `:404`).  
   **Blast radius:** Host resource exhaustion (CPU/IO), degraded service responsiveness.
4. **P1: Non-centralized process exits bypassing graceful shutdown** (`src/index.tsx:107`).  
   **Blast radius:** Partial cleanup and stuck external resources during failures.
