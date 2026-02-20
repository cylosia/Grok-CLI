# Hostile Production Audit (TypeScript-focused)

## Scope and method
- Pass 1: manual file-by-file static inspection of `src/`, `tsconfig.json`, and `package.json`.
- Pass 2 (adversarial re-check): revisited stubs, error paths, and configuration files (`tsconfig.json`, `package.json`) plus a compiler run (`npm run -s typecheck`).
- Note: No PostgreSQL integration exists in this repository (no `pg` dependency, SQL migrations, or SQL query layer), so SQL/Postgres checks are marked N/A for concrete code findings.

---

## Critical (P0)

### 1) Infinite recursion / startup crash in agent construction
- **File:Line:Column**: `src/agent/grok-agent.ts:75:23`, `src/agent/supervisor.ts:31:22`
- **Category**: Architecture
- **Violation**: `GrokAgent` constructor always creates `AgentSupervisor`, while `AgentSupervisor` constructor always creates `GrokAgent`, causing recursive construction and likely stack overflow / process crash.
- **Concrete fix**: Break the cycle with dependency injection: pass a lazy `SupervisorFactory` into `GrokAgent` or remove `new GrokAgent()` from `AgentSupervisor` constructor and create workers only on demand via a non-recursive factory.
- **Risk**: Immediate production outage at runtime (service cannot initialize agent graph).

### 2) Core runtime intentionally stubbed (non-functional production path)
- **File:Line:Column**: `src/agent/grok-agent.ts:84:3`, `src/agent/grok-agent.ts:85:3`, `src/agent/grok-agent.ts:86:3`, `src/grok/client.ts:23:3`, `src/mcp/client.ts:23:3`
- **Category**: Architecture
- **Violation**: Core methods are placeholders returning empty/stub responses (`processUserMessage`, stream generator, tool execution, MCP manager methods), yet wired into runtime paths.
- **Concrete fix**: Replace stubs with concrete implementations before release; add fail-fast guards (`throw new Error("Not implemented")`) if intentionally incomplete to prevent silent bad behavior.
- **Risk**: Silent functional failure, incorrect outputs, inability to execute critical business workflows.

### 3) Unrestricted shell execution fallback
- **File:Line:Column**: `src/agent/index.ts:83:5`
- **Category**: Security
- **Violation**: Any unrecognized input is executed as a bash command via `return this.bash.execute(trimmedInput);`.
- **Concrete fix**: Remove fallback shell execution; require explicit `bash` prefix and enforce allowlist/denylist with policy checks.
- **Risk**: Prompt-injection-to-RCE path, accidental destructive command execution.

### 4) Command injection in git checkpoint API
- **File:Line:Column**: `src/agent/git-suite.ts:11:55`
- **Category**: Security
- **Violation**: User-controlled `name` is interpolated into shell command (`git commit -m "checkpoint: ${name}"`) without escaping.
- **Concrete fix**: Use `spawn("git", ["commit", "-m", `checkpoint: ${name}`])` or sanitize/escape commit message strictly.
- **Risk**: Arbitrary command execution if crafted checkpoint names are accepted upstream.

---

## High (P1)

### 5) Global `stderr.write` monkey patch introduces race and log integrity corruption
- **File:Line:Column**: `src/grok/tools.ts:306:3`
- **Category**: Architecture
- **Violation**: Mutating global `process.stderr.write` affects unrelated concurrent operations and may suppress critical errors.
- **Concrete fix**: Do not patch global stderr; instead capture child process stderr locally in transport layer and filter there.
- **Risk**: Hidden production failures and difficult incident response due to lost error logs.

### 6) TypeScript configuration does not model runtime environment correctly
- **File:Line:Column**: `tsconfig.json:5:12`, `tsconfig.json:11:5`
- **Category**: Type
- **Violation**: `lib` is only `ES2022` and `types` does not include Node; this causes missing core runtime types (`process`, `events`, `AbortController`) during typecheck.
- **Concrete fix**: Add `"types": ["node"]` and set appropriate libs (or rely on Node typings) to align compile-time and runtime semantics.
- **Risk**: Broken CI/type safety; latent type regressions ship undetected.

