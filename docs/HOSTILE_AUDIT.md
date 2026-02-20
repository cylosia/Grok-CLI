# Hostile Production Audit (TypeScript/PostgreSQL)

## Scope and verification protocol
- **Pass A (mechanical):** enumerated repository files and ran focused static scans for risky patterns (type assertions, process control, child_process use, JSON parsing, promise boundaries).
- **Pass B (adversarial):** re-opened high-risk modules (`mcp/*`, `tools/*`, `utils/*`, entrypoint/config) and specifically re-checked catch paths and "obvious" code.
- **Production checks executed:**
  - `npm run -s typecheck` (passed)
  - `npm run -s audit:ci` (blocked by environment: `Forbidden`)
- **PostgreSQL note:** no PostgreSQL driver, migration system, SQL query layer, or schema artifacts exist in this codebase; SQL surgery checks are therefore not directly applicable.

---

## Phase 1 — Systematic decomposition findings

### Critical (P0)

1. **HTTP/SSE MCP transports are request-only and do not implement response ingestion**
   - **File:Line:Column:** `src/mcp/transports.ts:181:3`, `src/mcp/transports.ts:186:7`, `src/mcp/transports.ts:210:3`, `src/mcp/transports.ts:217:7`
   - **Category:** Architecture|Async
   - **Violation:** `HttpClientTransport.send()` and `SSEClientTransport.send()` fire POSTs but never convert server responses/events into MCP protocol messages emitted back to the SDK transport consumer. This breaks request/response semantics for non-stdio transports.
   - **Concrete fix:** Replace custom HTTP/SSE transport stubs with SDK-supported transport implementations (or implement full duplex protocol: parse responses, emit `message` events, and wire lifecycle hooks).
   - **Risk if not fixed:** Remote MCP tooling over HTTP/SSE will fail or hang unpredictably in production, causing tool-call outages.

### High (P1)

2. **Unbounded ripgrep output buffering can exhaust process memory**
   - **File:Line:Column:** `src/tools/search.ts:207:11`, `src/tools/search.ts:210:7`, `src/tools/search.ts:214:7`
   - **Category:** Performance|Resilience
   - **Violation:** `executeRipgrep()` concatenates all stdout/stderr into unbounded strings. Broad queries on large repos can consume hundreds of MBs+ and trigger OOM.
   - **Concrete fix:** Enforce output caps (byte budget), stream-parse JSON lines incrementally, and terminate child process once cap/max-results is reached.
   - **Risk if not fixed:** Under heavy searches, CLI crashes or becomes non-responsive.

3. **MCP initialization failure causes repeated reconnect storms**
   - **File:Line:Column:** `src/mcp/client.ts:117:3`, `src/mcp/client.ts:134:5`, `src/grok/tools.ts:329:3`, `src/grok/tools.ts:332:5`
   - **Category:** Async|Resilience
   - **Violation:** `initialized` flips true **only** if all servers initialize successfully. Any persistent single-server failure makes every subsequent `getAllGrokTools()` retry all failed endpoints.
   - **Concrete fix:** Track per-server init state and cooldown/backoff (`lastFailureAt`, `retryAfter`) instead of global all-or-nothing initialization.
   - **Risk if not fixed:** log flooding, repeated failed network/process attempts, degraded latency.

4. **Timeout path does not forcefully reap subprocesses**
   - **File:Line:Column:** `src/tools/bash.ts:134:7`, `src/tools/bash.ts:136:9`
   - **Category:** Async|Performance
   - **Violation:** timed-out commands are sent `SIGTERM` only; no follow-up `SIGKILL` if process ignores termination.
   - **Concrete fix:** after grace period (e.g., 1–2s), send `SIGKILL` and finalize with deterministic timeout error.
   - **Risk if not fixed:** orphaned/stranded processes accumulate, consuming CPU/memory and file descriptors.

5. **CLI returns success exit code on failed prompt execution**
   - **File:Line:Column:** `src/index.tsx:76:5`, `src/index.tsx:82:5`
   - **Category:** Architecture|Resilience
   - **Violation:** CLI mode logs error in catch block but exits with `process.exit(0)`.
   - **Concrete fix:** set non-zero exit code on failure (`process.exitCode = 1` or `process.exit(1)` in error path).
   - **Risk if not fixed:** CI/automation cannot detect failures, causing silent bad deploy/ops decisions.

### Medium (P2)

