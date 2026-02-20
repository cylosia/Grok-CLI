# Hostile Production Audit (TypeScript / PostgreSQL Checklist)

## Scope and verification
- **Repository inventory pass:** `rg --files` over project root.
- **Static risk pattern sweep:** targeted `rg -n` for unsafe casts, command execution, async patterns, env usage, JSON parsing, and timeout handling.
- **Systematic code review:** reviewed all source/config files in `src/`, `package.json`, and `tsconfig*.json`, then performed an adversarial second pass focused on error paths and "obvious" modules.
- **Verification commands:**
  - `npm run -s typecheck` ✅
  - `npm audit --audit-level=high` ⚠️ (registry returned HTTP 403 in this environment)
  - `npm outdated` ⚠️ (registry returned HTTP 403 in this environment)
- **PostgreSQL coverage note:** no PostgreSQL code exists in this repository snapshot (no `pg` client usage, no SQL migrations, no schema files, no query layer), so SQL-specific checks are **N/A**.
- **Subagent constraint:** runtime has no subagent facility. Each finding was re-validated in a separate second pass.

---

## PHASE 1 — Systematic decomposition

### Critical (P0)

1. **File:Line:Column:** `src/tools/bash.ts:205:3` (also exposed by `src/agent/grok-agent.ts:378:3`)  
   **Category:** Security | Async | Architecture  
   **Violation:** command-option policy bypass in `executeArgs`: argument validation skips any arg beginning with `-`, allowing dangerous interpreter features inside allowlisted tools (e.g., `find -exec ...`, `rg --pre ...`) despite command whitelist.  
   **Concrete fix:** replace generic arg pass-through with per-command allowlisted flag parsers (e.g., explicit schema for `git`, `find`, `rg`, `grep`) and reject execution-only flags like `-exec`, `--pre`, `--pre-glob`, `-f`, `--files-from`.  
   **Risk if not fixed:** arbitrary command execution primitive remains reachable through ostensibly “safe” tools; policy boundary can be bypassed.

### High (P1)

2. **File:Line:Column:** `src/mcp/url-policy.ts:56:3`  
   **Category:** Security  
   **Violation:** SSRF/private-network control is hostname-string based only; no DNS resolution/IP pinning check. Public hostnames that resolve to private IPs are not blocked.  
   **Concrete fix:** resolve host to A/AAAA at validation time, classify all resolved IPs against private/link-local ranges, and fail closed if resolution fails or any answer is private when disallowed.  
   **Risk if not fixed:** MCP endpoint policy can be bypassed to hit internal services.

3. **File:Line:Column:** `src/grok/client.ts:132:5`, `src/grok/client.ts:157:7`, `src/grok/client.ts:194:7`  
   **Category:** Resilience | Performance  
   **Violation:** no hard request timeout configured for OpenAI client calls; retries exist, but a hung upstream connection can stall worker/session indefinitely unless caller wires AbortSignal correctly.  
   **Concrete fix:** set client/request timeout defaults (e.g., `timeout` at client or per-call level), enforce global operation deadline, and propagate abort signals from all call sites.  
   **Risk if not fixed:** production hangs under network pathologies; thread/slot starvation cascades under load.

4. **File:Line:Column:** `src/mcp/client.ts:191:20`  
   **Category:** Async | Resilience  
   **Violation:** timeout implemented with `Promise.race`, but underlying `callTool` operation is not cancellable; timed-out work can continue in background until teardown effect lands.  
   **Concrete fix:** pass AbortSignal into SDK call when supported; otherwise isolate each tool call on short-lived transport/client and terminate process/channel immediately on timeout.  
   **Risk if not fixed:** latent background work and descriptor/process pressure during repeated timeouts.

### Medium (P2)

