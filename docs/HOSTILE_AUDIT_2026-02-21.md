# Hostile Production Audit (2026-02-21)

Scope: TypeScript CLI/runtime sources in `src/`, config in root, unit tests in `test/`.

## Findings

### P1

1. **Unhandled async persistence failures in model selection paths**
   - `src/utils/model-config.ts:47:3` and `src/utils/model-config.ts:55:3`
   - `updateCurrentModel` and `updateDefaultModel` fire-and-forget settings writes with `void`, so disk-write failures are silently dropped.
   - In financial-grade systems this creates split-brain config state (UI says model changed, persisted state did not).

2. **Unhandled task execution promise in interactive command palette**
   - `src/ui/components/command-palette.tsx:18:7`
   - Task execution is invoked as floating promise and immediately closes the UI, suppressing all task-level errors.
   - This creates silent execution failure and operator false-confidence during incident response.

### P2

3. **Lint policy explicitly allows suppressing floating promises**
   - `eslint.config.js:25:7`
   - `@typescript-eslint/no-floating-promises` is configured with `{ ignoreVoid: true }`, institutionalizing the same failure mode above.
   - This weakens async safety invariants repository-wide.

4. **Settings cache can diverge from durable state on async write failure**
   - `src/utils/settings-manager.ts:245:5`, `src/utils/settings-manager.ts:321:5`
   - Caches are updated before async write completion; if write fails, reads may continue serving non-durable state until process restart.
   - This can produce hard-to-reproduce behavior under disk-pressure/permissions faults.

5. **God-class risk in MCP manager (single file handles trust, lifecycle, timeout, idempotency, quarantine)**
   - `src/mcp/client.ts:37:1-428:1`
   - The class combines multiple responsibilities (trust verification, connection orchestration, timeout policy, call dedupe, quarantine).
   - High change-coupling increases regression probability in high-severity runtime paths.

## SQL/PostgreSQL applicability

No PostgreSQL clients, SQL query builders, migrations, or schema files were found in this repository snapshot; SQL-specific checks are non-applicable for this audit run.

## Verification runs

- `npm run -s typecheck`
- `npm run -s lint`
- `npm run -s test:unit`
- `npm audit --audit-level=high --json` (registry advisory endpoint returned 403 in this environment)
