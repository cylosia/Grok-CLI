# Hostile Production Audit (Financial-Grade)

## Scope and verification method
- Repository inventory: `rg --files`.
- Type safety + lint + tests:
  - `npm run -s typecheck` ✅
  - `npm run -s lint` ✅
  - `npm test -s` ✅
- Dependency/security gate:
  - `npm run -s audit:ci` ⚠️ (registry denied access with `E403`, so CVE verification is incomplete in this environment).
- PostgreSQL/SQL surface detection:
  - `rg -n "\b(pg|postgres|sql|SELECT|INSERT|UPDATE|DELETE|transaction|pool|knex|prisma|sequelize|typeorm)\b" src test` returned no in-repo PostgreSQL implementation.

## Phase 1 — systematic decomposition findings

### Critical (P0)
1. **File:Line:Column** `src/mcp/client.ts:280:28`  
   **Category** Security | Async | Architecture  
   **Specific violation** `Promise.race([callPromise, timeoutPromise])` times out locally, tears down local transport, and rejects, but does not send protocol-level cancellation for the already-dispatched remote tool invocation. This creates a check-then-retry window where non-idempotent remote side effects can execute multiple times.  
   **Concrete fix suggestion** Add MCP request IDs + explicit cancel RPC on timeout, and treat all non-idempotent tools as non-retriable until cancellation acknowledgement arrives. For tools lacking cancel support, enforce idempotency keys in `args` and server-side dedupe.  
   **Risk if not fixed** Duplicate state mutations (e.g., writes, external actions) under latency spikes; incident class: data integrity/security breach in connected systems.

### High (P1)
2. **File:Line:Column** `src/commands/mcp.ts:57:43` + `src/mcp/client.ts:62:35`  
   **Category** Security | Availability  
   **Specific violation** Server trust fingerprinting uses `JSON.stringify` of mutable object graphs; semantically identical configurations with reordered object keys produce different hashes. Manual edits or serializer differences can brick trusted servers as “untrusted.”  
   **Concrete fix suggestion** Replace ad-hoc `JSON.stringify` with deterministic canonical JSON serialization (stable key sorting at every object level) before hashing, and include an explicit fingerprint schema version.  
   **Risk if not fixed** False trust failures during restart/deploy and production outage for MCP-dependent workflows.

3. **File:Line:Column** `src/utils/settings-manager.ts:149:17` + `src/utils/settings-manager.ts:290:11`  
   **Category** Concurrency | Data Integrity  
   **Specific violation** Reads are synchronous and unsynchronized while writes are queued asynchronously. A read during queued write can observe stale data and immediately cache it (`userSettingsCache` / `projectSettingsCache`), creating last-writer-wins anomalies and stale config reuse windows.  
   **Concrete fix suggestion** Serialize both reads and writes through a single async lock/queue per settings file (or use atomic version checks before cache replacement). On read, await pending write queue first.  
   **Risk if not fixed** Intermittent configuration rollback behavior (model/env/MCP config drift), especially under concurrent command execution.

4. **File:Line:Column** `src/utils/logger.ts:35:15`  
   **Category** Observability | Resilience  
   **Specific violation** Logger serialization does not handle `bigint`; `JSON.stringify` throws and logger falls back to a generic static line (`logger-serialization-failed`) losing original event payload at exactly the time high-fidelity telemetry is needed.  
   **Concrete fix suggestion** Extend `safeJsonStringify` replacer to serialize `bigint` as string and preserve a truncated sanitized payload even on serialization failure.  
   **Risk if not fixed** Incident debugging blind spots and delayed containment/forensics.

### Medium (P2)
5. **File:Line:Column** `src/agent/grok-agent.ts:35:1`  
   **Category** Architecture | Testability  
   **Specific violation** `GrokAgent` remains a large orchestration class combining model I/O, tool execution, MCP lifecycle, memory, and streaming concerns. This violates SRP and weakens defect isolation.  
   **Concrete fix suggestion** Extract `ToolExecutionService`, `McpLifecycleService`, and `ConversationCoordinator` interfaces; inject them into a thin agent facade.  
   **Risk if not fixed** Elevated regression probability and slower incident patch velocity.

6. **File:Line:Column** `src/tools/bash.ts:279:29`  
   **Category** Security | Performance  
   **Specific violation** Argument policy validates path-like arguments but does not bound glob/cardinality-heavy operations (`find . -type f`, broad `rg`/`grep`) beyond output truncation; expensive scans can still saturate CPU/IO despite capped output bytes.  
   **Concrete fix suggestion** Add execution policy guards: max directory depth, max file count, and command-specific safe defaults (`rg --max-filesize`, optional `--max-count`) with explicit opt-in overrides.  
   **Risk if not fixed** Resource exhaustion and degraded interactive latency under malicious or accidental broad commands.

### Low (P3)
7. **File:Line:Column** `eslint.config.js:24:7`  
   **Category** Quality Gate | Security hygiene  
   **Specific violation** Lint rules enforce TS rigor but omit security-focused rulesets (no taint/source-sink linting, no regexp DOS checks, no hardcoded secret detection).  
   **Concrete fix suggestion** Add security lint profile (e.g., eslint-plugin-security + custom banned-pattern rules) to CI fail gates.  
   **Risk if not fixed** Preventable classes of security defects rely entirely on manual review.

8. **File:Line:Column** `package.json:12:5`  
   **Category** Ops | Supply chain  
   **Specific violation** `audit:ci` exists but cannot enforce in this runtime due registry auth; no in-repo documented fallback (mirror/SBOM/signature policy) is present.  
   **Concrete fix suggestion** Enforce `npm ci --ignore-scripts && npm audit --audit-level=high` against an authenticated internal mirror in release CI, and publish an SBOM artifact.  
   **Risk if not fixed** Critical dependency CVEs can pass release unnoticed.

## Phase 2 — adversarial re-review
- Re-checked “obvious” areas: timeout/cancellation paths (`src/mcp/client.ts`), trust hashing (`src/commands/mcp.ts`, `src/mcp/client.ts`), and settings persistence (`src/utils/settings-manager.ts`).
- Re-checked error paths/catch blocks and global process handlers (`src/index.tsx`, `src/utils/logger.ts`).
- Re-checked configs and dependency controls (`tsconfig.json`, `eslint.config.js`, `package.json`).

### Phase 2 conclusion
- No PostgreSQL code artifacts are present in this repository snapshot; all SQL-specific findings requested are **N/A by code absence**.
- The highest-risk production incidents today are around MCP timeout semantics and trust/config consistency.

## Immediate production-incident ranking (if deployed as-is)
1. **P0 — Timeout without remote cancellation** (`src/mcp/client.ts:280`)  
   **Blast radius:** All mutating MCP tool integrations under network degradation; duplicate external side effects possible.
2. **P1 — Non-deterministic trust fingerprints** (`src/commands/mcp.ts:57`, `src/mcp/client.ts:62`)  
   **Blast radius:** Any environment where MCP server config is edited/reformatted; startup/connectivity failures.
3. **P1 — Settings read/write race windows** (`src/utils/settings-manager.ts:149`, `src/utils/settings-manager.ts:290`)  
   **Blast radius:** CLI sessions issuing concurrent config updates; stale/rolled-back settings behavior.
4. **P1 — Logger bigint serialization blind spot** (`src/utils/logger.ts:35`)  
   **Blast radius:** Cross-cutting incident observability whenever bigint enters structured logs.