5. **File:Line:Column:** `src/tools/text-editor.ts:543:5`  
   **Category:** Reliability | Architecture  
   **Violation:** `resolveSafePath` requires `realpath(parentDir)` for non-existent targets; creating deep new files fails when parent path doesn’t exist yet (despite `create()` later calling `ensureDir`).  
   **Concrete fix:** walk upward to nearest existing ancestor before `realpath` check, then enforce workspace containment and allow creation of missing descendants.  
   **Risk if not fixed:** nondeterministic file-creation failures for valid in-workspace paths.

6. **File:Line:Column:** `src/tools/text-editor.ts:413:13`  
   **Category:** Data Integrity  
   **Violation:** undo for `str_replace` reverts only first occurrence via `content.replace(new, old)` and loses exact edit intent (especially after `replaceAll`).  
   **Concrete fix:** store full pre-image snapshot hash+content (or structural patch) per edit and restore exact previous bytes on undo.  
   **Risk if not fixed:** silent file corruption and non-reversible edits in multi-occurrence replacements.

7. **File:Line:Column:** `src/utils/settings-manager.ts:2:7`, `src/utils/settings-manager.ts:64:5`  
   **Category:** Type | Security  
   **Violation:** `fs` is forced to `any`; JSON is cast to target type without schema validation. Type guarantees are bypassed at persistence boundary.  
   **Concrete fix:** use `import { promises as fs } from "fs"` with concrete types and validate parsed settings with a strict runtime schema before merge.  
   **Risk if not fixed:** malformed settings can violate invariants at runtime and trigger undefined behavior.

8. **File:Line:Column:** `tsconfig.json:14:5`  
   **Category:** Type | Supply-chain hygiene  
   **Violation:** `skipLibCheck: true` suppresses declaration-file incompatibility checks in a financial-grade context.  
   **Concrete fix:** set `skipLibCheck` to `false` in CI strict profile and gate releases on successful full typecheck.  
   **Risk if not fixed:** upstream typing breaks/unsoundness can slip into production builds unnoticed.

### Low (P3)

9. **File:Line:Column:** `src/mcp/transports.ts:45:17`  
   **Category:** Security | Operations  
   **Violation:** user-configured `transport.env` fully overrides base env, including `PATH`; this widens execution ambiguity for stdio server commands.  
   **Concrete fix:** deny overrides for critical env keys (`PATH`, `HOME`, `NODE_OPTIONS`) or require explicit per-key allowlist plus warning/confirmation for each override.  
   **Risk if not fixed:** harder-to-audit runtime behavior and accidental execution of unintended binaries.

---

## PHASE 2 — Adversarial review (second pass)

Re-checked:
- **Config and dependency control plane:** `package.json`, `tsconfig.json`, `tsconfig.strict.json`
- **“Obvious” modules:** `src/utils/logger.ts`, `src/utils/settings-manager.ts`, `src/tools/bash.ts`, `src/mcp/*`, `src/grok/client.ts`
- **Catch/error/timeout paths:** tool execution, MCP calls, settings I/O, model API retries

Additional second-pass conclusions:
- Type strict mode is enabled, but runtime edges still bypass type safety (`any` + unchecked JSON casts).
- Highest real-world incident risk is command-policy bypass in `BashTool` plus network timeout/cancellation gaps.
- SQL/PostgreSQL risk categories are N/A for this repository due to absent DB layer.

---

## Immediate production-incident ranking (if deployed today)

1. **Bash allowlist bypass via dangerous flags (`find -exec` / `rg --pre`)**  
   **Blast radius:** any workflow executing `executeArgs` (including agent-facing paths) can execute unintended commands.

2. **MCP URL private-network policy bypass via DNS resolution gap**  
   **Blast radius:** MCP integrations may access internal network targets through crafted hostnames.

3. **Unbounded/hanging upstream calls (OpenAI + MCP timeout cancellation gap)**  
   **Blast radius:** request workers stall under upstream degradation; throughput collapse under load.

4. **Non-reversible editor undo semantics**  
   **Blast radius:** user/project files can be silently left in incorrect state after “undo”.

---

## PostgreSQL / SQL surgery status
- **N/A in this snapshot**: no SQL statements, migration files, query builders, ORM models, or PostgreSQL client wiring were found.