### 7) CLI/API confirmation contract broken in parallel executor
- **File:Line:Column**: `src/agent/parallel.ts:16:75`, `src/agent/parallel.ts:17:13`
- **Category**: Type
- **Violation**: `requestConfirmation` expects `ConfirmationOptions` and returns `ConfirmationResult`, but code passes `task.description` and treats result as boolean.
- **Concrete fix**: Call `requestConfirmation({ operation, filename, content }, "file"|"bash")` and branch on `.confirmed`.
- **Risk**: Confirmation bypass/incorrect branching; potentially unauthorized operations.

### 8) Shell-based VS Code opener vulnerable to argument injection
- **File:Line:Column**: `src/utils/confirmation-service.ts:116:25`
- **Category**: Security
- **Violation**: Uses `execAsync(`${cmd} "${filename}"`)`; a filename containing quotes can break quoting and inject shell syntax.
- **Concrete fix**: Use `spawn(cmd, [filename], { shell: false })` and avoid shell interpolation entirely.
- **Risk**: Local code execution in environments where filename/path is attacker-controlled.

### 9) Over-broad unsafe typing (`any`) on security-sensitive pathways
- **File:Line:Column**: `src/grok/client.ts:3:27`, `src/mcp/client.ts:18:16`, `src/commands/mcp.ts:99:23`
- **Category**: Type
- **Violation**: `any` is used for protocol payloads/tool schemas/error handling, disabling compile-time guarantees around tool-call args and API responses.
- **Concrete fix**: Introduce strict interfaces + runtime validation (e.g., Zod) for tool arguments and MCP payloads; replace `catch (error: any)` with safe narrowing.
- **Risk**: Malformed payloads and unhandled edge cases escape validation into privileged operations.

---

## Medium (P2)

### 10) Missing implementation for model discovery fallback path
- **File:Line:Column**: `src/grok/model-discovery.ts:29:3`
- **Category**: Architecture
- **Violation**: `detectOllamaModels` is a placeholder returning `[]`.
- **Concrete fix**: Implement provider discovery or remove dead API surface until complete.
- **Risk**: Misleading capability exposure and operator confusion.

### 11) No SQL/Postgres layer present despite production claims
- **File:Line:Column**: `package.json:12:3-26:4`
- **Category**: SQL
- **Violation**: No PostgreSQL client/dependency, migrations, or query abstractions found.
- **Concrete fix**: Add explicit data layer (client, migration system, schema constraints, transaction policy) or correct system claims/documentation.
- **Risk**: Architectural mismatch; expected financial persistence controls are absent.

### 12) Build hygiene gaps increase defect escape rate
- **File:Line:Column**: `tsconfig.json:8:5`, `tsconfig.json:17:5`, `tsconfig.json:18:5`
- **Category**: Type
- **Violation**: `exactOptionalPropertyTypes` disabled; unused locals/params checks disabled.
- **Concrete fix**: Enable `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters` in CI profile; enforce lint/type gates.
- **Risk**: Dead code and subtle optional-property bugs reach production.

---

## Phase 2 adversarial re-check notes
- Rechecked “obvious” code paths and caught the recursive constructor cycle and shell fallback in `Agent` class.
- Rechecked catch/error paths and found shell interpolation in VS Code opener.
- Rechecked config/package and confirmed compiler environment mismatch and absence of SQL/data-layer artifacts.
- Verified with compiler run that type integrity is currently broken (`npm run -s typecheck` fails heavily).

---

## Immediate incident ranking (if deployed today)
1. **Recursive constructor cycle** (`grok-agent` ↔ `supervisor`) — **blast radius: total service startup failure**.
2. **Stubbed core execution paths** (agent/client/MCP stubs) — **blast radius: all user operations return empty/incorrect results**.
3. **Implicit shell execution fallback** (`Agent.processCommand`) — **blast radius: full host compromise / destructive command execution**.
4. **Git checkpoint command injection** — **blast radius: arbitrary command execution in repo host environment**.
5. **Global stderr monkey patch** — **blast radius: cross-cutting observability loss, incident triage impairment**.
