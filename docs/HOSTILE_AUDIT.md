# Hostile Production Audit (TypeScript / PostgreSQL Checklist)

## Scope and verification
- **Repository inventory pass:** `rg --files`
- **Targeted static sweeps:**
  - `rg -n "as unknown as|:\s*any\b|Promise\.race|JSON\.parse\(|spawn\(|process\.env|skipLibCheck" src package.json tsconfig.json`
  - `rg -n "SELECT|INSERT|UPDATE|DELETE|postgres|\bpg\b|migration|knex|prisma|typeorm" src docs`
- **Build/type validation:** `npm run -s typecheck` ✅
- **Supply-chain check:** `npm audit --audit-level=high` ⚠️ (registry returned HTTP 403 in this environment)
- **Second-pass adversarial review:** re-read all files implicated by first-pass findings (tool execution, MCP transport/policy, settings, orchestration, config).
- **Subagent note:** no subagent framework is available in this runtime; findings were independently re-validated in a second manual pass.

## PostgreSQL/SQL surgery status
No PostgreSQL client, migration, schema, or SQL query layer exists in this repository snapshot; DB-specific checklist items are **N/A** for this codebase revision.

---

## PHASE 1 — Systematic decomposition findings

### Critical (P0)

1. **File:Line:Column:** `src/tools/bash.ts:216:1` and `src/tools/bash.ts:239:1`  
   **Category:** Security | Type | Architecture  
   **Violation:** path-safety validation skips any argument beginning with `-`, which allows path-bearing flags to bypass workspace containment checks (example: `git -C/tmp/repo status`, `rg --ignore-file=/tmp/x`). The command-specific blocklist does not comprehensively deny path-bearing flags.  
   **Concrete fix suggestion:** replace generic `arg.startsWith('-')` skip logic with per-command, schema-validated argument parsers. For each allowlisted command, explicitly classify which flags accept path operands and enforce workspace-relative checks on those operands; deny unknown flags by default.  
   **Risk if not fixed:** policy bypass enables operations outside workspace, undermining the command sandbox boundary and allowing unintended filesystem disclosure/execution contexts.

### High (P1)

2. **File:Line:Column:** `src/mcp/url-policy.ts:31:1`  
   **Category:** Security  
   **Violation:** DNS resolution for SSRF prevention relies on `globalThis.require`, which is frequently unavailable in ESM/bundled runtimes; fallback behavior (`return [host]`) weakens private-network detection for hostnames.  
   **Concrete fix suggestion:** statically import `node:dns/promises` and perform mandatory lookup for hostnames; fail closed when lookup fails (or make failure behavior explicit and configurable with secure default = deny).  
   **Risk if not fixed:** crafted public hostnames resolving to private IP ranges may bypass intended private-network restrictions.

3. **File:Line:Column:** `src/mcp/client.ts:191:1`  
   **Category:** Async | Resilience  
   **Violation:** `Promise.race` timeout does not cancel the underlying MCP SDK request; timed-out operations can continue in the background, while teardown is invoked opportunistically and potentially twice.  
   **Concrete fix suggestion:** pass an `AbortSignal` into the SDK call (or isolate call in disposable transport with deterministic cancel/kill semantics), and avoid duplicate teardown paths by centralizing timeout cleanup in one branch.  
   **Risk if not fixed:** runaway in-flight tool calls, connection/resource pressure, and degraded throughput during upstream slowness.

4. **File:Line:Column:** `src/grok/client.ts:125:1` (chat streaming call sites)  
   **Category:** Async | Resilience  
   **Violation:** outbound model calls rely on optional caller-provided abort only; no hard per-request timeout/overall deadline is enforced at the API client boundary.  
   **Concrete fix suggestion:** enforce a default timeout/deadline at OpenAI client invocation level and propagate cancellation from all call paths; add bounded retry with jitter only for transient status classes.  
   **Risk if not fixed:** hung upstream sockets can pin active sessions and trigger cascading latency/outage under load.

### Medium (P2)

5. **File:Line:Column:** `src/utils/confirmation-service.ts:43:1`  
   **Category:** Resilience | Architecture  
   **Violation:** confirmation promises remain pending indefinitely when UI/event consumers fail to answer; no TTL, timeout, or dead-letter handling exists for queued confirmations.  
   **Concrete fix suggestion:** add configurable per-request timeout (e.g., auto-reject after N seconds) and queue-size cap with explicit error path + telemetry.  
   **Risk if not fixed:** stuck operations and memory growth from unbounded pending confirmation queue in degraded UI/event-loop conditions.

