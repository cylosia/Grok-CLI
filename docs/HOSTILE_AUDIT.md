# Hostile Production Audit (TypeScript / PostgreSQL Checklist)

## Scope, method, and verification
- **Pass 1 (systematic decomposition):** reviewed project config and every TypeScript source path under `src/` for type-safety, async behavior, security boundaries, error handling, and architectural coupling.
- **Pass 2 (adversarial re-check):** re-reviewed "obvious" modules (`index`, `logger`, `settings-manager`, `mcp/*`, `tools/*`) and catch/error paths.
- **Verification commands run:**
  - `npm run -s typecheck` ✅
  - `npm audit --audit-level=high` ⚠️ (registry endpoint returned 403 in this environment)
- **Subagent note:** independent subagents are not available in this runtime, so findings were double-checked via two distinct manual passes plus targeted static pattern scans.
- **PostgreSQL scope note:** this repository contains **no PostgreSQL driver/queries/migrations/schema** artifacts. SQL/transaction/index/migration checks are marked **N/A** for this codebase.

---

## PHASE 1 — Systematic decomposition findings

### Critical (P0)
- **None verified in current repository snapshot.**

### High (P1)

1. **Pending confirmations can deadlock forever after session reset**
   - **File:Line:Column:** `src/utils/confirmation-service.ts:143:3`
   - **Category:** Async|Resilience
   - **Violation:** `resetSession()` clears `pendingQueue` without resolving/rejecting already-awaited confirmation promises.
   - **Concrete fix:** Before clearing queue, iterate pending requests and resolve each with `{ confirmed: false, feedback: "Session reset" }`.
   - **Risk if not fixed:** callers awaiting `requestConfirmation()` can hang indefinitely, stalling interactive flows.

2. **Logger can throw on circular context and crash error paths**
   - **File:Line:Column:** `src/utils/logger.ts:42:16`
   - **Category:** Observability|Resilience
   - **Violation:** `JSON.stringify(payload)` is called without circular-safe serialization; a circular value in context causes a thrown exception inside logging itself.
   - **Concrete fix:** Replace with safe serializer (e.g., custom replacer tracking seen objects) and hard-fallback to minimal log line if serialization fails.
   - **Risk if not fixed:** exception handling/logging can fail catastrophically during incidents, obscuring root cause and potentially terminating control flow.

3. **MCP tool calls use timeout race without cancellation of underlying operation**
   - **File:Line:Column:** `src/mcp/client.ts:176:7`
   - **Category:** Async|Performance
   - **Violation:** `Promise.race` times out, but underlying `server.client.callTool(...)` is not cancelled/aborted.
   - **Concrete fix:** Add cancellation support (AbortSignal if SDK supports it) or close/recreate hung client transport on timeout.
   - **Risk if not fixed:** timed-out calls can continue consuming resources, leading to connection pressure and degraded throughput.

### Medium (P2)

4. **Unsafe narrowing via assertion on model role**
   - **File:Line:Column:** `src/grok/client.ts:177:13`
   - **Category:** Type
   - **Violation:** `role: message.role as GrokRole` trusts external API data without runtime guard.
   - **Concrete fix:** validate role explicitly (`if (role !== ... ) throw`) and map unknown roles to a controlled error path.
   - **Risk if not fixed:** malformed upstream payloads can violate internal invariants and create hard-to-debug downstream behavior.

5. **Synchronous filesystem operations in runtime paths**
   - **File:Line:Column:** `src/utils/settings-manager.ts:61:21`
   - **Category:** Performance
   - **Violation:** repeated sync I/O (`readFileSync`, `writeFileSync`, `renameSync`, `fsyncSync`) on interactive paths blocks the event loop.
   - **Concrete fix:** migrate to `fs/promises` with atomic temp-file write semantics preserved.
   - **Risk if not fixed:** latency spikes/frozen UI under slower filesystems or frequent settings writes.

