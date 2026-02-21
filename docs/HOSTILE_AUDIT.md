# Hostile Production Audit (TypeScript/PostgreSQL Readiness)

## Scope, decomposition method, and verification
- Full source/config inventory: `rg --files -g '*.ts' -g '*.tsx' -g '*.sql' -g 'package.json' -g 'tsconfig*.json' --glob '!node_modules/**'`.
- Pattern-driven pass over every TypeScript module + config files using `rg -n` for unsafe casts, timeout races, serialization, env usage, and async error boundaries.
- Adversarial second pass focused on timeout/catch/config/dependency paths.
- Validation checks executed:
  - `npm run -s typecheck` ✅
  - `npm run -s lint` ✅
  - `npm test -s` ✅
  - `npm run -s audit:ci` ⚠️ (`Forbidden` from registry in this environment, so CVE gate could not complete)

## Phase 1 — Systematic decomposition findings

### Critical (P0)
1. **File:Line:Column** `src/mcp/client.ts:280:9`  
   **Category:** Security | Async | Architecture  
   **Violation:** Tool calls use `Promise.race` timeout + local teardown, but no protocol-level cancellation/idempotency token is sent for an already-dispatched remote call. Timed-out call can still execute remotely, and retries can double-apply side effects.
   **Concrete fix:** Add request IDs and cancellation RPC on timeout; for non-cancelable tools require idempotency keys in arguments and server-side dedupe before retries.
   **Risk if not fixed:** Duplicate writes/external side effects during latency spikes; direct data-integrity incident potential.

### High (P1)
2. **File:Line:Column** `src/utils/settings-manager.ts:147:11`  
   **Category:** Architecture | Concurrency | Data Integrity  
   **Violation:** Writes are serialized by `writeQueue`, but reads (`loadUserSettings`/`loadProjectSettings`) are synchronous and do not await in-flight writes, so stale reads can be cached and re-used.
   **Concrete fix:** Make load paths async and await pending `writeQueue` before read+cache; alternatively add version stamp/check to reject stale cache writes.
   **Risk if not fixed:** Config rollback/stale-setting anomalies under concurrent operations.

3. **File:Line:Column** `src/utils/settings-manager.ts:82:1`  
   **Category:** Security | Data-at-rest  
   **Violation:** `writeJsonFileSyncAtomic` does not call `ensureSecureDirectory` and therefore does not remediate permissive existing directory mode before writing sensitive config flows.
   **Concrete fix:** Reuse `ensureSecureDirectory` equivalent in sync path (or remove sync writer entirely), then enforce file mode verification (`0o600`) post-write.
   **Risk if not fixed:** Secrets/settings can be exposed when `.grok` directory permissions were previously weak.

4. **File:Line:Column** `src/utils/logger.ts:62:5`  
   **Category:** Observability | Resilience  
   **Violation:** On serialization failure, logger emits a static fallback string, discarding context entirely.
   **Concrete fix:** Emit minimal sanitized metadata (message/component/correlationId + serialization error) instead of replacing with static constant.
   **Risk if not fixed:** Major forensic blind spot during production incidents.

### Medium (P2)
5. **File:Line:Column** `src/mcp/client.ts:223:3`  
   **Category:** Performance | Concurrency  
   **Violation:** In-flight dedupe key uses non-canonical JSON serialization (`safeSerializeForHash`) of `args`; semantically identical objects with different key insertion order hash differently.
   **Concrete fix:** Use `canonicalJsonStringify({name,args})` for `buildCallKey`.
   **Risk if not fixed:** Duplicate concurrent calls bypass dedupe and increase side-effect/rate-limit pressure.

6. **File:Line:Column** `src/commands/mcp.ts:106:13`  
   **Category:** Architecture | Resilience  
   **Violation:** Command action handlers call `process.exit(1)` directly from deep action code.
   **Concrete fix:** Throw structured errors to top-level CLI boundary and centralize shutdown/cleanup before process termination.
   **Risk if not fixed:** Hard exits can bypass future cleanup hooks and complicate composability/testing.

### Low (P3)
7. **File:Line:Column** `package.json:13:17`  
   **Category:** Ops | Supply chain  
   **Violation:** Security audit step exists but has no fallback mirror/offline policy, and fails closed in this environment.
   **Concrete fix:** Route audit/SBOM to authenticated internal mirror and gate release on that pipeline.
   **Risk if not fixed:** Dependency CVEs may escape release checks when registry access is constrained.

8. **File:Line:Column** `src/mcp/url-policy.ts:70:1`  
   **Category:** Security | Network policy  
   **Violation:** DNS rebinding check validates stability only at connect-time; there is no persistent pinning to resolved IP for transport lifetime.
   **Concrete fix:** For enabled remote transports, pin the validated address set for the session and revalidate on reconnect.
   **Risk if not fixed:** SSRF policy bypass risk re-emerges once HTTP/SSE transports are enabled.

## PostgreSQL/SQL surgery status
- No in-repo PostgreSQL query layer, migration files, or SQL files were present in this snapshot (`rg --files -g '*.sql'` returned none).
- Therefore SQL-specific checks (N+1, transaction isolation, index fit, migration safety, lock hierarchy) are **N/A by code absence** in this repository version.

## Phase 2 — Adversarial re-review
Re-examined:
- Timeout/cancellation and retry windows (`src/mcp/client.ts`).
- Catch/error paths and logger fallback behavior (`src/utils/logger.ts`, `src/index.tsx`).
- Settings persistence race/perms (`src/utils/settings-manager.ts`).
- Config/dependency controls (`package.json`, `tsconfig.json`, `eslint.config.js`).

No additional P0/P1 beyond the set listed above were discovered in the second pass.

## Immediate production-incident ranking (if deployed today)
1. **P0:** MCP timeout without remote cancellation (`src/mcp/client.ts:280`).  
   **Blast radius:** All mutating MCP tools under latency/packet loss; duplicate real-world side effects.
2. **P1:** Settings stale-read race with cached rollback (`src/utils/settings-manager.ts:147`).  
   **Blast radius:** Any concurrent config updates (model/server/settings drift across sessions).
3. **P1:** Settings directory permission hardening gap in sync writer (`src/utils/settings-manager.ts:82`).  
   **Blast radius:** Systems with permissive existing `.grok` permissions; sensitive configuration exposure.
4. **P1:** Logger context drop on serialization failure (`src/utils/logger.ts:62`).  
   **Blast radius:** Cross-cutting incident response degradation for all components.