6. **Weak transport parsing silently downgrades invalid values to `stdio`**
   - **File:Line:Column:** `src/commands/mcp.ts:21:1`, `src/commands/mcp.ts:25:3`
   - **Category:** Type|Security
   - **Violation:** `parseTransportType()` defaults unknown values to `stdio` rather than rejecting input.
   - **Concrete fix:** throw on unknown transport value and surface an actionable validation error.
   - **Risk if not fixed:** operator intent mismatch; accidental execution of local commands when remote transport was intended.

7. **Legacy fallback path bypasses central URL validation flow in one branch**
   - **File:Line:Column:** `src/commands/mcp.ts:153:9`, `src/commands/mcp.ts:178:15`
   - **Category:** Security|Type
   - **Violation:** parsed JSON config accepts nested transport objects and only conditionally validates URL depending on shape; malformed mixed payloads can create confusing partially-validated states.
   - **Concrete fix:** normalize raw config into a strict schema first (single parse/validate function) and only construct `MCPServerConfig` from validated output.
   - **Risk if not fixed:** edge-case config injection and inconsistent transport behavior.

8. **Synchronous FS operations in settings manager block event loop**
   - **File:Line:Column:** `src/utils/settings-manager.ts:61:21`, `src/utils/settings-manager.ts:75:7`, `src/utils/settings-manager.ts:81:5`
   - **Category:** Performance
   - **Violation:** hot-path settings load/save uses sync IO (`readFileSync`, `writeFileSync`, `renameSync`, `fsyncSync`).
   - **Concrete fix:** migrate to `fs/promises` with same atomic temp-file strategy.
   - **Risk if not fixed:** interactive latency spikes on slow disks or remote filesystems.

### Low (P3)

9. **Non-exhaustive string IDs across trust/queue/tool boundaries**
   - **File:Line:Column:** `src/mcp/client.ts:8:3`, `src/utils/confirmation-service.ts:20:3`, `src/grok/client.ts:6:3`
   - **Category:** Type
   - **Violation:** high-value IDs (`server name`, `request id`, `tool call id`) are plain strings; accidental cross-assignment can compile.
   - **Concrete fix:** introduce branded nominal types (`type ServerName = string & {__brand:'ServerName'}` etc.) at API boundaries.
   - **Risk if not fixed:** latent wiring bugs survive compile-time checks.

10. **Catch blocks lose forensic detail in multiple operational paths**
   - **File:Line:Column:** `src/tools/search.ts:257:7`, `src/ui/utils/markdown-renderer.tsx:17:3`, `src/grok/tools.ts:331:3`
   - **Category:** Observability|Resilience
   - **Violation:** errors are swallowed or reduced to coarse strings without structured context.
   - **Concrete fix:** route all catches through structured logger with operation metadata and sanitized error payload.
   - **Risk if not fixed:** slower incident triage and poor root-cause attribution.

---

## Phase 2 — Adversarial re-check

### Re-examined targets
- `package.json`, `tsconfig.json`, `tsconfig.strict.json` (config drift/strictness/dependency surface)
- "Obvious" modules likely to be trusted too quickly: `src/index.tsx`, `src/mcp/transports.ts`, `src/mcp/client.ts`, `src/tools/search.ts`, `src/tools/bash.ts`
- error-heavy paths (`catch`, retry, timeout, process shutdown)

### Immediate production-incident ranking
1. **P0 — Broken HTTP/SSE MCP transport semantics** (`src/mcp/transports.ts`): remote MCP tool ecosystem can be effectively non-functional. **Blast radius:** all users depending on non-stdio MCP servers.
2. **P1 — Unbounded ripgrep buffering** (`src/tools/search.ts`): memory blowups on large repos. **Blast radius:** users running broad/recursive searches.
3. **P1 — MCP reconnect storm behavior** (`src/mcp/client.ts`, `src/grok/tools.ts`): repeated failed initialization can degrade every request path. **Blast radius:** all sessions with at least one bad MCP server entry.
4. **P1 — Timeout without hard kill** (`src/tools/bash.ts`): lingering processes can poison long-running sessions/agents. **Blast radius:** users issuing commands that ignore SIGTERM.
5. **P1 — false-success process exit code** (`src/index.tsx`): automation treats failures as success. **Blast radius:** CI/CD pipelines and scripted wrappers.

## PostgreSQL / SQL surgery status
- No SQL/PG implementation present in repository artifacts under review, so N+1/transaction/index/lock/migration checks are marked **N/A** for this codebase.
