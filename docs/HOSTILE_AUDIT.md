# Hostile Production Audit (TypeScript/PostgreSQL)

## Scope and verification protocol

### Phase 1 — Systematic decomposition
- Enumerated repository files and inspected high-risk execution surfaces (`tools`, `mcp`, `agent`, `hooks`, runtime/settings).
- Built and typechecked the code under strict TypeScript mode.
- Ran targeted pattern scans for unsafe casts, `any`, command execution, env handling, and error suppression.

### Phase 2 — Adversarial re-review
- Re-read "obvious" paths and all major `catch`/fallback branches.
- Re-reviewed configuration files (`tsconfig.json`, `package.json`) for production-hardening gaps.
- Revalidated findings against exact line locations.

### Commands executed
- `rg --files`
- `npm run -s typecheck`
- `npm run -s build`
- `npm audit --json` *(blocked by registry 403 in this environment)*
- `rg -n "as unknown as|catch \(error: any\)|process\.env|Promise\.all|--follow|Object\.values\(|ensureServersInitialized\(\)\.catch|dangerouslySetInnerHTML|innerHTML" src tsconfig.json package.json`
- `wc -l src/**/*.ts src/**/*.tsx | sort -nr | head -n 20`

---

## PostgreSQL/SQL surgery status
No PostgreSQL access layer is present in this codebase (no `pg` driver, ORM, migrations, or SQL text found). SQL-specific findings are **N/A by absence**. If production relies on PostgreSQL elsewhere, this repository has no enforceable DB integrity/security controls.

---

## 1) Critical (P0)

### P0-1
- **File:Line:Column**: `src/mcp/config.ts:11:20`
- **Category**: Type | Security | Architecture
- **Violation**: Untrusted project JSON is unsafely cast (`as MCPServerConfig[]`) and then executed as MCP transport config.
- **Concrete fix**: Replace cast with runtime schema validation (e.g., strict Zod schema per transport type) before loading/saving; reject unknown keys.
- **Risk if not fixed**: Tampered `.grok/settings.json` can inject arbitrary stdio command configs at startup.

### P0-2
- **File:Line:Column**: `src/tools/text-editor.ts:732:3`
- **Category**: Security | Filesystem isolation
- **Violation**: `resolveSafePath` relies on lexical `path.resolve + startsWith` checks only; symlink canonicalization is missing.
- **Concrete fix**: Canonicalize both workspace root and target (`fs.realpath`) and enforce canonical prefix checks before every read/write/delete.
- **Risk if not fixed**: Symlink traversal can escape workspace boundary and modify/delete arbitrary host files.

---

## 2) High (P1)

### P1-1
- **File:Line:Column**: `src/tools/text-editor.ts:404:13`
- **Category**: Security | Data integrity
- **Violation**: `undoEdit()` reads/writes `lastEdit.path` directly, bypassing `resolveSafePath` entirely.
- **Concrete fix**: Store only canonical safe paths in edit history and re-run `resolveSafePath` (realpath-aware) before undo operations.
- **Risk if not fixed**: History poisoning can cause out-of-bound file mutation/deletion.

### P1-2
- **File:Line:Column**: `src/mcp/transports.ts:36:7`
- **Category**: Security | Secret management
- **Violation**: Full parent `process.env` is forwarded to child MCP processes.
- **Concrete fix**: Use allowlisted environment propagation only (`PATH`, locale, and explicit required vars).
- **Risk if not fixed**: Credential/token exfiltration by untrusted MCP binaries.

### P1-3
- **File:Line:Column**: `src/tools/search.ts:194:9`
- **Category**: Security | Data exposure
- **Violation**: Search uses ripgrep `--follow`, traversing symlink targets outside workspace trust boundary.
- **Concrete fix**: Remove `--follow` by default; gate behind explicit opt-in and canonical root checks.
- **Risk if not fixed**: Sensitive filesystem discovery and leakage outside repo scope.

### P1-4
- **File:Line:Column**: `src/mcp/client.ts:42:23`
- **Category**: Resilience | Resource management
- **Violation**: `addServer` does not cleanup partially initialized resources when `connect/listTools` fails after transport connect.
- **Concrete fix**: Wrap initialization in `try/finally`; on failure close client and disconnect transport before rethrow.
- **Risk if not fixed**: Connection/process leaks and gradual stability degradation under repeated failures.

### P1-5
- **File:Line:Column**: `src/grok/tools.ts:340:3`
- **Category**: Async/Concurrency | Observability
- **Violation**: Fire-and-forget `ensureServersInitialized().catch(() => {})` suppresses initialization failure.
- **Concrete fix**: Await initialization (or track explicit degraded state) and surface typed status to UI/logs.
- **Risk if not fixed**: Silent MCP outages and racey behavior under load.

### P1-6
- **File:Line:Column**: `src/utils/settings-manager.ts:69:5`
- **Category**: Security | Ops hardening
- **Violation**: API key persisted in plaintext JSON without explicit restrictive file permissions.
- **Concrete fix**: Write with mode `0o600`; verify permissions on load; prefer OS keychain where available.
- **Risk if not fixed**: Secret exposure on multi-user/shared hosts.

### P1-7
- **File:Line:Column**: `src/ui/components/api-key-input.tsx:51:7`
- **Category**: Security | UX correctness
- **Violation**: Claims to "validate" key but only constructs `new GrokAgent(apiKey)` (no auth roundtrip).
- **Concrete fix**: Perform real auth probe (e.g., `listModels`) before storing key.
- **Risk if not fixed**: Invalid credentials persisted; latent production auth failures.

