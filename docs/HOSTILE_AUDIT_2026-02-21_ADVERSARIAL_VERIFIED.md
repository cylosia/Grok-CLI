# Hostile Production Audit (Phase 1 + Phase 2)

Date: 2026-02-21
Scope: `/workspace/Grok-CLI` TypeScript codebase (no PostgreSQL access layer found in-repo)
Method:
- Pass A: broad static sweep (`rg`, config inspection, dependency/scripts review)
- Pass B: adversarial re-check of error paths/config/large files (`bash.ts`, `mcp/client.ts`, `settings-manager.ts`, `search.ts`, `tsconfig*`, `package.json`)

## Critical (P0)

None verified in current repository snapshot.

## High (P1)

### 1) TOCTOU path validation gap before command execution
- **File:Line:Column**: `src/tools/bash.ts:461:1`, `src/tools/bash.ts:490:1`, `src/tools/bash.ts:152:1`
- **Category**: Security | Async/Concurrency
- **Violation**: Paths are validated/canonicalized first, but process execution occurs later with a mutable filesystem boundary. A symlink swap between validation and `spawn()` can redirect file operations to unintended targets.
- **Concrete fix**: Open file descriptors or use `openat`-style guarded operations where possible; for command execution, resolve and freeze all path operands immediately before spawn and re-check inode/device metadata (`lstat`) for each path-bearing arg right before execution.
- **Risk if not fixed**: Local adversary (or malicious concurrent process) can race command execution and cause unauthorized file reads/writes outside intended workspace policy.

### 2) Unhandled exception path in `SearchTool.setCurrentDirectory`
- **File:Line:Column**: `src/tools/search.ts:522:1`
- **Category**: Resilience | Error Handling
- **Violation**: `fs.realpathSync(resolved)` throws on missing/inaccessible path, and this method does not catch/normalize the error into `ToolResult` style output.
- **Concrete fix**: Replace with guarded async/sync branch:
  - `if (!await fs.pathExists(resolved)) return controlled error`
  - wrap `realpathSync` in `try/catch` and throw typed domain error (`SearchDirectoryError`) handled by caller.
- **Risk if not fixed**: CLI crash/abrupt command failure from user-controlled path input (denial-of-service of interactive session).

## Medium (P2)

### 3) Type-safety regression window in CI profile (`noUncheckedIndexedAccess` not enforced)
- **File:Line:Column**: `tsconfig.json:2:1`, `tsconfig.ci.json:3:1`, `tsconfig.strict.json:3:1`
- **Category**: Type
- **Violation**: Hardening flag `noUncheckedIndexedAccess` exists only in strict variant, but CI typecheck uses `tsconfig.ci.json` extending base config without enabling it.
- **Concrete fix**: Enable `"noUncheckedIndexedAccess": true` in base `tsconfig.json` (preferred) or explicitly in `tsconfig.ci.json` to block unsafe indexed reads in production checks.
- **Risk if not fixed**: Undefined access bugs escape CI, especially in parser/manipulation code using `arr[i]` and dictionary indexing.

### 4) God-object / SRP breach in security-critical managers
- **File:Line:Column**: `src/tools/bash.ts:47:1`, `src/mcp/client.ts:38:1`, `src/utils/settings-manager.ts:187:1`
- **Category**: Architecture
- **Violation**: Single classes combine policy, parsing, validation, state, I/O, and orchestration across 400–600+ LOC.
- **Concrete fix**: Split into composable units:
  - `BashPolicyValidator`, `PathCanonicalizer`, `CommandRunner`
  - `McpServerRegistry`, `McpCallExecutor`, `McpQuarantineController`
  - `SettingsStore`, `SettingsSanitizer`, `SettingsCrypto/SecretsFacade`
- **Risk if not fixed**: Higher defect density in edge paths; security patches become risky and slow.

### 5) Singleton mutable global state with cwd-sensitive behavior
- **File:Line:Column**: `src/utils/settings-manager.ts:187:1`, `src/utils/settings-manager.ts:208:1`
- **Category**: Architecture | Concurrency
- **Violation**: Process-wide singleton caches settings while path source depends on `process.cwd()`; long-running sessions with cwd changes can cross-contaminate expectations.
- **Concrete fix**: Remove singleton or key instances by workspace root; inject cwd/provider explicitly and avoid implicit global process state.
- **Risk if not fixed**: Incorrect project settings applied under concurrency/multi-workspace usage; hard-to-reproduce behavior.

### 6) PostgreSQL controls are non-auditable from this repo snapshot
- **File:Line:Column**: `src/** (no DB access layer found)`
- **Category**: SQL | Data Integrity
- **Violation**: No SQL migrations/query layer/pool config present, so required checks (transaction isolation, N+1, index design, rollback semantics) cannot be verified in this codebase.
- **Concrete fix**: Add/point audit scope to DB repo or include migration/query modules and runtime DB config in this repository; require schema-level checks in CI.
- **Risk if not fixed**: False sense of security for financial-grade deployment; latent DB faults remain unassessed.

## Low (P3)

### 7) Exhaustiveness hardening missing in transport switch
- **File:Line:Column**: `src/mcp/transports.ts:201:1`
- **Category**: Type
- **Violation**: `switch(config.type)` has runtime default throw but no compile-time `assertNever` pattern.
- **Concrete fix**: Add `const _exhaustive: never = config.type;` in default branch and use discriminated unions to force compile-time exhaustiveness.
- **Risk if not fixed**: Future transport types may compile with partially updated handling.

### 8) Minor formatting/consistency debt in error construction
- **File:Line:Column**: `src/tools/search.ts:125:1`
- **Category**: Maintainability
- **Violation**: Inconsistent spacing before comma in object literal error path.
- **Concrete fix**: Apply lint autofix or format-on-save for stylistic consistency.
- **Risk if not fixed**: Low direct risk; contributes to noisy diffs and reduced signal in security patches.

---

## Immediate incident ranking (if deployed as-is)

1. **P1 TOCTOU path validation race (`bash.ts`)**
   - **Blast radius**: Any host running CLI with shared/mutable workspace filesystem; can bypass path-policy intent.
2. **P1 unhandled `realpathSync` throw (`search.ts`)**
   - **Blast radius**: All CLI sessions using search directory change path; user input can terminate operation flow.
3. **P2 typecheck gap (`tsconfig` CI profile)**
   - **Blast radius**: Entire codebase over time; undefined-access bugs can slip into release branches.

## Notes on requested PostgreSQL audit surface

No PostgreSQL query/migration/pool code is present in this repository snapshot. SQL-focused findings are therefore limited to scope gaps rather than query-level defects.