6. **File:Line:Column:** `src/utils/settings-manager.ts:9:1` and `src/utils/settings-manager.ts:107:1`  
   **Category:** Type | Data Integrity  
   **Violation:** filesystem promises are obtained via double cast (`as unknown as ...`), and JSON parsing is cast to generic `T` without runtime schema enforcement at read boundary.  
   **Concrete fix suggestion:** use typed `import { promises as fs } from "node:fs"`; validate parsed content with strict runtime schema before merge/persistence.  
   **Risk if not fixed:** malformed config can violate invariants and produce runtime misconfiguration that static typing cannot prevent.

7. **File:Line:Column:** `src/agent/supervisor.ts:39:1` and `src/agent/supervisor.ts:45:1`  
   **Category:** Architecture | Security  
   **Violation:** mutates inbound `task` object (`task.context = ...`) and serializes full payload/context directly into model prompt string, increasing side-effect coupling and potential secret spill into LLM context.  
   **Concrete fix suggestion:** treat `Task` as immutable (clone into local execution state), and redact/whitelist fields before prompt serialization.  
   **Risk if not fixed:** hidden cross-component state coupling and accidental disclosure of sensitive payload fields to downstream model/provider logs.

8. **File:Line:Column:** `tsconfig.json:14:1`  
   **Category:** Type  
   **Violation:** `skipLibCheck` is enabled in production configuration.  
   **Concrete fix suggestion:** disable `skipLibCheck` for CI/release profile (or enforce a separate strict CI tsconfig with `skipLibCheck: false`).  
   **Risk if not fixed:** declaration incompatibilities and unsound transitive types can silently pass builds.

### Low (P3)

9. **File:Line:Column:** `package.json:9:1`  
   **Category:** Testability | Quality  
   **Violation:** test script aliases to typecheck only; no unit/integration harness is wired despite stateful tooling, transport, and orchestration code.  
   **Concrete fix suggestion:** add deterministic unit tests for command policy, URL validation, timeout/cancellation, and settings parsing; keep `typecheck` separate from `test`.  
   **Risk if not fixed:** regressions in critical control paths are likely to ship undetected.

10. **File:Line:Column:** `src/agent/repomap.ts:11:1`  
    **Category:** Architecture  
    **Violation:** core graph build path is a production stub with no implementation, but appears integrated in supervisor flow assumptions.  
    **Concrete fix suggestion:** either implement graph build semantics with explicit failure modes or gate/remove integration until production-ready.  
    **Risk if not fixed:** misleading behavior and brittle orchestration decisions based on incomplete data structures.

---

## PHASE 2 — Adversarial re-check focus

Re-examined explicitly:
- **Config/control-plane:** `package.json`, `tsconfig.json`, `tsconfig.strict.json`
- **“Obvious” modules:** `src/tools/bash.ts`, `src/mcp/url-policy.ts`, `src/mcp/client.ts`, `src/grok/client.ts`, `src/utils/settings-manager.ts`
- **Error/catch paths:** confirmation queue handling, MCP timeout teardown, JSON parsing boundaries, command validation branches

Second-pass deltas:
- Confirmed highest-risk issue is still command-argument policy bypass for path-bearing flags.
- Confirmed MCP private-network policy depends on runtime-specific `require` availability.
- Confirmed cancellation/timeout semantics remain non-deterministic around MCP/model calls.

---

## Immediate production-incident ranking (if deployed now)

1. **Bash path-policy bypass via flag operands (`git -C...`, similar path-bearing flags)**  
   **Blast radius:** any automation path invoking `BashTool` can execute outside intended workspace boundaries.

2. **MCP SSRF guard weakening when DNS lookup is unavailable**  
   **Blast radius:** externally configured MCP endpoints may reach internal/private network services.

3. **Non-cancellable MCP/model call timeout paths**  
   **Blast radius:** under upstream degradation, in-flight accumulation can starve workers and collapse throughput.

4. **Indefinite confirmation queue waits**  
   **Blast radius:** user-facing workflows can deadlock on stuck confirmation events, causing persistent operational stalls.
