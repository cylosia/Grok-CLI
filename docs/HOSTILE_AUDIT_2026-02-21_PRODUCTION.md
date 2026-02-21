# Hostile Production Audit (TypeScript/PostgreSQL checklist)

Date: 2026-02-21
Scope: Entire repository (`src`, `test`, root config)
Method: Two-pass hostile review (initial pass + adversarial re-check on configs, error paths, and obvious code).

## Phase 1 + Phase 2 Findings

### Critical (P0)

1. **File: `src/utils/runtime-config.ts:18:23` + `src/grok/client.ts:140:16`**  
   **Category:** Security | Type  
   **Violation:** `GROK_BASE_URL` from environment is accepted verbatim in `loadRuntimeConfig()` and passed directly into the OpenAI client constructor without applying `sanitizeAndValidateBaseUrl()`. This bypasses the project’s own private-network and scheme restrictions.  
   **Concrete fix:** In `loadRuntimeConfig()`, replace direct `readEnvString("GROK_BASE_URL")` pass-through with `sanitizeAndValidateBaseUrl(...)` from `settings-manager` (or move sanitizer to dedicated module to avoid circular deps). Then reject invalid values at process startup.  
   **Risk if not fixed:** SSRF/egress-policy bypass. In compromised runtime/env-injection scenarios, requests can be redirected to internal services/metadata endpoints or attacker-controlled collectors.

### High (P1)

2. **File: `src/mcp/client.ts:226:11`**  
   **Category:** Architecture | Async/Concurrency  
   **Violation:** `teardownServerWithTimeout()` uses `Promise.race()` with a timeout but does not cancel the underlying teardown operation. If `client.close()`/`transport.disconnect()` hangs, function returns after timeout while teardown continues in background and may never complete; server map cleanup may not happen promptly.  
   **Concrete fix:** Track teardown state with an `AbortController`/hard kill transport mechanism, and on timeout explicitly remove map entry + mark server quarantined. Add timeout telemetry and forced transport process termination path.  
   **Risk if not fixed:** Connection/resource leaks, stuck server entries, degraded availability under repeated timeout events.

3. **File: `src/mcp/client.ts:312:11`**  
   **Category:** Resilience | Async/Concurrency  
   **Violation:** Timeout path calls `teardownServerWithTimeout(serverName)` from inside timer callback while the original call is still active; concurrent teardown and call completion can race. No per-server teardown lock is used.  
   **Concrete fix:** Introduce per-server mutex/once-guard for teardown operations and make `callTool` observe teardown state to fail fast deterministically.  
   **Risk if not fixed:** Rare but high-impact race windows under load/timeouts (double-close errors, stale state, inconsistent tool availability).

### Medium (P2)

4. **File: `tsconfig.json:3:3`**  
   **Category:** Type  
   **Violation:** Strict mode is enabled, but `noUncheckedIndexedAccess` is not enabled. For financial-grade code this leaves indexed access (`arr[i]`, `obj[key]`) overly optimistic and allows undefined-at-runtime bugs to evade compile-time checks.  
   **Concrete fix:** Set `"noUncheckedIndexedAccess": true` and remediate resulting compile errors with explicit guards/defaulting.  
   **Risk if not fixed:** Latent undefined dereference bugs in edge cases, especially in parser/result-processing code.

5. **File: `src/grok/model-discovery.ts:20:5` and `src/grok/model-discovery.ts:40:5`**  
   **Category:** Resilience | Observability  
   **Violation:** Catch-all fallbacks swallow upstream/network errors silently when model discovery fails. No structured logging is emitted, reducing incident diagnosability and masking config/security failures.  
   **Concrete fix:** Log sanitized failure context (`endpoint`, `error class`, `status`) before fallback return; include correlation ID from logger context.  
   **Risk if not fixed:** Silent degraded behavior and delayed detection during production outages or endpoint tampering.

6. **File: `package.json:19:5`**  
   **Category:** Deployment/Ops | Supply Chain  
   **Violation:** No `engines` constraint for Node/npm runtime. Financial-grade deployments need deterministic runtime boundaries to avoid subtle runtime/crypto behavior drift and dependency-install divergence.  
   **Concrete fix:** Add `"engines": { "node": "<supported range>", "npm": "<supported range>" }` and enforce in CI.  
   **Risk if not fixed:** Non-reproducible builds and environment-specific failures in production.

### Low (P3)

7. **File: `src/utils/logger.ts:8:28`**  
   **Category:** Security | Observability  
   **Violation:** Key-pattern redaction is broad but still heuristic; secrets embedded in non-matching keys/opaque blobs may pass through.  
   **Concrete fix:** Add explicit allowlist logging for high-risk contexts or default-redact unknown large strings; expand test corpus for token formats.  
   **Risk if not fixed:** Occasional PII/secret leakage in logs during unusual payload shapes.

8. **File: repository-wide (validated via search)**  
   **Category:** SQL/Architecture  
   **Violation:** No PostgreSQL/SQL layer found in the scanned codebase, so DB-specific controls (transactions, migrations, indexes, isolation levels, FK policies) cannot be audited in-repo.  
   **Concrete fix:** If DB layer exists externally, include it in the audit scope (migrations, schema DDL, query layer, pool config).  
   **Risk if not fixed:** Unknown data-integrity and performance risks in out-of-scope components.

## Immediate Incident Ranking (if deployed today)

1. **P0 SSRF/baseURL validation bypass** (`runtime-config` -> `grok/client`)  
   **Blast radius:** All outbound model API traffic for any process started with tainted env vars.
2. **P1 MCP teardown timeout leak/race** (`mcp/client`)  
   **Blast radius:** Any host using MCP integrations under timeout/error conditions; can degrade whole CLI session reliability.
3. **P1 Concurrent teardown race** (`mcp/client`)  
   **Blast radius:** Timeout-heavy or flaky MCP servers; intermittent hard-to-reproduce outages.

## Verification Notes

- Pass A: file-level review of runtime config, MCP transport/client, logging, search, settings.
- Pass B (adversarial re-check): focused revisit of config files (`tsconfig`, `eslint`, `package.json`), catch blocks, timeout/error paths.
- Repository contains existing audit docs; findings above were independently re-validated against current source lines.