---

## 3) Medium (P2)

### P2-1
- **File:Line:Column**: `src/agent/parallel.ts:20:27`
- **Category**: Async/Concurrency | Performance
- **Violation**: Unbounded `Promise.all` on delegated tasks; no concurrency budget, no cancellation propagation.
- **Concrete fix**: Use bounded executor (`p-limit`) with per-task timeout and `AbortSignal` flow-through.
- **Risk if not fixed**: Burst workloads can starve resources and degrade responsiveness.

### P2-2
- **File:Line:Column**: `src/mcp/transports.ts:99:7`
- **Category**: Resilience
- **Violation**: HTTP transport marks `connected=true` even when health check fails.
- **Concrete fix**: Keep disconnected state on failed probe unless explicit fallback probe succeeds.
- **Risk if not fixed**: False-green health state, harder incident triage.

### P2-3
- **File:Line:Column**: `src/tools/text-editor.ts:398:22`
- **Category**: Type rigor
- **Violation**: Non-null assertion (`this.editHistory.pop()!`) in undo path.
- **Concrete fix**: Replace with explicit guard and typed error return.
- **Risk if not fixed**: Refactor-sensitive runtime crash.

### P2-4
- **File:Line:Column**: `src/types/globals.d.ts:1:1`
- **Category**: Type rigor
- **Violation**: Global timer declarations widened to `unknown`, shadowing Node/browser lib types.
- **Concrete fix**: Delete custom globals, rely on standard lib typings; if needed use `ReturnType<typeof setTimeout>`.
- **Risk if not fixed**: Loss of timer type safety and accidental API misuse.

### P2-5
- **File:Line:Column**: `src/ui/marketplace-ui.tsx:6:41`
- **Category**: Type rigor
- **Violation**: `useState<any[]>([])` bypasses compile-time validation for marketplace payload shape.
- **Concrete fix**: Define `MarketplaceResult` interface and use `useState<MarketplaceResult[]>([])`.
- **Risk if not fixed**: Runtime rendering crashes from malformed responses.

### P2-6
- **File:Line:Column**: `src/utils/settings-manager.ts:61:5`
- **Category**: Resilience | Observability
- **Violation**: Broad silent catch while loading settings; corruption is swallowed and defaults silently applied.
- **Concrete fix**: Log structured warning (redacted) and emit explicit "degraded config" state.
- **Risk if not fixed**: Hidden config loss, difficult root-cause analysis.

### P2-7
- **File:Line:Column**: `tsconfig.json:10:5`
- **Category**: Type rigor
- **Violation**: `exactOptionalPropertyTypes` disabled in primary build profile.
- **Concrete fix**: Enable in `tsconfig.json` (not only strict overlay) and enforce in CI.
- **Risk if not fixed**: Optional property unsoundness reaching production build.

### P2-8
- **File:Line:Column**: `src/index.tsx:7:1`
- **Category**: Ops | Resilience
- **Violation**: No SIGTERM/SIGINT graceful shutdown orchestration for active streams/subprocesses.
- **Concrete fix**: Add signal handlers that abort in-flight operations and drain/close transports before exit.
- **Risk if not fixed**: Abrupt termination, partial operations, orphan child processes.

---

## 4) Low (P3)

### P3-1
- **File:Line:Column**: `package.json:6:3`
- **Category**: Testability/Quality
- **Violation**: No automated `test` script or CI quality gate in package scripts.
- **Concrete fix**: Add test runner script (`test`) and fail CI on test/type/lint regressions.
- **Risk if not fixed**: Higher regression probability in security-critical paths.

### P3-2
- **File:Line:Column**: `src/hooks/use-input-handler.ts:555:5`
- **Category**: Architecture | Security policy
- **Violation**: UI advertises direct command handling including `rm/mv/cp`, but backend bash policy blocks those commands.
- **Concrete fix**: Align frontend affordances with backend allowlist or route via explicit privileged workflow.
- **Risk if not fixed**: User confusion and policy model drift.

### P3-3
- **File:Line:Column**: `src/tools/text-editor.ts:518:3`
- **Category**: Performance
- **Violation**: LCS diff is O(m*n) without file-size guardrails.
- **Concrete fix**: Add maximum file-size/line-count thresholds and fallback diff strategy.
- **Risk if not fixed**: Latency spikes and memory pressure on large edits.

---

## Immediate production incident ranking (if deployed today)
1. **P0-1 Unvalidated MCP config execution** (`src/mcp/config.ts`). **Blast radius:** host-level command execution in user context.
2. **P0-2 Symlink workspace escape** (`src/tools/text-editor.ts`). **Blast radius:** unauthorized file mutation/deletion outside repository.
3. **P1-2 Env propagation to MCP child** (`src/mcp/transports.ts`). **Blast radius:** credential compromise across all inherited env secrets.
4. **P1-1 Unsafe undo path bypass** (`src/tools/text-editor.ts`). **Blast radius:** arbitrary file overwrite/remove via poisoned edit history.
5. **P1-5 Suppressed MCP init failures** (`src/grok/tools.ts`). **Blast radius:** silent core feature outages with poor diagnosability.

## Verification model for findings
Native multi-subagent execution is unavailable in this runtime. To approximate independent verification, each finding was validated twice:
1) direct source inspection at line-level, and
2) adversarial pattern-based re-scan + config/build re-check.
