# Hostile Code Review Audit (Phase 1 + Phase 2)

Date: 2026-02-21
Scope reviewed: `src/**`, `test/**`, `tsconfig*.json`, `eslint.config.js`, `package.json`

## Method
- Automated pass: `npm run -s typecheck`, `npm run -s lint`, targeted pattern scans via `rg -n`.
- Manual adversarial pass on high-risk files (`bash.ts`, `mcp/client.ts`, `settings-manager.ts`, `commit-and-push-handler.ts`, config files).
- Re-check pass focused on catch/finally blocks and configuration drift surfaces.

## Critical (P0)
- None confirmed in this pass.

## High (P1)

1) **LLM data exfiltration path for staged secrets during commit flow**
- **File:Line:Column**: `src/hooks/commit-and-push-handler.ts:70:1`
- **Category**: Security
- **Violation**: Full staged diff (`git diff --cached`) and status are embedded into an LLM prompt without secret scrubbing.
- **Concrete fix**: Replace raw diff prompt input with a redacted summary pipeline: (a) run a secret scanner over staged hunks, (b) remove matching lines, (c) send only filenames + semantic summary. Keep commit message generation local/fallback when secrets are detected.
- **Risk if not fixed**: Credential/material leakage to model provider context during normal `/commit-and-push` usage.

2) **Destructive git subcommands allowed in autonomous bash tool surface**
- **File:Line:Column**: `src/tools/bash.ts:37:1`
- **Category**: Security
- **Violation**: `GIT_ALLOWED_SUBCOMMANDS` includes state-mutating operations (`checkout`, `switch`, `reset`, `merge`, `rebase`, `cherry-pick`) in a tool designed for agent execution.
- **Concrete fix**: Split git policy into read-only default and privileged mutating mode. In default mode allow only `status`, `diff`, `log`, `show`, `rev-parse`, `branch`. Gate mutating commands behind explicit per-command confirmation.
- **Risk if not fixed**: Repository integrity loss (history rewrites, unintended resets/merges) from prompt-level mistakes or prompt injection.

## Medium (P2)

3) **Write queue cleanup can leave temp directories on failure path**
- **File:Line:Column**: `src/utils/settings-manager.ts:260:1`
- **Category**: Resilience
- **Violation**: In async write path, `fs.remove(tempDir)` executes only on happy path; failures before cleanup can strand temp dirs and stale files.
- **Concrete fix**: Wrap temp-file workflow in `try/finally` and always `await fs.remove(tempDir).catch(() => {})` in `finally`.
- **Risk if not fixed**: Disk clutter and operational drift over long-running environments; eventual IO noise/failures.

4) **Security linting coverage excludes non-src runtime scripts**
- **File:Line:Column**: `eslint.config.js:7:1`
- **Category**: Architecture
- **Violation**: Lint target scope is `src/**` and `test/**`; executable shell-adjacent JS/TS in `scripts/**` is not linted for `no-floating-promises`, etc.
- **Concrete fix**: Extend ESLint files glob to include `scripts/**/*.ts` and `*.js` runtime utilities with appropriate parser overrides.
- **Risk if not fixed**: Silent regressions in CI/packaging scripts that can impact release integrity.

5) **No strict indexed-access guarantee in default compiler path**
- **File:Line:Column**: `tsconfig.json:1:1`
- **Category**: Type
- **Violation**: `noUncheckedIndexedAccess` exists only in `tsconfig.strict.json` but default build/typecheck uses `tsconfig.json`/`tsconfig.ci.json`, weakening undefined safety around map/array indexing.
- **Concrete fix**: Enable `"noUncheckedIndexedAccess": true` in `tsconfig.json` and fix resulting diagnostics.
- **Risk if not fixed**: Runtime `undefined` dereferences in edge cases not caught by CI.

## Low (P3)

6) **Ambiguous parse failure UX in bash tokenizer**
- **File:Line:Column**: `src/tools/bash.ts:732:1`
- **Category**: Type/UX
- **Violation**: Unclosed quote/escape returns empty token list, surfacing as generic "Command cannot be empty".
- **Concrete fix**: Return explicit parser error (`Unterminated quote/escape`) and plumb into `execute` result.
- **Risk if not fixed**: Operator confusion and slower incident triage.

7) **Factory bypasses singleton confirmation lifecycle**
- **File:Line:Column**: `src/utils/confirmation-service.ts:194:1`
- **Category**: Architecture
- **Violation**: `createConfirmationService()` returns `new ConfirmationService()` while production code uses singleton `getInstance()`, enabling divergent state models.
- **Concrete fix**: Remove public constructor path or make factory delegate to `getInstance()` unless explicitly testing.
- **Risk if not fixed**: Inconsistent confirmation policy behavior across call sites/tests.

## Phase 2 re-check notes
- Re-checked config surfaces (`package.json`, `tsconfig*.json`, `eslint.config.js`): no immediate supply-chain result due `npm audit` endpoint 403 in this environment.
- Re-checked catch/finally paths in `mcp/client.ts` and `settings-manager.ts`; primary resilience gap remained temp-dir cleanup on failure.
- Re-checked "obvious" safe code in commit flow; strongest practical risk remained prompt exfiltration of staged secrets.

## Immediate-incident ranking (if deployed today)
1. **P1: Commit-flow exfiltration (`commit-and-push-handler.ts`)**
   - **Blast radius**: Any user invoking `/commit-and-push`; potential leakage of credentials and proprietary code in staged hunks.
2. **P1: Mutating git command surface (`bash.ts`)**
   - **Blast radius**: Any autonomous or tool-driven git action; can rewrite history or destroy local work.
3. **P2: Settings temp-dir accumulation (`settings-manager.ts`)**
   - **Blast radius**: Long-lived sessions/CI agents; gradual operational degradation.
