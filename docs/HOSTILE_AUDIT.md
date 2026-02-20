# Hostile Production Audit (TypeScript/PostgreSQL)

## Methodology

### Phase 1 — Systematic decomposition
I walked the repository file inventory and then drilled into high-risk files (`tools`, `mcp`, `agent`, `hooks`, config) with line-level inspection and type/build verification.

### Phase 2 — Adversarial re-review
I re-reviewed “obvious” files and failure paths (`catch` blocks, background async init, settings/config loading), plus `tsconfig.json` and `package.json`.

### Verification commands executed
- `rg --files`
- `npm run -s typecheck`
- `npm run -s build`
- `npm audit --json` *(blocked by registry 403 in this environment)*
- `rg -n "as unknown as|catch \(error: any\)|process\.env|Promise\.all|--follow|Object\.values\(|ensureServersInitialized\(\)\.catch" src tsconfig.json package.json`
- `wc -l src/**/*.ts src/**/*.tsx | sort -nr | head -n 20`

---

## SQL/PostgreSQL surgery result
No PostgreSQL access layer exists in this repository today (no `pg`/Prisma/Knex/TypeORM imports, SQL migrations, or query text). SQL findings are therefore **N/A by absence**, which itself is a risk if this CLI is assumed to be DB-backed in production.

---

## 1) Critical (P0)

### P0-1
- **File:Line:Column**: `src/mcp/config.ts:11:20`
- **Category**: Security
- **Violation**: Untrusted project JSON is cast directly to `MCPServerConfig[]` via `as`, with no runtime validation before flowing into transport/command execution.
- **Concrete fix**: Replace cast with strict schema validation (e.g., Zod): parse each server object, enforce transport-specific required fields, and deny unknown keys; reject invalid config before storage/use.
- **Risk if not fixed**: A tampered `.grok/settings.json` can trigger arbitrary command execution through MCP stdio transport on startup.

### P0-2
- **File:Line:Column**: `src/tools/text-editor.ts:732:3`
- **Category**: Security
- **Violation**: `resolveSafePath` performs lexical prefix checks only (`path.resolve` + `startsWith`) and does not canonicalize symlinks.
- **Concrete fix**: Canonicalize `workspaceRoot` and target parent with `fs.realpath`, then enforce canonical prefix checks before any read/write/remove.
- **Risk if not fixed**: Symlink traversal can escape workspace and modify arbitrary host files.

---

## 2) High (P1)

### P1-1
- **File:Line:Column**: `src/mcp/transports.ts:36:7`
- **Category**: Security
- **Violation**: Entire parent `process.env` is forwarded into child MCP processes.
- **Concrete fix**: Switch to explicit allowlist env propagation (`PATH`, minimal locale vars, explicitly required keys only).
- **Risk if not fixed**: Token/credential exfiltration to untrusted MCP server binaries.

### P1-2
- **File:Line:Column**: `src/mcp/transports.ts:99:7`
- **Category**: Resilience
- **Violation**: HTTP transport sets `connected=true` even when health probe fails.
- **Concrete fix**: Keep disconnected state on probe failure, or perform verified fallback probe and only then mark connected.
- **Risk if not fixed**: False healthy state; cascading runtime failures during tool calls.

### P1-3
- **File:Line:Column**: `src/grok/tools.ts:340:3`
- **Category**: Async/Concurrency
- **Violation**: `ensureServersInitialized().catch(() => {})` is fire-and-forget with total error suppression.
- **Concrete fix**: `await` initialization with timeout and expose a typed degraded-state error to caller/UI.
- **Risk if not fixed**: Non-deterministic startup races and invisible MCP outages.

### P1-4
- **File:Line:Column**: `src/tools/search.ts:194:9`
- **Category**: Security
- **Violation**: ripgrep uses `--follow`, allowing traversal into symlinked external trees.
- **Concrete fix**: Remove `--follow` by default; gate behind explicit opt-in plus root-boundary validation.
- **Risk if not fixed**: Data exposure outside repository trust boundary.

### P1-5
- **File:Line:Column**: `src/utils/settings-manager.ts:69:5`
- **Category**: Security
- **Violation**: API key persisted plaintext with default OS umask; no explicit restrictive mode.
- **Concrete fix**: Write using `{ mode: 0o600 }`, verify file perms on load, and prefer OS keychain.
- **Risk if not fixed**: Credential disclosure on shared/misconfigured hosts.

### P1-6
- **File:Line:Column**: `src/tools/text-editor.ts:404:13`
- **Category**: Data Integrity
- **Violation**: `undoEdit` reads/writes `lastEdit.path` directly (not `resolveSafePath`), bypassing workspace enforcement for history replay.
- **Concrete fix**: Store canonical safe paths in history, and revalidate with `resolveSafePath`/`realpath` before undo operations.
- **Risk if not fixed**: Path injection in history can alter/remove files outside intended scope.

### P1-7
- **File:Line:Column**: `src/agent/parallel.ts:20:27`
- **Category**: Async/Concurrency
- **Violation**: Unbounded `Promise.all` for delegated tasks with no concurrency cap or cancellation budget.
- **Concrete fix**: Use bounded pool (`p-limit`) and per-task timeout/abort propagation.
- **Risk if not fixed**: Resource exhaustion and degraded responsiveness under burst workloads.

