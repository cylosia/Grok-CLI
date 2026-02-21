# Hostile Production Audit (TypeScript/PostgreSQL Checklist)

## Scope, verification, and constraints
- Repository inventory: `rg --files`
- Static and config checks:
  - `npm run -s typecheck`
  - `npm run -s lint`
  - `npm test --silent`
  - `npm audit --audit-level=high` (blocked by registry 403 in this environment)
- Targeted deep reads (high-risk paths): `src/agent/grok-agent.ts`, `src/hooks/use-input-handler.impl.ts`, `src/tools/text-editor.impl.ts`, `src/tools/search.ts`, `src/utils/settings-manager.ts`, `src/mcp/*`, `src/grok/client.ts`, `tsconfig.json`, `eslint.config.js`, `package.json`.

## PostgreSQL/SQL surgery status
No PostgreSQL driver usage, SQL strings, migration framework, schema files, or DB access layer are present in this repository snapshot. All SQL-specific checks are N/A for this codebase revision.

---

## PHASE 1 — Systematic decomposition findings

### Critical (P0)

1) **File:Line:Column:** `src/hooks/use-input-handler.impl.ts:687:11` and `src/agent/grok-agent.ts:230:3`
- **Category:** Architecture | Async | Reliability
- **Violation:** Streaming UI has a `tool_result` branch and mutates existing tool-call entries to finished results, but the stream producer never emits `tool_result` chunks and never executes returned tool calls in streaming mode.
- **Concrete fix:** Refactor `processUserMessageStream()` to mirror non-stream path behavior: when tool calls arrive, execute each tool, emit `tool_result` chunks, append `role:"tool"` messages, then continue model turn loop until assistant final text or max tool rounds.
- **Risk if not fixed:** Production dead-end where streaming sessions show “Executing...” forever (or no final answer), creating stuck user flows and operational incidents under normal tool-using prompts.

### High (P1)

2) **File:Line:Column:** `src/tools/text-editor.impl.ts:142:7`, `207:7`, `296:7`, `372:7`
- **Category:** Security | Filesystem
- **Violation:** TOCTOU window between `resolveSafePath()` checks and subsequent writes/removes; attacker-controlled symlink swaps can redirect writes after validation.
- **Concrete fix:** Open files with `fs.open` + `O_NOFOLLOW` (or platform-safe equivalent), validate descriptor target via `fstat`, and perform writes through file descriptor. For create paths, resolve and lock parent directory inode before creation.
- **Risk if not fixed:** Workspace escape/write-what-where if an attacker can mutate filesystem links concurrently (multi-process workstation threat model).

3) **File:Line:Column:** `src/tools/search.ts:208:18`
- **Category:** Performance | Resilience
- **Violation:** Spawned `rg` process has no wall-clock timeout; only output-size cap exists.
- **Concrete fix:** Add timeout (e.g., 10–30s default) and terminate process with SIGTERM/SIGKILL fallback, returning a bounded error.
- **Risk if not fixed:** Hung searches can pin sessions and consume resources indefinitely under pathological regex or filesystem stalls.

4) **File:Line:Column:** `src/utils/settings-manager.ts:125:3`
- **Category:** Data Integrity | Reliability
- **Violation:** `enqueueWrite()` swallows write failures (`catch` logs warning) and API remains `void`, so callers cannot detect persistence failure.
- **Concrete fix:** Return `Promise<void>` from save/update APIs and propagate failure to caller (or expose `flushWrites()` plus explicit error channel) so command handlers can fail fast.
- **Risk if not fixed:** Silent settings loss/corruption; operators believe configuration was saved when disk write actually failed.

### Medium (P2)

5) **File:Line:Column:** `src/agent/grok-agent.ts:61:3` and `62:3`
- **Category:** Performance | Resource
- **Violation:** `chatHistory` and `messages` are unbounded arrays.
- **Concrete fix:** Add configurable caps (token/window or message count), summarize/truncate older context, and cap retained UI history.
- **Risk if not fixed:** Memory growth over long sessions; degraded latency or OOM in prolonged production runs.

6) **File:Line:Column:** `src/agent/grok-agent.ts:316:47` and `318:47`
- **Category:** Type
- **Violation:** `args.todos as never[]` and `args.updates as never[]` bypass type safety at tool boundary.
- **Concrete fix:** Replace casts with runtime schema validation (`zod`/manual type guards) and only pass validated `TodoItem[]`/`TodoUpdate[]`.
- **Risk if not fixed:** Runtime type faults and malformed task state from LLM-generated payloads.

7) **File:Line:Column:** `src/mcp/client.ts:65:24`
- **Category:** Type | Domain Modeling
- **Violation:** Branded identifier is bypassed via unchecked constructor `asMCPServerName(config.name)` instead of parser at trust boundary.
- **Concrete fix:** Replace with `parseMCPServerName(config.name)` and reject invalid names before map insertion.
- **Risk if not fixed:** Weakens nominal-type guarantees and allows drift between compile-time branding and runtime invariants.

### Low (P3)

8) **File:Line:Column:** `eslint.config.js:20:7`
- **Category:** Quality
- **Violation:** `@typescript-eslint/no-explicit-any` is warning-only in financial-grade policy context.
- **Concrete fix:** Promote to `error`, and add rules for `no-floating-promises`, `switch-exhaustiveness-check`, and `no-unsafe-*` family.
- **Risk if not fixed:** Type escapes and unsafe boundaries regress silently over time.

9) **File:Line:Column:** `src/tools/todo-tool.ts:32:7` and `43:7`
- **Category:** Type
- **Violation:** Exhaustiveness relies on implicit union return, no `assertNever` guard.
- **Concrete fix:** Add `default: return assertNever(status)` pattern with a local `assertNever` helper.
- **Risk if not fixed:** Future status extension can compile-break unpredictably or introduce undefined behavior if strictness settings change.

---

## PHASE 2 — Adversarial second pass

Re-reviewed with assumption of missed defects:
- **Obvious paths:** `grok-agent` main loop and stream loop parity.
- **Catch blocks / failure paths:** settings write queue and search child-process lifecycle.
- **Config/dependency surfaces:** `tsconfig.json`, `eslint.config.js`, `package.json`.

### Phase-2 confirmations
- Streaming/non-streaming behavior is materially inconsistent and is incident-grade in tool-heavy workflows.
- Search subprocess lacks deadline controls despite byte caps.
- Settings persistence still has acknowledge-without-durability semantics.
- Type boundary safety is weakened by `never[]` casts in tool dispatch.

---

## Immediate incident ranking (deploy-today blast radius)

1. **Streaming tool-result dead path (`grok-agent` + input handler)**  
   **Blast radius:** All streaming chat users; prompts requiring tools can stall or return incomplete outputs.
2. **TOCTOU in text editor writes**  
   **Blast radius:** Local file integrity/security of workspace host under concurrent filesystem manipulation.
3. **Unbounded ripgrep runtime**  
   **Blast radius:** CLI responsiveness and worker slot exhaustion during broad/pathological searches.
4. **Silent settings write failures**  
   **Blast radius:** Persistent configuration reliability, trust fingerprints, and operational reproducibility.
