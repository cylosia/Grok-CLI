# Hostile Production Audit (Financial-Grade)

## Scope and verification method
- Repository inventory: `rg --files`.
- Type safety + lint + tests:
  - `npm run -s typecheck` ✅
  - `npm run -s lint` ✅
  - `npm test -s` ✅
- Dependency/security gate:
  - `npm run -s audit:ci` ⚠️ (registry returned `Forbidden` in this environment; no CVE verification available from this run).
- PostgreSQL/SQL surface detection:
  - `rg -n "\\b(pg|postgres|sql|SELECT|INSERT|UPDATE|DELETE|transaction|pool|knex|prisma|sequelize|typeorm)\\b" src test` returned no matches.

## Phase 1 — systematic decomposition findings

### Critical (P0)
- **None verified in this snapshot.**

### High (P1)

1. **File:Line:Column** `src/mcp/client.ts:205:43`  
   **Category** Type | Resilience  
   **Specific violation** `buildCallKey()` hashes `JSON.stringify({ name, args })` directly. If `args` contains `bigint` (or circular structures), `JSON.stringify` throws before timeout/cooldown logic runs, causing deterministic tool-call failure and bypassing intended error pathing.  
   **Concrete fix suggestion** Replace `JSON.stringify` with the same safe serializer pattern already used in `GrokAgent.safeSerializeToolData` (convert `bigint` to string and break circular refs), then hash serialized output.  
   **Risk if not fixed** Tool invocations can hard-fail on valid large integer payloads; retry loops above this layer can trigger incident-level request storms.

2. **File:Line:Column** `src/mcp/client.ts:261:28`  
   **Category** Async | Security | Architecture  
   **Specific violation** `Promise.race([callPromise, timeoutPromise])` times out locally but does not guarantee remote cancellation. The timed-out call can still execute side effects server-side while caller may retry after cooldown.  
   **Concrete fix suggestion** Add request-scoped cancellation contract: pass abort signal/request ID through transport, issue explicit cancel RPC on timeout, and mark non-idempotent tools as non-retriable unless cancellation acknowledgement is received.  
   **Risk if not fixed** Duplicate writes / non-idempotent side effects in MCP integrations under latency spikes.

3. **File:Line:Column** `src/mcp/url-policy.ts:120:50`  
   **Category** Security  
   **Specific violation** `allowLocalHttp` controls both local `http://` and private-network `https://` access. The env knob name (`GROK_ALLOW_LOCAL_MCP_HTTP`) suggests only HTTP loopback allowance, but current logic also permits private HTTPS endpoints.  
   **Concrete fix suggestion** Split flags: `allowLocalHttp` (loopback-only HTTP) and `allowPrivateHttps` (explicit, separate opt-in). Enforce explicit variable naming and migration warning for old behavior.  
   **Risk if not fixed** Operators can unintentionally widen SSRF/internal-network attack surface by enabling what appears to be a narrow HTTP-only override.

### Medium (P2)

4. **File:Line:Column** `src/index.tsx:47:13`  
   **Category** Resilience | Async  
   **Specific violation** Shutdown path waits on `Promise.allSettled(servers.map(removeServer))` without a global deadline. A hung server teardown can block process exit indefinitely during SIGTERM/SIGINT handling.  
   **Concrete fix suggestion** Add bounded shutdown deadline (e.g., 5s): race cleanup vs timer, log unfinished servers, then force exit with non-zero on timeout.  
   **Risk if not fixed** Stuck process during deploy/termination windows; orchestrator kill escalation and messy partial shutdown behavior.

5. **File:Line:Column** `src/agent/grok-agent.ts:73:1`  
   **Category** Architecture | Testability  
   **Specific violation** `GrokAgent` is a high-responsibility class (~500 lines) combining orchestration, tool dispatch, MCP init, memory/state, and streaming behaviors. This violates SRP and weakens test seam isolation.  
   **Concrete fix suggestion** Split into components (`ToolExecutor`, `ConversationState`, `McpLifecycle`, `ResponseStreamer`) behind interfaces and inject dependencies via constructor.  
   **Risk if not fixed** Regression risk scales nonlinearly with changes; incident fixes require broad retesting and increase mean time to recovery.

### Low (P3)

6. **File:Line:Column** `package.json:14:5`  
   **Category** Ops | Supply chain  
   **Specific violation** Security audit capability is present (`audit:ci`) but no lockfile policy/CI evidence in-repo enforces successful execution before release. In this environment, audit failed with `Forbidden`, leaving dependency risk opaque.  
   **Concrete fix suggestion** Add CI-required job that runs `npm ci && npm audit --audit-level=high` against an internal mirror; fail release builds on unresolved high/critical CVEs.  
   **Risk if not fixed** Critical dependency vulnerabilities can ship unnoticed.

## Phase 2 — adversarial re-review

Re-audited focus areas after first pass:
- "Obvious" code paths: URL policy, MCP timeout/error handling, process shutdown.
- Error/catch flows and teardown behavior in MCP manager.
- Config and policy files: `tsconfig.json`, `eslint.config.js`, `package.json`.
- Test coverage edge assumptions in MCP + bash + settings test suites.

Second-pass conclusion:
- No PostgreSQL implementation artifacts (queries, migrations, ORM schemas, pooling, transaction code) exist in this repo snapshot; SQL-specific findings are **N/A for current codebase contents**.
- Highest operational risks remain timeout/cancellation semantics and shutdown boundedness.

## Immediate incident ranking if deployed today (with blast radius)
1. **P1 – MCP timeout without real cancellation** (`src/mcp/client.ts:261`)  
   **Blast radius:** Any mutating MCP tool call under latency/degradation; can cause duplicate remote actions.
2. **P1 – `allowLocalHttp` also unlocks private HTTPS** (`src/mcp/url-policy.ts:120`)  
   **Blast radius:** Any environment with local override enabled; private network exposure/SSRF expansion.
3. **P1 – BigInt/circular crash in call-key hashing** (`src/mcp/client.ts:205`)  
   **Blast radius:** Tool invocation pipeline when payloads include large integers or structured objects.
4. **P2 – Unbounded shutdown wait on server teardown** (`src/index.tsx:47`)  
   **Blast radius:** All runtime modes during termination/redeploys.