6. **Transport parser silently defaults missing type to stdio**
   - **File:Line:Column:** `src/commands/mcp.ts:33:35`
   - **Category:** Type|Security
   - **Violation:** missing/invalid `type` is coerced through `String(... ?? 'stdio')`, allowing ambiguous configs to become stdio by default.
   - **Concrete fix:** require explicit `transport.type` and reject absent values with actionable validation errors.
   - **Risk if not fixed:** operator intent mismatch and accidental local-command execution path.

7. **`/commit-and-push` forcibly stages everything with no path policy**
   - **File:Line:Column:** `src/hooks/use-input-handler.ts:381:33`
   - **Category:** Security|Architecture
   - **Violation:** automatic `git add .` includes all tracked/untracked files, including accidental secrets/build artifacts.
   - **Concrete fix:** switch to interactive/filtered staging (respect `.gitignore`, block known secret patterns, and show staged preview before commit).
   - **Risk if not fixed:** high-likelihood secret leakage and noisy/irreversible commits in automation contexts.

### Low (P3)

8. **Global process env mutation from UI component**
   - **File:Line:Column:** `src/ui/components/api-key-input.tsx:58:7`
   - **Category:** Architecture|Security
   - **Violation:** setting `process.env.GROK_API_KEY` at runtime mutates global state from UI layer.
   - **Concrete fix:** keep secrets in scoped in-memory credential store passed by dependency injection, not process-global mutation.
   - **Risk if not fixed:** hidden coupling and broader accidental secret exposure surface inside process.

9. **URL validation relies on custom parser rather than WHATWG URL normalization**
   - **File:Line:Column:** `src/mcp/url-policy.ts:1:1`
   - **Category:** Security
   - **Violation:** handcrafted parsing is brittle compared to standardized URL parsing and normalization.
   - **Concrete fix:** parse via `new URL(rawUrl)` then enforce protocol/hostname/IP policy on normalized fields.
   - **Risk if not fixed:** edge-case parser discrepancies can create policy bypass opportunities over time.

10. **Branded IDs are defined but not consistently enforced across API boundaries**
   - **File:Line:Column:** `src/types/index.ts:1:1`, `src/mcp/client.ts:9:3`
   - **Category:** Type|Architecture
   - **Violation:** many high-value identifiers remain plain `string` in interfaces/functions despite available branding primitives.
   - **Concrete fix:** migrate external-facing IDs (`name`, tool names, request IDs) to branded types plus constructor/validator helpers.
   - **Risk if not fixed:** cross-assignment mistakes compile and survive to runtime.

---

## PHASE 2 — Adversarial review

### Re-examined "looks-fine" zones
- `tsconfig.json`, `tsconfig.strict.json`, `package.json`
- `src/index.tsx`, `src/utils/logger.ts`, `src/utils/settings-manager.ts`
- `src/mcp/client.ts`, `src/mcp/transports.ts`, `src/mcp/url-policy.ts`
- error/catch paths in tools and UI hooks

### Additional adversarial conclusions
- TypeScript strictness is enabled and baseline typecheck passes; major issues are mostly **runtime safety/invariants**, not compiler flags.
- No PostgreSQL implementation exists in-repo; DB-specific checks are blocked by missing DB layer artifacts.
- Most immediate incident risks come from async lifecycle handling (pending confirmations, non-cancelled races) and observability fragility (logger serialization failure).

---

## Immediate production-incident ranking (if deployed now)
1. **Pending confirmation deadlock** (`confirmation-service`) — **Blast radius:** interactive command workflows needing user confirmation may stall indefinitely per session.
2. **Logger serialization crash path** (`logger`) — **Blast radius:** all components using structured logging when given circular payloads; incident response visibility degradation is broad.
3. **Non-cancelled timed-out MCP calls** (`mcp/client`) — **Blast radius:** MCP-enabled sessions under slow/hung tools; resource pressure accumulates over time.
4. **Forced `git add .` commit flow** (`use-input-handler`) — **Blast radius:** users relying on auto-commit command; potential sensitive data commit/exfiltration.

## PostgreSQL / SQL surgery status
- **N/A for this repository snapshot**: no SQL queries, PostgreSQL client usage, migrations, schema DDL, or DB access layer files were found.
