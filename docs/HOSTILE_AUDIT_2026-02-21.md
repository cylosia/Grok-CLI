# Hostile Production Audit (2026-02-21)

Scope reviewed: `src/**/*.ts`, `src/**/*.tsx`, root config (`tsconfig*.json`, `eslint.config.js`, `package.json`), and test harness. This repository is TypeScript CLI/TUI code; no PostgreSQL client, migrations, or SQL execution layer exists in the audited tree.

## Method (Phase 1 + Phase 2)

- Phase 1: systematic source walk with targeted pattern scans (`void`-suppressed promises, unsafe casts, error-path handling, giant modules, security-sensitive logging).
- Phase 2: adversarial re-check focused on "obvious" paths, catch blocks, and config (`eslint.config.js`, `package.json`, `tsconfig.json`).
- Verification model for each finding: (A) direct source inspection at exact location + (B) independent command-based pattern validation (`rg`, lint/typecheck/tests, and focused line extraction).

## Findings

### Critical (P0)

- **None verified in this codebase snapshot.**

### High (P1)

1. **File:Line:Column** `src/ui/components/command-palette.tsx:18:7`  
   **Category** Async|Resilience  
   **Violation** Floating promise on supervisor execution (`void supervisor.executeTask(...)`) and immediate UI closure. Errors are never surfaced to operator; failures are silent.  
   **Concrete fix** Replace fire-and-forget call with awaited flow and explicit error channel:
   - Change `useInput` handler to `async`-safe wrapper that sets local `isRunning` state.
   - `await supervisor.executeTask(...)` and render success/failure status before `onClose()`.
   - If keeping non-blocking UX, attach `.catch(...)` that logs structured error and emits a user-visible toast/status row.
   **Risk if not fixed** Silent task failures and false operator confidence during incidents (especially dangerous when commands are expected to mutate files or infra state).

2. **File:Line:Column** `src/utils/model-config.ts:47:3` and `src/utils/model-config.ts:55:3`  
   **Category** Type|Resilience|Data Integrity  
   **Violation** Settings writes are deliberately detached (`void manager.setCurrentModel`, `void manager.updateUserSetting`). Persistent state can fail while caller assumes success.  
   **Concrete fix** Convert both functions to async and propagate failures:
   - `export async function updateCurrentModel(...)` + `await manager.setCurrentModel(...)`
   - `export async function updateDefaultModel(...)` + `await manager.updateUserSetting(...)`
   - Update call sites to await and handle write errors.
   **Risk if not fixed** Split-brain model configuration (in-memory/UI says one model, durable settings contain another), causing nondeterministic behavior across restarts.

### Medium (P2)

3. **File:Line:Column** `eslint.config.js:25:7` and `eslint.config.js:36:7`  
   **Category** Architecture|Quality Gate  
   **Violation** Lint policy allows production floating promises via `ignoreVoid: true` and fully disables `no-floating-promises` in tests. This institutionalizes silent async failures.  
   **Concrete fix**
   - Change rule to `['error', { ignoreVoid: false }]`.
   - Keep rule on for tests; use explicit `await` or `void promise.catch(...)` when intentional.
   - Add CI check to block regressions on this rule.
   **Risk if not fixed** Recurrent async error loss in new code paths (regression amplifier).

4. **File:Line:Column** `src/utils/settings-manager.ts:321:5` and `src/utils/settings-manager.ts:246:5`  
   **Category** Data Integrity|Resilience  
   **Violation** Cache is updated before durable write completion (`this.projectSettingsCache = merged`, `this.userSettingsCache = merged` before `await enqueueWrite(...)`). On disk-write failure, process can continue serving non-durable state.  
   **Concrete fix** Write-first, then publish cache:
   - Build `merged` object.
   - `await enqueueWrite(...)`.
   - Only then set in-memory cache.
   - Optionally track pending state separately to preserve responsiveness.
   **Risk if not fixed** Inconsistent behavior under I/O failures; restart-dependent bug reports and potential config rollback surprises.

5. **File:Line:Column** `src/index.tsx:81:7` and `src/index.tsx:91:7`  
   **Category** Security|Observability  
   **Violation** Full exception stacks are logged (`errorStack`) on unhandled rejection/exception paths. Stack traces often contain request snippets, local paths, and occasionally credential-bearing messages.  
   **Concrete fix**
   - Remove `errorStack` from default production logs.
   - Gate full stacks behind explicit debug env (`GROK_DEBUG_STACKS=true`).
   - Keep hash/correlation id + sanitized top-level message for incident triage.
   **Risk if not fixed** Sensitive data leakage into central logs and increased exposure during incident handling.

6. **File:Line:Column** `src/mcp/client.ts:37:1` (class spans to `428:1`)  
   **Category** Architecture|Reliability  
   **Violation** God-class concentration: trust validation, server lifecycle, idempotency, timeout/quarantine, and call dedupe are all coupled in one file/class.  
   **Concrete fix** Split into focused components:
   - `McpTrustPolicy`
   - `McpServerRegistry`
   - `McpCallGuard` (timeouts/quarantine/idempotency)
   - `McpLifecycleService` orchestration
   Add integration tests around composition boundaries.
   **Risk if not fixed** High regression probability under urgent patches; subtle failures in unrelated MCP pathways after local changes.

### Low (P3)

7. **File:Line:Column** `src/ui/components/mcp-status.tsx:14:14`  
   **Category** Observability|Error Handling  
   **Violation** Catch block intentionally swallows errors (`catch (_error)`) with no telemetry, hiding MCP initialization/lookup failures in UI status polling.  
   **Concrete fix** Log one throttled warning with component metadata and reset state; avoid fully silent failure path.  
   **Risk if not fixed** Debugging blind spots when MCP status UI is incorrect.

## PostgreSQL/SQL Surgical Review Result

- No PostgreSQL drivers, ORM, migration tooling, schema files, or SQL execution statements were found in `src/`, `test/`, or `package.json`.
- All SQL/Postgres-specific checks from the requested matrix are **non-applicable for this repository snapshot**.

## Immediate Production Incident Ranking (if deployed today)

1. **Silent palette task execution failure** (`command-palette.tsx:18`)  
   Blast radius: interactive users; operator actions appear successful while tasks can fail in background.
2. **Detached model-setting writes** (`model-config.ts:47`, `:55`)  
   Blast radius: all model-selection paths; inconsistent behavior across sessions and hosts.
3. **Unsound async lint baseline** (`eslint.config.js:25`, `:36`)  
   Blast radius: entire future codebase; materially increases probability of new incident-class async bugs.
4. **Cache-before-durable-write settings flow** (`settings-manager.ts:246`, `:321`)  
   Blast radius: settings consumers; inconsistent run-time state under write failures.
5. **Stack leakage in fatal paths** (`index.tsx:81`, `:91`)  
   Blast radius: observability pipeline; potential sensitive data exposure in logs.