---

## 3) Medium (P2)

### P2-1
- **File:Line:Column**: `src/tools/text-editor.ts:398:22`
- **Category**: Type
- **Violation**: Non-null assertion `pop()!` in undo path.
- **Concrete fix**: Replace with explicit guard (`const lastEdit = this.editHistory.pop(); if (!lastEdit) return ...`).
- **Risk if not fixed**: Refactor-induced runtime crash if invariants drift.

### P2-2
- **File:Line:Column**: `src/tools/text-editor.ts:63:21`
- **Category**: Type
- **Violation**: Privileged editor functions use `catch (error: any)` repeatedly.
- **Concrete fix**: Use `unknown`, narrow with `instanceof Error`, and normalize typed error payloads.
- **Risk if not fixed**: Error-path type unsafety and brittle failure handling.

### P2-3
- **File:Line:Column**: `src/utils/settings-manager.ts:61:5`
- **Category**: Resilience
- **Violation**: Silent `catch` fallback to defaults for settings parse/IO errors.
- **Concrete fix**: Emit structured warning/metric with redaction, surface degraded-config state to UI.
- **Risk if not fixed**: Hidden config corruption and hard-to-debug behavior drift.

### P2-4
- **File:Line:Column**: `src/ui/components/api-key-input.tsx:43:24`
- **Category**: Security
- **Violation**: “Validation” creates `new GrokAgent(apiKey)` but does not verify key with remote auth check.
- **Concrete fix**: Perform lightweight authenticated API probe (e.g., `listModels`) before persisting key.
- **Risk if not fixed**: Invalid secrets accepted and persisted; operational confusion.

### P2-5
- **File:Line:Column**: `src/index.tsx:7:1`
- **Category**: Ops/Resilience
- **Violation**: No SIGINT/SIGTERM graceful shutdown hooks for in-flight streams/tools.
- **Concrete fix**: Add signal handlers to cancel active operations (`AbortController`) and close transports cleanly before exit.
- **Risk if not fixed**: Partial writes, abrupt termination, and orphan child processes.

### P2-6
- **File:Line:Column**: `tsconfig.json:12:5`
- **Category**: Type
- **Violation**: `exactOptionalPropertyTypes` disabled in default compile profile.
- **Concrete fix**: Enable in default config and enforce in CI typecheck.
- **Risk if not fixed**: Optional-property unsoundness in production builds.

### P2-7
- **File:Line:Column**: `src/hooks/use-input-handler.ts:555:5`
- **Category**: Architecture/Security
- **Violation**: UI advertises direct commands including `cp`, `mv`, `rm`, while backend bash policy blocks them; policy mismatch.
- **Concrete fix**: Align UI command set with backend allowlist or route restricted commands through dedicated confirmation + policy layer.
- **Risk if not fixed**: User confusion, brittle behavior, and accidental policy bypass attempts.

---

## 4) Low (P3)

### P3-1
- **File:Line:Column**: `src/tools/search.ts:38:11`
- **Category**: Architecture
- **Violation**: `confirmationService` injected but unused in `SearchTool`.
- **Concrete fix**: Remove dead dependency or enforce confirmation path for expansive searches.
- **Risk if not fixed**: Dead code and misleading security posture.

### P3-2
- **File:Line:Column**: `package.json:9:3`
- **Category**: Testability/Quality
- **Violation**: No test script or automated test harness in production-grade codebase.
- **Concrete fix**: Add `test` script with unit/integration suites and CI gate.
- **Risk if not fixed**: Regression risk and low confidence in high-risk refactors.

### P3-3
- **File:Line:Column**: `src/tools/text-editor.ts:518:3`
- **Category**: Performance
- **Violation**: Diff engine uses O(m*n) DP (`computeLCS`) for every edit preview; no size guardrails.
- **Concrete fix**: Add file-size cutoff and fallback to simpler diff strategy for large files.
- **Risk if not fixed**: Latency spikes and memory pressure on large-file edits.

---

## Immediate incident ranking (if deployed today)
1. **Unvalidated MCP config -> command execution** (`src/mcp/config.ts`). **Blast radius:** full host compromise in user context.
2. **Symlink workspace escape in editor path checks** (`src/tools/text-editor.ts`). **Blast radius:** unauthorized overwrite/delete outside repo.
3. **Env leakage into MCP child processes** (`src/mcp/transports.ts`). **Blast radius:** credential/token theft across all configured MCP tools.
4. **Search symlink-follow leakage** (`src/tools/search.ts`). **Blast radius:** sensitive file discovery/exfiltration outside workspace.
5. **Async MCP init race + suppressed errors** (`src/grok/tools.ts`, `src/mcp/transports.ts`). **Blast radius:** widespread feature outage with low observability.

## “Two subagents verify each finding” constraint
This runtime has no parallel subagent primitive. I compensated with dual-pass verification (systematic + adversarial) and command-backed line verification for each finding.
