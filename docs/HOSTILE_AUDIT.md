# Hostile Production Audit (TypeScript/PostgreSQL Checklist)

## Methodology
- Phase 1 (systematic): inspected all files in `src/`, plus `package.json`, `tsconfig.json`, `tsconfig.strict.json`, `.eslintrc.js`.
- Phase 2 (adversarial): re-checked obvious paths, catch blocks, runtime config, and dependency posture.
- Verification commands:
  - `rg -n "\b(pg|postgres|postgresql|sql|SELECT|INSERT|UPDATE|DELETE|transaction|pool|client\.query|query\()" src package.json tsconfig*.json .eslintrc.js`
  - `npm run -s typecheck`
  - `npm audit --omit=dev --json`

## PostgreSQL scope result
No PostgreSQL integration exists in this repository (no `pg` dependency, migrations, SQL query layer, or schema files). SQL/Postgres checks were performed as absence checks and are N/A for direct query-level findings.

---

## Critical (P0)

### 1) AI-to-shell command injection in commit flow
- **File:Line:Column**: `src/hooks/use-input-handler.ts:482:29`
- **Category**: Security
- **Violation**: AI-generated text is interpolated into `git commit -m "${cleanCommitMessage}"` and executed via shell.
- **Concrete fix**: Replace with `spawn("git", ["commit", "-m", cleanCommitMessage], { shell: false })`; reject newlines/control characters.
- **Risk if not fixed**: Prompt injection can execute arbitrary commands.

### 2) Raw shell execution in core bash tool
- **File:Line:Column**: `src/tools/bash.ts:51:40`
- **Category**: Security
- **Violation**: `execAsync(command)` executes raw command strings from UI/tool paths.
- **Concrete fix**: Replace `exec` with argument-safe `spawn/execFile`; add strict policy allowlist.
- **Risk if not fixed**: RCE and destructive filesystem/network operations.

### 3) Global cwd mutation race (`process.chdir`)
- **File:Line:Column**: `src/tools/bash.ts:37:11`
- **Category**: Architecture
- **Violation**: Tool mutates process-wide cwd, affecting unrelated concurrent operations.
- **Concrete fix**: Remove `process.chdir`; keep cwd in instance state only and pass `cwd` to subprocess calls.
- **Risk if not fixed**: Cross-task corruption and commands targeting wrong directories.

---

## High (P1)

### 4) File operations are not workspace-bounded
- **File:Line:Column**: `src/tools/text-editor.ts:16:26`, `src/tools/text-editor.ts:168:26`, `src/tools/text-editor.ts:205:13`
- **Category**: Security
- **Violation**: `path.resolve(filePath)` is used without root-boundary checks.
- **Concrete fix**: Resolve against workspace root and reject paths outside it.
- **Risk if not fixed**: Arbitrary read/write (e.g., `~/.ssh`, dotfiles, CI secrets).

### 5) Sensitive payload logging in transport error path
- **File:Line:Column**: `src/mcp/transports.ts:244:5`
- **Category**: Security
- **Violation**: Logs full `message` payload before throwing.
- **Concrete fix**: Remove or redact structured fields before logging.
- **Risk if not fixed**: Secret/token/PII leakage to logs.

### 6) Insecure fallback credential in runtime path
- **File:Line:Column**: `src/index.tsx:40:32`
- **Category**: Security
- **Violation**: Falls back to literal `"demo-key"` when `GROK_API_KEY` is unset.
- **Concrete fix**: Fail fast at startup if API key is missing.
- **Risk if not fixed**: Misconfigured prod instances silently run with invalid auth assumptions.

### 7) Plaintext API key persistence without permission hardening
- **File:Line:Column**: `src/utils/settings-manager.ts:69:5`
- **Category**: Security
- **Violation**: API key is persisted in user settings JSON without explicit mode restrictions.
- **Concrete fix**: Store secrets in OS keychain or write files with `0o600`; avoid storing key in project files.
- **Risk if not fixed**: Local credential disclosure on shared systems.

---

## Medium (P2)

### 8) Type safety regression: current codebase does not typecheck
- **File:Line:Column**: `src/tools/morph-editor.ts:351:19`, `src/tools/text-editor.ts:36:19`, `src/tools/search.ts:201:19`, `src/ui/components/loading-spinner.tsx:41:22`
- **Category**: Type
- **Violation**: `npm run -s typecheck` fails with implicit `any`, `unknown` misuse, and missing runtime typings.
- **Concrete fix**: Resolve all TS errors; gate CI on zero type errors.
- **Risk if not fixed**: Compile-time guarantees are unreliable, defects ship unnoticed.

### 9) Unsafe narrowing via double-cast in task delegation
- **File:Line:Column**: `src/agent/parallel.ts:36:35`
- **Category**: Type
- **Violation**: `task as unknown as Record<string, unknown>` bypasses structural safety.
- **Concrete fix**: Define shared `Task` contract and pass typed value without cast.
- **Risk if not fixed**: Malformed task payloads can break runtime logic silently.

### 10) No retry/backoff around model API calls
- **File:Line:Column**: `src/grok/client.ts:66:28`, `src/grok/client.ts:93:26`
- **Category**: Resilience
- **Violation**: Chat and stream calls have no retry policy for transient 429/5xx errors.
- **Concrete fix**: Add bounded exponential backoff with jitter and idempotent retry conditions.
- **Risk if not fixed**: Avoidable outages under provider throttling or transient network faults.

### 11) Streamable HTTP transport path is intentionally non-functional
- **File:Line:Column**: `src/mcp/transports.ts:248:11`
- **Category**: Architecture
- **Violation**: `send()` always throws for `streamable_http`.
- **Concrete fix**: Implement protocol-compliant request/response path or disable the transport from CLI options.
- **Risk if not fixed**: Production feature advertised but guaranteed to fail.

---

## Low (P3)

### 12) Non-null assertion on API key in UI bootstrap
- **File:Line:Column**: `src/ui/app.tsx:6:42`
- **Category**: Type
- **Violation**: `process.env.GROK_API_KEY!` suppresses nullability checks.
- **Concrete fix**: Validate env at startup and thread a validated config object.
- **Risk if not fixed**: Hard-to-debug runtime failures and inconsistent startup behavior.

### 13) Overuse of `any` in protocol and state surfaces
- **File:Line:Column**: `src/mcp/transports.ts:160:23`, `src/utils/settings-manager.ts:18:31`, `src/agent/memory.ts:4:31`
- **Category**: Type
- **Violation**: `any` erodes validation at trust boundaries.
- **Concrete fix**: Replace with explicit interfaces plus runtime schema validation (e.g., Zod).
- **Risk if not fixed**: Invalid payloads propagate into privileged operations.

---

## Phase 2 adversarial re-check summary
- Re-checked “obvious” shell command paths and found the highest-severity bug in `/commit-and-push` commit command construction.
- Re-checked error paths and found sensitive logging in `StreamableHttpClientTransport.send`.
- Re-checked configs and dependencies: strict mode is enabled but currently unenforced due existing compile failures; `npm audit` could not complete due registry 403.

## Immediate incident ranking (if deployed today)
1. **AI-to-shell command injection in commit flow** — blast radius: full host compromise from prompt injection.
2. **Raw shell execution in bash tool** — blast radius: arbitrary command execution and data destruction.
3. **Global cwd mutation race** — blast radius: cross-request corruption and unintended repo modifications.
4. **Unbounded filesystem path access** — blast radius: secret exfiltration and writes outside workspace.
5. **Sensitive payload logging** — blast radius: credential/PII leakage via logs.
