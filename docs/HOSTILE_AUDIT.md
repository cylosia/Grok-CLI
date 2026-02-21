# Hostile Production Audit (TypeScript/PostgreSQL Readiness)

## Scope and verification protocol
- File inventory pass:
  - `rg --files -g '*.ts' -g '*.tsx' -g '*.sql' -g 'package.json' -g 'tsconfig*.json' --glob '!node_modules/**'`
- High-risk static-pattern pass:
  - `rg -n "process\.exit\(|Promise\.race\(|JSON\.parse\(|spawn\(|as unknown as|AbortController|catch \(" src test`
- Large-file architecture pass:
  - `python` LOC scan for files >300 lines in `src/`
- Independent verification pass #1 (security + race conditions): timeout behavior, shutdown paths, command execution controls.
- Independent verification pass #2 (type/config/error-path): `tsconfig`, lint/typecheck posture, catch/rollback semantics.

Validation commands run:
- `npm run -s typecheck` ✅
- `npm run -s test:unit` ✅
- `npm audit --json` ⚠️ (`403 Forbidden` from npm audit endpoint in this environment)

## Phase 1 — Systematic decomposition findings

### Critical (P0)
1. **File:Line:Column** `src/mcp/client.ts:270:11`
   **Category:** Security | Async | Data Integrity
   **Violation:** Timeout handling marks calls as "remotely uncertain" and tears down transport locally, but there is no protocol-level idempotency token/cancel ACK in the outbound call payload. A timed-out mutating tool call can complete server-side and be retried later as a distinct call.
   **Concrete fix:** Inject a required `idempotencyKey` into every mutable MCP tool invocation and enforce server-side dedupe. Add explicit cancellation handshake/ack before allowing replay.
   **Risk if not fixed:** Duplicate side effects (e.g., repeated financial transactions or duplicated destructive operations) under latency/packet-loss conditions.

### High (P1)
2. **File:Line:Column** `src/hooks/use-input-handler.impl.ts:175:7` and `src/hooks/use-input-handler.impl.ts:307:7`
   **Category:** Resilience | Architecture
   **Violation:** UI command paths call `process.exit(0)` directly, bypassing centralized shutdown cleanup in `src/index.tsx`.
   **Concrete fix:** Replace both direct exits with a callback/event that routes through the shared `shutdown(...)` path in `index.tsx`.
   **Risk if not fixed:** Leaked MCP sessions, partially flushed state, and non-deterministic teardown behavior.

3. **File:Line:Column** `src/mcp/client.ts:45:11`
   **Category:** Performance | Reliability
   **Violation:** `remotelyUncertainCallKeys` is unbounded and only cleared when the **same** call later succeeds. In failure-heavy workloads with unique args, this set can grow indefinitely and permanently block retries for those keys.
   **Concrete fix:** Replace with bounded TTL cache (LRU + expiry), persist metadata (`firstSeen`, retryBudget), and provide manual/operator override to clear stale keys.
   **Risk if not fixed:** Gradual memory growth + accumulating "retry blocked" failures after transient incidents.

4. **File:Line:Column** `src/utils/settings-manager.ts:200:9` and `src/utils/settings-manager.ts:290:9`
   **Category:** Concurrency | Data Integrity
   **Violation:** `forceReload` still returns cached settings when writes are pending; callers requesting strong reload semantics can observe stale data.
   **Concrete fix:** Make `forceReload` path await `flushWrites()` before read, or reject with explicit `write in progress` error.
   **Risk if not fixed:** Stale reads and last-write-wins anomalies during concurrent config updates.

### Medium (P2)
5. **File:Line:Column** `src/utils/settings-manager.ts:151:3`
   **Category:** Performance | Architecture
   **Violation:** Synchronous filesystem calls (`existsSync`, `statSync`, `readFileSync`, `writeFileSync`, `renameSync`) are used on interactive execution paths.
   **Concrete fix:** Migrate to async fs APIs end-to-end and keep sync I/O only for startup-only bootstrap paths.
   **Risk if not fixed:** Event-loop stalls and degraded responsiveness under slow disk/NFS/container FS jitter.

6. **File:Line:Column** `src/hooks/use-input-handler.impl.ts:1:1`, `src/tools/text-editor.impl.ts:1:1`, `src/tools/search.ts:1:1`, `src/tools/bash.ts:1:1`
   **Category:** Architecture | SOLID
   **Violation:** Multiple "god files" well above 300 LOC with mixed responsibilities (input handling, command parsing, orchestration, side effects).
   **Concrete fix:** Split by responsibility boundaries (parsing/validation/execution/state transitions) and inject dependencies at module boundaries.
   **Risk if not fixed:** Higher defect density, brittle change impact, and poor test isolation.

### Low (P3)
7. **File:Line:Column** `src/index.tsx:75:3` and `src/index.tsx:83:3`
   **Category:** Observability | Reliability
   **Violation:** Global rejection/exception handlers log only message strings; stack traces and causal metadata are dropped.
   **Concrete fix:** Include sanitized stack + error name + cause chain fields in logger context.
   **Risk if not fixed:** Slower incident triage and weaker forensic debugging signal.

8. **File:Line:Column** `src/mcp/transports.ts:37:5`
   **Category:** Security | Operations
   **Violation:** Environment allowlist for stdio transport omits explicit timeout/guard envs; runtime execution policy is partially implicit.
   **Concrete fix:** Add explicit policy env contract (`MCP_TOOL_TIMEOUT_MS`, max output, child kill grace) and enforce at transport boundary.
   **Risk if not fixed:** Configuration drift and inconsistent process safety envelopes across deployments.

## PostgreSQL/SQL surgery status
- No PostgreSQL query layer, ORM model files, migration directory, or `.sql` files were found in this repository snapshot.
- SQL-specific checks requested (N+1, isolation levels, migration reversibility, index design, lock hierarchy, timestamptz correctness) cannot be verified without DB code/migrations.

## Phase 2 — Adversarial re-review
Re-ran second-pass review focused on:
- "Obvious" control flow and catch paths (`src/index.tsx`, `src/hooks/use-input-handler.impl.ts`).
- Timeout/race semantics (`src/mcp/client.ts`).
- Config/tooling drift (`package.json`, `tsconfig.json`, `eslint.config.js`).

No new P0 findings were added beyond the timeout/idempotency gap.

## Immediate incident ranking (deploy-today)
1. **P0: Timeout without protocol idempotency/cancel ack** (`src/mcp/client.ts:270`).
   - **Blast radius:** Any mutating MCP integration under network instability; potential duplicate real-world side effects.
2. **P1: Direct process exits bypassing cleanup** (`src/hooks/use-input-handler.impl.ts:175`, `:307`).
   - **Blast radius:** Entire CLI session lifecycle; leaked external sessions and inconsistent shutdown.
3. **P1: Unbounded remotely uncertain call key growth** (`src/mcp/client.ts:45`).
   - **Blast radius:** Long-lived processes under failure/retry storms; memory pressure and permanent retry denial for affected operations.
4. **P1: `forceReload` stale-read semantics** (`src/utils/settings-manager.ts:200`, `:290`).
   - **Blast radius:** Configuration correctness across concurrent operations.


## Remediation status
- P0 through P3 findings from this report have been remediated in code, including MCP timeout quarantine hardening, graceful UI exit routing, bounded uncertain-call tracking, force-reload write-pending guards, enriched crash logging context, and explicit MCP transport policy env defaults.
