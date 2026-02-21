# Hostile Production Audit (Financial-Grade)

## Scope and verification
- Repository inventory: `rg --files`
- Static/programmatic checks:
  - `npm run -s typecheck` ✅
  - `npm run -s lint` ✅
  - `npm test -s` ✅
- SQL/DB scope check: no PostgreSQL client, migration, ORM schema, or SQL query files were found in this snapshot (`rg -n "\\b(pg|postgres|sql|SELECT|INSERT|UPDATE|DELETE|transaction|pool)\\b" src test`).

## Phase 1 — systematic decomposition (TypeScript + architecture + security + async)

### Critical (P0)

1) **File:Line:Column** `src/mcp/url-policy.ts:17:1`  
   **Category** Security  
   **Violation** IPv6 private-address detection is incomplete and allows IPv4-mapped IPv6 loopback/private forms (for example `::ffff:127.0.0.1`) to pass `isPrivateIpv6`, bypassing local-network blocking intent.  
   **Concrete fix** Replace ad-hoc string-prefix checks with canonical IP classification using `node:net` + robust CIDR matching for both IPv4 and IPv6, including mapped IPv4 forms (`::ffff:x.x.x.x`). Explicitly deny loopback/link-local/site-local/ULA/reserved ranges.  
   **Risk if not fixed** SSRF to local/private endpoints remains possible through MCP URL validation bypass, enabling internal service access and potential credential/data exfiltration.

### High (P1)

2) **File:Line:Column** `src/utils/settings-manager.ts:137:1`  
   **Category** Security  
   **Violation** Async settings writes create directories with `fs.ensureDir(dir)` and no explicit restrictive mode, while this same component stores sensitive material workflows (API key lifecycle and trust fingerprints).  
   **Concrete fix** Replace with explicit permission-setting flow: `await fs.mkdir(dir, { recursive: true, mode: 0o700 })` followed by `chmod` hardening if directory preexists with broader permissions; fail closed on insecure permissions for `~/.grok`.  
   **Risk if not fixed** On permissive umask/host setups, local users may read metadata/configuration that should be private, creating secret exposure and tampering risk.

3) **File:Line:Column** `src/index.tsx:8:1`  
   **Category** Resilience  
   **Violation** Process-level fatal async boundaries are not guarded (`unhandledRejection` / `uncaughtException` handlers absent).  
   **Concrete fix** Register top-level handlers early in startup, log sanitized context, trigger graceful shutdown with MCP disconnect attempts, and non-zero exit code; include crash-loop backoff guidance in ops docs.  
   **Risk if not fixed** A single unexpected promise rejection can terminate the CLI process abruptly, causing mid-operation interruption and possible partial state.

### Medium (P2)

4) **File:Line:Column** `src/mcp/client.ts:223:1`  
   **Category** Async/Concurrency  
   **Violation** Timeout handling for MCP tool calls races with teardown but does not cancel in-flight remote work (`Promise.race` timeout rejects locally while remote call may still complete/execute side effects).  
   **Concrete fix** Add transport-level cancellation/abort propagation (or request IDs with server-side cancellation RPC where supported); mark timed-out calls idempotency-required and prevent immediate retries for non-idempotent tools.  
   **Risk if not fixed** Duplicate or out-of-order side effects under retries/timeouts, especially dangerous for state-changing MCP tools.

5) **File:Line:Column** `src/agent/grok-agent.ts:73:1`  
   **Category** Architecture  
   **Violation** `GrokAgent` is a God-class (>500 lines, many responsibilities: orchestration, tool dispatch, state, MCP init, concurrency, model interaction).  
   **Concrete fix** Split into bounded components (`ConversationState`, `ToolExecutor`, `McpBootstrap`, `ConcurrencyGate`) and inject interfaces for test seams.  
   **Risk if not fixed** Higher regression risk and hidden coupling; incident response and safe refactoring become slower and error-prone.

### Low (P3)

6) **File:Line:Column** `src/tools/bash.ts:234:1`  
   **Category** Type/Architecture  
   **Violation** Path validation treats many positional args as filesystem paths for `git`, reducing correctness and creating brittle policy behavior (security policy and command semantics are conflated).  
   **Concrete fix** Implement command-aware argument schema per subcommand (for example `git show <rev> -- <path>`), validating only actual path-bearing positions/flags.  
   **Risk if not fixed** False positives/blocked legitimate workflows and increased maintenance complexity in security policy code.

---

## Phase 2 — adversarial re-review

Re-checked:
- “Obvious” safety code (`url-policy`, `settings-manager`, `index` startup/shutdown)
- Error and timeout paths (`mcp/client` timeout + teardown)
- Config/tooling (`tsconfig*.json`, `eslint.config.js`, `package.json`)
- Existing tests for security-sensitive behavior (`test/mcp-config-security.test.ts`, `test/url-policy.test.ts`, `test/bash-tool.test.ts`)

Additional phase-2 conclusion:
- No PostgreSQL/SQL execution path exists in this repository snapshot; SQL-specific findings are N/A for this codebase revision.

---

## Immediate production-incident ranking (if deployed today)

1. **P0: MCP URL private-network bypass via IPv4-mapped IPv6 gap** (`src/mcp/url-policy.ts`)  
   **Blast radius**: Any environment enabling MCP URL configuration/consumption; potential access to localhost/private services and internal metadata endpoints.

2. **P1: Insecure settings-directory permissions risk** (`src/utils/settings-manager.ts`)  
   **Blast radius**: Multi-user systems and shared hosts; can expose or allow tampering with user-level CLI security state.

3. **P1: Missing process-level async crash guards** (`src/index.tsx`)  
   **Blast radius**: All runtime modes; abrupt process termination during active tool execution.

4. **P2: MCP timeout without true cancellation** (`src/mcp/client.ts`)  
   **Blast radius**: MCP tool calls under latency/failure conditions; duplicate side effects possible for mutating tools.
