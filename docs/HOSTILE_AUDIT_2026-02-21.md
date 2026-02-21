# Hostile Production Audit (2026-02-21)

Scope reviewed: `src/**/*.ts`, `src/**/*.tsx`, `test/**/*.ts`, and root config (`package.json`, `tsconfig*.json`, `eslint.config.js`).

This repository is TypeScript CLI/TUI code; **no PostgreSQL client, migrations, SQL query layer, or schema DDL files are present**.

## Method (Phase 1 + Phase 2)

- **Phase 1 (systematic decomposition):** file-by-file review of security-critical and stateful modules (`tools/`, `mcp/`, `utils/`, `index.tsx`, major UI command surfaces), plus targeted static scans.
- **Phase 2 (adversarial re-review):** explicit re-check of error-handling paths, config files, package manifest, and “obvious” allowlist code.
- **Dual verification per finding:**
  1. direct source-level validation at exact line/column, and
  2. independent command/runtime validation (repro command or static pattern command).

## Findings

### Critical (P0)

- **None verified.**

### High (P1)

1. **File:Line:Column:** `src/tools/bash.ts:236:3` (with policy roots at `:12:1`, `:19:1`)
   - **Category:** Security|Command Sandbox
   - **Violation:** Git argument validation only handles `-C` and post-`--` path args. Path-bearing and execution-relevant flags like `--git-dir`, `--work-tree`, `--config-env`, `--exec-path` are not validated/blocked. This bypasses the workspace path confinement model.
   - **Concrete fix:**
     - Extend `PATH_FLAGS_BY_COMMAND.git` and `validateGitArgs()` to parse and validate at least: `--git-dir`, `--work-tree`, `--namespace`, `--super-prefix`, `--exec-path`, plus `--*=value` variants.
     - Add denylist entries for execution-influencing flags (`--config-env`, `--exec-path`) if not explicitly required.
     - Prefer a strict subcommand allowlist (`status`, `diff`, `log`, `show`) over generic `git` passthrough.
   - **Risk if not fixed:** Policy bypass enables reads/operations outside the workspace boundary and increases command-execution abuse surface.
   - **Verification:**
     - Static: inspected `validateGitArgs` and command flag maps.
     - Runtime: `npx -y tsx -e "import { BashTool } from './src/tools/bash.ts'; import { ConfirmationService } from './src/utils/confirmation-service.ts'; (async()=>{ConfirmationService.getInstance().setSessionFlag('bashCommands', true); const t=new BashTool(); const r=await t.executeArgs('git',['--git-dir=/etc','status']); console.log(JSON.stringify(r));})();"` (command reaches git and returns git-level error instead of policy rejection).

2. **File:Line:Column:** `src/tools/morph-editor.ts:167:25`
   - **Category:** Security|Error Handling
   - **Violation:** Raw remote error payload (`response.data`) is stringified and included in thrown error text.
   - **Concrete fix:** Replace
     - `throw new Error(\`Morph API error (...): ${String(maybeError.response.data ?? '')}\`)`
     with
     - `throw new Error(\`Morph API error (${status})\`)`
     and emit sanitized structured telemetry with redaction/truncation (no raw body).
   - **Risk if not fixed:** Secret/token leakage and large untrusted payload reflection into logs/UI error channels.
   - **Verification:**
     - Static: inspected catch block in Morph API wrapper.
     - Pattern check: `rg -n "Morph API error \(" src/tools/morph-editor.ts`.

### Medium (P2)

3. **File:Line:Column:** `src/index.tsx:134:19`
   - **Category:** Type|Resilience
   - **Violation:** `JSON.stringify(result, null, 2)` is used on arbitrary model/tool output. If `result` includes `bigint` (or circular data), this throws and converts success path into fatal CLI error.
   - **Concrete fix:** Replace with hardened serializer (e.g., shared `safeJsonStringify` with bigint and circular guards) and fallback output path.
   - **Risk if not fixed:** Intermittent production CLI failures on otherwise successful operations.
   - **Verification:**
     - Static: inspected CLI output serialization path.
     - Pattern check: `rg -n "JSON\.stringify\(result" src/index.tsx`.

4. **File:Line:Column:** `src/tools/text-editor.impl.ts:9:1`, `src/tools/search.ts:42:1`, `src/tools/bash.ts:37:1`
   - **Category:** Architecture|Maintainability
   - **Violation:** Very large multi-responsibility classes (613, 513, 506 LOC respectively) mix validation, policy, execution, and formatting logic.
   - **Concrete fix:** Split each into focused modules:
     - policy/validation,
     - executor/IO,
     - formatter/UX output,
     - state/session handling.
     Add contract tests for each boundary.
   - **Risk if not fixed:** Elevated regression rate in incident patches; high cognitive load hiding subtle bugs.
   - **Verification:**
     - Static: class boundaries inspected.
     - Command: `wc -l src/tools/text-editor.impl.ts src/tools/search.ts src/tools/bash.ts`.

### Low (P3)

5. **File:Line:Column:** `src/ui/voice-input.tsx:13:5`
   - **Category:** Observability|Security Hygiene
   - **Violation:** Direct `console.log` in UI component initialization bypasses structured logger/redaction pipeline.
   - **Concrete fix:** Replace with `logger.info("voice-mode-activated", { component: "voice-input" })` and remove raw console usage.
   - **Risk if not fixed:** Inconsistent logging, harder correlation/PII governance.
   - **Verification:**
     - Static: inspected component effect hook.
     - Pattern check: `rg -n "console\.log\(" src/ui/voice-input.tsx`.

## PostgreSQL / SQL Surgical Review Result

- No SQL/Postgres runtime layer detected (`pg`, `postgres`, Prisma/Knex/TypeORM/Drizzle, migration directories, SQL strings).
- Requested SQL-specific checks are **not applicable** to this code snapshot.

## Immediate Production Incident Ranking (if deployed today)

1. **BashTool git sandbox bypass (`src/tools/bash.ts`)**
   - **Blast radius:** all users invoking shell tooling; potential workspace-boundary escape attempts.
2. **Morph API raw error-body propagation (`src/tools/morph-editor.ts`)**
   - **Blast radius:** any Morph edit failure path; leak surface into logs/operator output.
3. **CLI brittle JSON serialization (`src/index.tsx`)**
   - **Blast radius:** CLI mode users; successful operations can be reported as failures due to serialization exceptions.
