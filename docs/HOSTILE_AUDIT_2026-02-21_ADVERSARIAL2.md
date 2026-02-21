# Hostile Code Review Audit (Financial-Grade Pass)

Date: 2026-02-21  
Repo: `Grok-CLI`

## Method (Phase 1 + Phase 2)

- Phase 1 decomposition: reviewed all TypeScript/runtime/config surfaces and checked strict typing posture, async boundaries, command-exec safety, settings persistence, MCP transport hardening, and test coverage boundaries.
- Phase 2 adversarial re-pass: rechecked “obvious” paths, catch blocks, and config gates (`package.json`, `tsconfig*.json`, `eslint.config.js`, `scripts/audit-ci.sh`).
- Validation commands run:
  - `npm run -s typecheck`
  - `npm run -s lint`
  - `npm test -s`
  - `npm audit --audit-level=high --json`
  - `bash scripts/audit-ci.sh`

## PostgreSQL/SQL scope result

- No PostgreSQL runtime layer, migrations, SQL query code, or `pg` usage is present in this repository snapshot, so SQL-specific findings (indexes, transaction isolation, lock ordering, migration safety) are not directly applicable in this codebase state.

---

## 1) Critical (P0)

- None verified.

## 2) High (P1)

### P1-1
- **File:Line:Column:** `scripts/audit-ci.sh:23:1`, `package.json:35:3`
- **Category:** Security|Supply-chain|Resilience
- **Violation:** Security gate depends on `command -v osv-scanner` fallback, but the repo does not pin `osv-scanner` as a dependency; in constrained CI, `npm audit` fails (verified 403) and fallback scanner is often absent.
- **Concrete fix:** Add a pinned scanner executable in CI image or lockfile-managed tool (for example, install/pin scanner in CI build image and enforce presence before gate execution). Keep `audit-ci.sh` fail-closed behavior, but make scanner availability deterministic.
- **Risk if not fixed:** Releases can be blocked unexpectedly or run without timely CVE visibility depending on runner image drift.

## 3) Medium (P2)

### P2-1
- **File:Line:Column:** `src/tools/bash.ts:50:1`
- **Category:** Type|Security|Correctness
- **Violation:** `PATH_ARG_COMMANDS` includes `echo`; this causes every `echo` positional argument to be treated as a filesystem path and canonicalized to absolute paths during normalization.
- **Concrete fix:** Remove `echo` from `PATH_ARG_COMMANDS`, and only apply path canonicalization to commands with true path semantics.
- **Risk if not fixed:** Command behavior drift (`echo hello` mutates into `echo /workspace/.../hello`), accidental path disclosure, and brittle tool behavior under automation.

### P2-2
- **File:Line:Column:** `src/utils/confirmation-service.ts:141:1`
- **Category:** Async|Resilience
- **Violation:** `openInVSCode` resolves its Promise immediately after `spawn`, before confirming process start success; late `error` events can be dropped after resolve.
- **Concrete fix:** Resolve on `spawn` event (or after next tick with guarded error state) and reject on error before resolve; alternatively use `child.once("spawn", resolve)` and `child.once("error", reject)`.
- **Risk if not fixed:** False-positive “opened editor” state during confirmation UX, making operational debugging noisy and non-deterministic.

## 4) Low (P3)

### P3-1
- **File:Line:Column:** `src/tools/bash.ts:1:1`, `src/tools/text-editor.impl.ts:1:1`, `src/hooks/use-input-handler.impl.ts:1:1`, `src/tools/search.ts:1:1`
- **Category:** Architecture|Maintainability
- **Violation:** Multiple “god files” (>500 LOC) mixing policy, IO, formatting, orchestration, and state management, increasing review blind spots and bug density.
- **Concrete fix:** Split by responsibility (policy/validation, execution adapters, formatting, and state). Enforce per-module size guardrails in lint/review policy.
- **Risk if not fixed:** Higher regression risk and slower incident response when touching critical flows.

---

## Immediate incident ranking (if deployed today)

1. **P1-1 (supply-chain scanner determinism)**  
   - **Blast radius:** CI release gate across all build runners/environments.  
   - **Incident mode:** nondeterministic vulnerability visibility and/or blocked release trains.
2. **P2-1 (bash echo path canonicalization)**  
   - **Blast radius:** all agent-executed `echo` operations and any workflow depending on literal output.  
   - **Incident mode:** incorrect command execution and path leakage in logs/output.
3. **P2-2 (VS Code spawn resolve race)**  
   - **Blast radius:** interactive confirmation workflow only.  
   - **Incident mode:** misleading operational state and harder troubleshooting.
