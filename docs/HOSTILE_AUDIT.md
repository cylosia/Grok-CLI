# Hostile Production Audit (TypeScript/PostgreSQL Readiness)

## Scope and verification protocol
- Repository decomposition pass:
  - `rg --files src test *.json *.js docs`
- Type/config/test hardening pass:
  - `npm run -s typecheck`
  - `npm run -s lint`
  - `npm run -s test:unit`
- Security/static grep pass:
  - `rg -n "process\.exit|process\.kill|spawn\(|JSON\.parse\(|as unknown as|AbortController|Promise\.race|catch \(" src test`
- Architecture pass (large-file SRP risk):
  - Python LOC scan for files >300 lines in `src/`
- Dependency advisory pass:
  - `npm audit --json` (environment returned `403 Forbidden`)

Validation summary:
- Typecheck: pass
- Lint: pass
- Unit tests: pass
- npm audit: unavailable in this environment (403)

## Phase 1 — Systematic decomposition findings

### Critical (P0)
1. **File:Line:Column** `src/mcp/transports.ts:51:7`
   **Category:** Security | Architecture
   **Violation:** `StdioTransport` applies a **blacklist** (`PROTECTED_ENV_KEYS`) rather than an allowlist to `config.env`, so arbitrary process-impacting environment variables (e.g., `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, language runtime hooks) can be injected into spawned MCP subprocesses.
   **Concrete fix:** Replace blacklist merging with strict allowlist (e.g., `MCP_*` and explicitly sanctioned app vars only), and reject any unknown env key with a hard error.
   **Risk if not fixed:** High-impact local code execution surface expansion and policy bypass in a financial workstation context where MCP server configuration may come from imported/shared config snippets.

### High (P1)
2. **File:Line:Column** `src/mcp/client.ts:44:11` and `src/mcp/client.ts:319:11`
   **Category:** Performance | Resilience
   **Violation:** `timedOutCallCooldownUntil` grows without global pruning; entries are removed only if the *same key* is checked again. In failure storms with unique call signatures, this map can leak memory over process lifetime.
   **Concrete fix:** Add TTL-based pruning for `timedOutCallCooldownUntil` (mirroring `remotelyUncertainCallKeys`) and cap map size using LRU eviction.
   **Risk if not fixed:** Gradual memory pressure and degraded stability in long-lived sessions under flaky network/tool conditions.

3. **File:Line:Column** `src/mcp/client.ts:353:28`
   **Category:** Async | Data Integrity
   **Violation:** Timeout mitigation quarantines and teardown are local-only controls; there is no protocol-level idempotency key attached to mutating MCP tool calls.
   **Concrete fix:** Extend call payload contract to include `idempotencyKey` for mutating operations and require MCP server-side dedupe/at-most-once semantics.
   **Risk if not fixed:** Duplicate side effects during timeout/retry windows (financially material if tools trigger irreversible external actions).

### Medium (P2)
4. **File:Line:Column** `src/utils/settings-manager.ts:151:3`
   **Category:** Performance | Architecture
   **Violation:** Sync filesystem operations (`existsSync`, `statSync`, `readFileSync`, `writeFileSync`, `renameSync`) are used on runtime code paths, not startup-only bootstrapping.
   **Concrete fix:** Convert `readJsonFile` and initial write paths to async I/O and propagate async loading APIs to call sites.
   **Risk if not fixed:** Event-loop stalls under slow or contended filesystems, causing UI responsiveness degradation and delayed signal handling.

5. **File:Line:Column** `src/hooks/use-input-handler.impl.ts:1:1`, `src/tools/text-editor.impl.ts:1:1`, `src/tools/search.ts:1:1`, `src/tools/bash.ts:1:1`, `src/agent/grok-agent.ts:1:1`
   **Category:** Architecture
   **Violation:** Multiple >300-line files with mixed concerns (parsing, orchestration, side effects, UI state transitions), indicating SRP erosion and high blast radius per change.
   **Concrete fix:** Split each into bounded modules (command parsing, execution adapters, state machine, presentation hooks) with explicit dependency injection seams.
   **Risk if not fixed:** Rising regression probability, difficult targeted tests, and prolonged incident MTTR.

### Low (P3)
6. **File:Line:Column** `package.json:11:5`
   **Category:** Security | Operations
   **Violation:** CI audit fallback (`audit:ci`) degrades to SBOM generation when npm audit is unavailable, but does not fail closed for known-advisory blind spots in disconnected/blocked registries.
   **Concrete fix:** Add secondary offline advisory scanner (or pinned advisory snapshot) and make security gate explicit (fail release when advisory feed is unavailable beyond a short SLA).
   **Risk if not fixed:** Silent exposure window for vulnerable dependencies when upstream advisory endpoint is intermittently unreachable.

## PostgreSQL / SQL surgery status
- No PostgreSQL driver usage, SQL query layer, migration directory, or `.sql` files were detected in this repository snapshot.
- Requested SQL checks (N+1, isolation level correctness, migration safety, indexes, lock ordering, timestamptz correctness) are **not verifiable** without database code artifacts.

## Phase 2 — Adversarial re-review
Second pass specifically rechecked:
- “Obvious-safe” areas (`src/mcp/client.ts`, `src/mcp/transports.ts`) for timeout/env bypass edge cases.
- Error-path behavior in catch/finally blocks and process shutdown routing.
- Config posture (`tsconfig.json`, `eslint.config.js`, `package.json`) for guardrail drift.

No additional P0 beyond env-injection surface was found in this pass.

## Immediate incident ranking (deploy-today)
1. **P0** — Arbitrary env-key injection into MCP stdio child process (`src/mcp/transports.ts:51`).
   - **Blast radius:** Any host executing configured MCP servers; potential process behavior hijack and policy bypass.
2. **P1** — Timeout/retry without protocol idempotency (`src/mcp/client.ts:353`).
   - **Blast radius:** Any mutating MCP tool operation during partial-failure conditions.
3. **P1** — Unbounded cooldown map growth (`src/mcp/client.ts:44`, `:319`).
   - **Blast radius:** Long-lived sessions under retry storms; memory/perf degradation.
4. **P2** — Sync settings I/O on runtime path (`src/utils/settings-manager.ts`).
   - **Blast radius:** UI responsiveness and runtime latency under FS jitter.
