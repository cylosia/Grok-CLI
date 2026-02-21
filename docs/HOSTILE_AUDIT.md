# Hostile Production Audit (Financial-Grade)

## Scope and verification
- Repository walk: `rg --files`
- Static checks executed:
  - `npm run -s typecheck` ✅
  - `npm run -s lint` ✅
  - `npm test --silent` ✅
  - `npm audit --audit-level=high` ⚠️ (registry endpoint returned 403 in this environment)
- Focused file-by-file hostile pass across runtime-critical paths:
  - Agent loop + tool orchestration: `src/agent/*.ts`, `src/grok/*.ts`
  - Tooling sandbox and filesystem mutation paths: `src/tools/*.ts`
  - MCP and URL trust boundaries: `src/mcp/*.ts`
  - Persistence and config surfaces: `src/utils/settings-manager.ts`, `tsconfig.json`, `eslint.config.js`, `package.json`

## PostgreSQL / SQL surgery status
No PostgreSQL driver, SQL query layer, migrations, or schema files are present in this repository snapshot. SQL-specific checks are not applicable for this codebase revision.

---

## PHASE 1 — Systematic decomposition findings

### Critical (P0)
- **None verified in current revision.**

### High (P1)

1. **File:Line:Column:** `src/agent/grok-agent.ts:233:31`, `src/agent/grok-agent.ts:334:35`  
   **Category:** Type | Reliability  
   **Violation:** Tool output serialization uses raw `JSON.stringify(result.data || {})` in hot paths. If a tool returns `bigint` or circular structures, serialization throws and breaks message processing.  
   **Concrete fix:** Replace with hardened serializer (e.g., replacer that stringifies bigint and handles circular refs) and fallback text (`"[unserializable tool payload]"`) when serialization fails.  
   **Risk if not fixed:** Tool calls can crash a user turn under realistic payloads, causing dropped responses and session-level incident behavior.

2. **File:Line:Column:** `src/mcp/client.ts:216:24-221:12`  
   **Category:** Async | Resilience  
   **Violation:** MCP timeout promise rejects only after `teardownPromise.finally(...)` runs; if teardown itself stalls, timeout rejection can stall indefinitely.  
   **Concrete fix:** Reject immediately on timeout (`reject(...)` first), then perform teardown in background (`void this.teardownServer(...)`) with independent logging and capped teardown timeout.  
   **Risk if not fixed:** Hung MCP tool calls can still hang the caller despite timeout policy, degrading responsiveness and exhausting concurrent work slots.

### Medium (P2)

3. **File:Line:Column:** `src/utils/settings-manager.ts:161:9`, `173:9`, `247:9`  
   **Category:** Data Integrity | Error Handling  
   **Violation:** Startup/default persistence writes are launched with `void this.enqueueWrite(...)`; failures are only logged, not surfaced to callers at call site.  
   **Concrete fix:** `await` these writes during bootstrap paths, or expose explicit initialization routine that fails hard when default settings cannot be persisted.  
   **Risk if not fixed:** Silent config persistence failures (especially first-run) cause nondeterministic behavior across sessions.

4. **File:Line:Column:** `src/mcp/transports.ts:28:11`, `76:9`  
   **Category:** Resource | Architecture  
   **Violation:** `StdioTransport.process` is never assigned but is referenced in `disconnect()`, creating dead cleanup logic and uncertain child-process lifecycle assumptions.  
   **Concrete fix:** Either remove `process` member entirely and rely on SDK close semantics, or wire actual process handle ownership and enforce kill+wait semantics in disconnect.  
   **Risk if not fixed:** Process lifecycle bugs become difficult to reason about and can leak subprocesses under transport edge failures.

5. **File:Line:Column:** `src/mcp/url-policy.ts:74:29-87:25`  
   **Category:** Security | Network boundary  
   **Violation:** URL validation resolves DNS once and returns a string, but connection layer does not pin resolved IP; DNS rebinding remains possible between validation and connect in designs that later enable HTTP/SSE transports.  
   **Concrete fix:** Bind validation to connection by pinning resolved addresses (or revalidating at connect against actual socket endpoint), and cache validation for a short TTL.  
   **Risk if not fixed:** SSRF/private-network bypass risk when currently-disabled HTTP/SSE transports are re-enabled.

### Low (P3)

6. **File:Line:Column:** `package.json:1:1` + lockfiles  
   **Category:** Supply-chain hygiene  
   **Violation:** Repository contains both `package-lock.json` and `bun.lock`; without explicit policy enforcement this can introduce dependency drift across CI/dev environments.  
   **Concrete fix:** Standardize package manager in CI (e.g., npm-only) and fail builds when non-canonical lockfile changes diverge.  
   **Risk if not fixed:** Non-reproducible installs and hard-to-reproduce production discrepancies.

---

## PHASE 2 — Adversarial re-review (assume first pass missed bugs)

Re-audited with targeted skepticism over:
- “Obvious” happy paths: streaming and non-streaming tool result plumbing.
- Catch/finally paths: MCP timeout handling and settings write queue.
- Config surfaces: strictness and dependency hygiene in `tsconfig.json`, `eslint.config.js`, `package.json`.

### Phase-2 confirmations
- Serialization and timeout semantics remain the highest-risk runtime failure vectors.
- Settings bootstrap writes still trade durability visibility for convenience.
- Transport lifecycle ownership remains ambiguous in stdio wrapper code.

---

## Immediate production-incident ranking (if deployed today)

1. **Tool payload serialization crash (`grok-agent`)** — broad blast radius across any tool-enabled chat path; single malformed payload can break user turn completion.
2. **MCP timeout not fail-fast (`mcp/client`)** — blast radius across MCP-backed features; hung calls can accumulate and degrade overall responsiveness.
3. **Silent settings bootstrap write failures (`settings-manager`)** — blast radius on startup/config consistency; repeated “works on one machine” operational incidents.
