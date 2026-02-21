# Hostile Production Audit (Phase 1 + Phase 2)

## Scope
- Full repository static pass (`src`, `test`, configs).
- Security + type-safety + async/concurrency + ops-focused adversarial re-pass.
- PostgreSQL-specific checks: no PostgreSQL access layer or SQL statements were found in this codebase.

## Method
1. Automated scans (`rg` patterns for async hazards, casts, SQL, unsafe APIs).
2. Strictness/config inspection (`tsconfig`, ESLint rules, package metadata).
3. Runtime validation (`typecheck`, `lint`, full unit test suite).
4. Adversarial second pass on high-risk files (`src/tools/bash.ts`, `src/mcp/client.ts`, `src/utils/settings-manager.ts`, `src/hooks/commit-and-push-handler.ts`, `src/index.tsx`).

## Findings

### High (P1)

1) **Timeout kill does not terminate subprocess trees (resource leak + runaway execution risk)**  
   - File: `src/tools/bash.ts:321:7`  
   - Category: Concurrency | Security | Performance  
   - Violation: On timeout, only the direct child process is signaled (`SIGTERM`, then `SIGKILL`), but no process-group kill is performed. Descendants can survive and continue CPU/IO work after parent exits.  
   - Concrete fix: spawn in a separate process group (`detached: true`) and on timeout kill `-child.pid` (POSIX group kill) with guarded platform branch for Windows (e.g., `taskkill /T /F`).  
   - Risk if not fixed: orphaned long-running commands can exhaust CI runners or production hosts, and continue mutating resources after caller assumes timeout safety.

2) **Same subprocess-tree timeout gap in search execution path**  
   - File: `src/tools/search.ts:225:7`  
   - Category: Concurrency | Performance  
   - Violation: `rg.kill()` targets only the direct process; process trees are not forcibly reaped via group termination.  
   - Concrete fix: mirror the process-group termination strategy from `BashTool` once fixed; centralize in a shared `spawnWithTimeoutAndGroupKill` utility to avoid drift.  
   - Risk if not fixed: repeated broad searches can accumulate orphan child processes and induce host degradation/outage under sustained usage.

3) **Repository metadata exfiltration to external model during commit flow**  
   - File: `src/hooks/commit-and-push-handler.ts:69:5`  
   - Category: Security | Architecture  
   - Violation: `/commit-and-push` sends `git status`, staged file list, and diff stats to the LLM prompt by default. In regulated environments, filenames and change metadata can contain sensitive business data.  
   - Concrete fix: require an explicit opt-in gate (`GROK_ALLOW_COMMIT_AUTOGEN=1`), add a redaction pass for paths/patterns, and provide local-only fallback commit template generation.  
   - Risk if not fixed: inadvertent disclosure of confidential repository structure and workstream metadata to external services.

### Medium (P2)

4) **Synchronous filesystem I/O on hot settings paths (event-loop blocking)**  
   - File: `src/utils/settings-manager.ts:240:3`  
   - Category: Performance | Resilience  
   - Violation: `existsSync/statSync/readFileSync` and sync atomic write are used in active control paths. Under slow/contended FS, this stalls the event loop.  
   - Concrete fix: convert read path to async `fs.promises` with cached debounce + explicit startup preload; retain atomicity via async temp-write + rename with `finally` cleanup.  
   - Risk if not fixed: CLI/TUI responsiveness degradation and timeout cascades when disk latency spikes.

5) **Teardown timeout force-detaches bookkeeping without guaranteed child termination**  
   - File: `src/mcp/client.ts:266:3`  
   - Category: Concurrency | Resilience  
   - Violation: on teardown timeout, the server is force-detached from maps, but actual transport/client shutdown may still be live in the background.  
   - Concrete fix: add transport-level hard-kill callback and track a terminal teardown state; refuse re-init until prior child PID/process-group is confirmed dead.  
   - Risk if not fixed: hidden zombie MCP backends, duplicate workers after reconnect, and difficult-to-debug resource churn.

6) **Single oversized security-critical class impairs reviewability and SRP**  
   - File: `src/tools/bash.ts:1:1`  
   - Category: Architecture  
   - Violation: file exceeds 500 lines and combines parsing, policy, path canonicalization, execution, and timeout handling.  
   - Concrete fix: split into `policy.ts`, `arg-validation.ts`, `execution.ts`, and `git-policy.ts`; keep `BashTool` as orchestration facade only.  
   - Risk if not fixed: regression probability rises; security policy and execution semantics drift over time.

### Low (P3)

7) **Command palette input handling appends raw input without editing semantics**  
   - File: `src/ui/components/command-palette.tsx:52:5`  
   - Category: UX | Quality  
   - Violation: all keystrokes append directly; no backspace/control filtering.  
   - Concrete fix: handle `key.backspace/delete`, ignore non-printables, and cap query length.  
   - Risk if not fixed: operator error rate increases and command execution reliability drops.

## PostgreSQL / SQL section
- No SQL strings, query builders, migration directories, or PostgreSQL client libraries were found in this repository during scan.
- Therefore, SQL-index/transaction/migration findings are **not applicable** for this codebase revision.

## Immediate incident ranking (if deployed as-is)
1. P1 subprocess tree timeout leak in `BashTool` (broad blast radius: host-level CPU/memory/file descriptor pressure).
2. P1 subprocess tree timeout leak in `SearchTool` (blast radius: sustained search workflows degrade service/node reliability).
3. P1 commit-flow metadata exfiltration (blast radius: confidentiality incident across private repos/regulated projects).

## Verification log
- `npm run -s typecheck` passed.
- `npm run -s lint` passed with one existing max-lines warning in `src/tools/bash.ts`.
- `npm test` passed (45/45).
- `npm audit --omit=dev --json` failed with environment 403 from registry endpoint.
