# Hostile Audit (Phase 1 + Phase 2, adversarial re-pass)

Date: 2026-02-21  
Repository: `Grok-CLI`

## Method

- Phase 1: system decomposition over runtime/config/tooling and high-risk execution paths.
- Phase 2: adversarial re-pass focused on "obvious" code, catch/error paths, and config gates (`package.json`, `tsconfig*`, `eslint.config.js`).
- Verification commands executed:
  - `npm run -s typecheck`
  - `npm run -s lint`
  - `npm run -s test:unit`
- SQL/Postgres scope check: no PostgreSQL client (`pg`, `postgres`), migrations, or SQL query layer found in this snapshot.

---

## 1) Critical (P0)

- None verified.

## 2) High (P1)

### P1-1
- **File:Line:Column:** `src/utils/logger.ts:36:1`
- **Category:** Security|Resilience|Performance
- **Specific violation:** `sanitize()` recursively traverses objects without cycle detection. If any logged context contains a cyclic graph, recursion can throw (`RangeError: Maximum call stack size exceeded`) before `safeJsonStringify()` is reached.
- **Concrete fix suggestion:** Add a `WeakSet<object>` `seen` parameter to `sanitize()` and short-circuit previously visited nodes (e.g., return `"[CIRCULAR]"`), mirroring the logic already used in `safeJsonStringify()`.
- **Risk if not fixed:** A single malformed/cyclic context object can break logging on hot error paths, causing observability blind spots and potential process instability under incident conditions.

### P1-2
- **File:Line:Column:** `src/commands/mcp.ts:307:1`
- **Category:** Security|PII/Secret Leakage
- **Specific violation:** The legacy display branch prints `(server.args || [])` without passing values through `redactCliArg()`. In contrast, the stdio transport branch does redact. This creates inconsistent secret redaction and a direct leak path in `grok mcp list` output.
- **Concrete fix suggestion:** Change the legacy branch to map args through `redactCliArg()` before rendering, identical to the stdio branch.
- **Risk if not fixed:** Tokens/API keys embedded in legacy args can be disclosed to terminal logs, screen captures, shell history capture tools, and CI logs.

---

## 3) Medium (P2)

### P2-1
- **File:Line:Column:** `src/mcp/client.ts:135:5`
- **Category:** Async|Resilience
- **Specific violation:** `removeServer()` closes client then disconnects transport sequentially, without timeout/`allSettled` safeguards used elsewhere. A hung close can block disconnect and keep server state/process resources stuck.
- **Concrete fix suggestion:** Replace sequential awaits with bounded teardown (`Promise.allSettled` + timeout race), then always delete server from map in a `finally` block.
- **Risk if not fixed:** Connection/resource leakage and degraded availability during shutdown/reconfiguration, especially when remote MCP endpoints are unhealthy.

### P2-2
- **File:Line:Column:** `src/tools/bash.ts:51:1`
- **Category:** Architecture|Maintainability
- **Specific violation:** `BashTool` centralizes tokenization, policy, path canonicalization, confirmation UX, spawn lifecycle, and command-specific validation in a single ~700+ line class.
- **Concrete fix suggestion:** Split into focused modules (`ArgTokenizer`, `PolicyValidator`, `PathGuard`, `ProcessRunner`) with explicit interfaces; keep `BashTool` as orchestration layer only.
- **Risk if not fixed:** High regression probability in safety-critical command policy code; small fixes can introduce bypasses in unrelated branches.

---

## 4) Low (P3)

### P3-1
- **File:Line:Column:** `src/commands/mcp.ts:258:1`
- **Category:** Error Handling|Diagnostics
- **Specific violation:** Multiple `.action()` handlers set `process.exitCode = 1` while only printing message text; structured logs/correlation IDs from `logger` are not emitted on these failures.
- **Concrete fix suggestion:** Route command errors through `logger.error(...)` (with component/action/server fields), and print user-facing text separately.
- **Risk if not fixed:** Slower incident triage due to fragmented, unstructured operational telemetry.

---

## Immediate production-incident ranking (blast radius)

1. **P1-2 secret leak in `mcp list` legacy args**  
   - **Blast radius:** Any operator/runtime using legacy MCP configs containing credentials in CLI args.  
   - **Incident mode:** Secret exposure in local terminals, logs, and recordings.

2. **P1-1 cyclic logger recursion crash path**  
   - **Blast radius:** Any component that logs rich/cyclic object graphs (especially error contexts).  
   - **Incident mode:** Logging-path failure and observability degradation during outages.

3. **P2-1 non-bounded `removeServer()` teardown**  
   - **Blast radius:** MCP-enabled sessions under network degradation/timeouts.  
   - **Incident mode:** stuck teardown, resource leakage, difficult shutdown/restart behavior.
