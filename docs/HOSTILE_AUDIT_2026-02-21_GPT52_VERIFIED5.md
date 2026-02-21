# Hostile Production Audit (Phase 1 + Phase 2)

Date: 2026-02-21
Scope: `/workspace/Grok-CLI` TypeScript codebase
Method: Full file inventory + static checks (`eslint`, `tsc`, unit tests) + adversarial second pass over runtime/error/config surfaces.

## Phase 1: Systematic decomposition notes
- TypeScript strictness baseline is strong (`strict`, `noImplicitAny`, `exactOptionalPropertyTypes`, `switch-exhaustiveness-check`).
- No PostgreSQL access layer, SQL migrations, or query builders were found in this repository.
- Highest-risk runtime surfaces inspected manually: MCP transport/client lifecycle, process shutdown/error hooks, URL validation, command execution sandboxing, logging/redaction.

## Phase 2: Adversarial re-pass
Re-reviewed:
- Error paths and timeout handlers in `src/mcp/client.ts` and `src/index.tsx`.
- Config and policy files: `tsconfig*.json`, `eslint.config.js`, `package.json`.
- "Obvious" helpers where teams often over-trust safety wrappers (`logger`, branded-type helpers).

---

## Findings

### High (P1)

1) **File:Line:Column** `src/mcp/client.ts:387:7` and `src/mcp/client.ts:392:11`  
   **Category** Async|Resilience  
   **Violation** In-flight dedupe entry can leak forever if SDK call never settles after timeout/abort. `inFlightToolCalls` is only deleted in `normalizedCallPromise.finally(...)`; timeout path rejects caller but does not force map cleanup.  
   **Concrete fix** In timeout handler (or `finally` of outer `callTool`), add `this.inFlightToolCalls.delete(callKey)` before/after teardown so stale dedupe keys are always evicted even when underlying promise hangs permanently.  
   **Risk if not fixed** Memory growth + call starvation for identical call keys under degraded MCP servers; can cause prolonged partial outage and repeated false “in flight” behavior under load.

### Medium (P2)

2) **File:Line:Column** `src/mcp/url-policy.ts:60:27` and `src/mcp/url-policy.ts:76:24`  
   **Category** Security|Resilience|Performance  
   **Violation** DNS resolution has no explicit timeout budget and is executed twice per validation. Resolver stalls can block connection setup indefinitely or for very long periods.  
   **Concrete fix** Wrap each `lookup` call in `Promise.race([lookup(...), timeoutPromise])` with a bounded timeout (e.g., 1–2s), and surface a controlled timeout error.
   **Risk if not fixed** External DNS slowness can freeze MCP connection paths and cascade into startup/runtime hangs.

3) **File:Line:Column** `src/utils/logger.ts:16:1`, `src/utils/logger.ts:58:9`  
   **Category** Security|Observability  
   **Violation** Redaction heuristic only auto-masks high-entropy blobs when `length > 256`; many real API tokens shorter than that can pass through if logged in free-text fields not matching key names/patterns.  
   **Concrete fix** Lower/remodel heuristic to redact high-entropy strings at much smaller lengths (e.g., >=32) and add patterns for common token prefixes used by this stack.
   **Risk if not fixed** Sensitive credentials may appear in logs and downstream log sinks.

### Low (P3)

4) **File:Line:Column** `src/index.tsx:35:18`  
   **Category** Architecture|Ops  
   **Violation** CLI version string is hardcoded (`"v2.0.0"`) and can drift from `package.json` during release operations.  
   **Concrete fix** Read version from package metadata at build time (or inject via build constant) and print that single source of truth.
   **Risk if not fixed** Operational confusion during incident triage/release rollback.

5) **File:Line:Column** `src/types/index.ts:45:1`  
   **Category** Type  
   **Violation** `asMCPServerName(value)` provides unchecked brand cast and bypasses parser validation contract.  
   **Concrete fix** Remove `asMCPServerName`, or make it internal-only and route all untrusted input through `parseMCPServerName`.
   **Risk if not fixed** Future callers can accidentally reintroduce invalid/untrusted server names despite branded-type intent.

---

## Immediate incident ranking (if deployed today)
1. **P1 in-flight call leak (`src/mcp/client.ts`)** — largest blast radius: MCP tool path degradation, repeated request starvation for matching call keys, memory pressure over long sessions.
2. **P2 DNS timeout absence (`src/mcp/url-policy.ts`)** — medium blast radius: MCP startup/connection hangs tied to resolver health.
3. **P2 log redaction gap (`src/utils/logger.ts`)** — medium blast radius: potential credential exposure in centralized logging systems.

## Verification notes
- SQL/PostgreSQL findings: **not applicable in this repo**; no SQL/PG modules, migrations, or DB connectors were present in scanned sources.
- Findings were re-checked in two ways per issue: (a) static pattern search and (b) direct control-flow inspection of the concrete file/lines.
