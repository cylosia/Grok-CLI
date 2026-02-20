# Hostile Production Audit (TypeScript/PostgreSQL Checklist)

## Scope and verification method

### Phase 1 — systematic decomposition
I performed a source-level audit across the TypeScript codebase, with targeted checks for:
- type rigor and nullability,
- async/concurrency behavior,
- security trust boundaries,
- resilience and observability,
- dependency/configuration integrity.

### Phase 2 — adversarial re-review
I re-reviewed:
- “obvious” paths (`bash`, `text-editor`, `search`, config loading),
- catch/suppression code paths,
- runtime/config files (`tsconfig*.json`, `package.json`),
- MCP integration boundaries.

### Commands executed
- `rg --files`
- `npm run typecheck`
- `rg -n "(postgres|pg\.|Pool|SELECT|INSERT|UPDATE|DELETE|query\(|sql|typeorm|prisma|knex)" src package.json README.md`
- `rg -n "as unknown as|catch \(error: any\)|process\.env|ensureServersInitialized\(\)\.catch|writeFileSync\(|resolveSafePath|--follow|Object\.values\(" src tsconfig.json package.json`

## PostgreSQL / SQL conclusion
No PostgreSQL client, ORM, migrations, or SQL query layer exists in this repository today (no `pg`/Prisma/TypeORM/Knex usage, and no SQL migration files). SQL-specific findings are therefore **N/A by absence** for this codebase.

---

## Critical (P0)

### 1) MCP server config is untrusted and cast directly into executable transport config
- **File:Line:Column**: `src/mcp/config.ts:11:20`
- **Category**: Security
- **Violation**: `Object.values(projectSettings.mcpServers) as MCPServerConfig[]` trusts unvalidated JSON from project settings. That data flows to transport creation and can execute arbitrary local commands via `StdioTransport` (`command`/`args`) without schema validation.
- **Concrete fix**: Introduce strict runtime validation (`zod`/`valibot`) for each server entry before casting. Reject entries missing required fields or with disallowed commands/URLs. Persist only validated shape.
- **Risk if not fixed**: Malicious or corrupted `.grok/settings.json` can trigger arbitrary process execution when MCP servers initialize.

### 2) Path safety check is lexical only; symlink traversal can escape workspace root
- **File:Line:Column**: `src/tools/text-editor.ts:732:3`
- **Category**: Security
- **Violation**: `resolveSafePath()` uses `path.resolve()` prefix checks but does not canonicalize with `realpath` on parent directories. Writes through symlinks inside workspace can target files outside workspace.
- **Concrete fix**: Resolve canonical paths with `fs.realpath` for workspace root and target parent, then enforce canonical-prefix checks before read/write/remove operations.
- **Risk if not fixed**: An attacker-controlled symlink inside repo can redirect edits to sensitive host files.

## High (P1)

### 3) MCP HTTP transport marks itself connected even when health probe fails
- **File:Line:Column**: `src/mcp/transports.ts:97:7`
- **Category**: Resilience
- **Violation**: Failed `/health` still sets `connected = true` unconditionally.
- **Concrete fix**: Only set connected on successful probe, or perform a fallback probe that must succeed before marking healthy; otherwise return explicit degraded/unavailable status.
- **Risk if not fixed**: False-positive readiness causes downstream call failures and operational blind spots.

### 4) `getAllGrokTools()` fires MCP initialization in background and suppresses all errors
- **File:Line:Column**: `src/grok/tools.ts:340:3`
- **Category**: Architecture
- **Violation**: `manager.ensureServersInitialized().catch(() => {})` drops initialization errors and returns tool list immediately, creating race-prone partial capability state.
- **Concrete fix**: Await initialization with bounded timeout and expose explicit health/error state to caller; do not swallow errors silently.
- **Risk if not fixed**: Non-deterministic tool availability, hard-to-debug missing-tool failures in production.

### 5) Secret persistence to disk lacks restrictive file permissions
- **File:Line:Column**: `src/utils/settings-manager.ts:69:5`
- **Category**: Security
- **Violation**: API key is written to `~/.grok/user-settings.json` without explicit mode/permission hardening.
- **Concrete fix**: Write with `mode: 0o600`, validate existing file mode, and prefer OS credential store for API secrets.
- **Risk if not fixed**: Credential exposure on shared hosts, backups, or permissive umask environments.

### 6) Search follows symlinks recursively and can read outside repo trust boundary
- **File:Line:Column**: `src/tools/search.ts:194:9`
- **Category**: Security
- **Violation**: ripgrep is executed with `--follow`; symlinks inside workspace can traverse to external directories and leak data.
- **Concrete fix**: Remove `--follow` by default, or gate it behind explicit user opt-in with path allowlist and output redaction.
- **Risk if not fixed**: Unauthorized file discovery/content leakage beyond intended workspace.

## Medium (P2)

### 7) Error handling swallows malformed settings and silently falls back to defaults
- **File:Line:Column**: `src/utils/settings-manager.ts:61:5`
- **Category**: Architecture
- **Violation**: Broad `catch` in settings load suppresses parse/IO failures with no telemetry.
- **Concrete fix**: Log structured redacted error context and surface degraded-settings warning to caller/UI.
- **Risk if not fixed**: Configuration corruption remains invisible until runtime behavior diverges.

### 8) Any-typed error paths reduce type safety at critical file-edit boundaries
- **File:Line:Column**: `src/tools/text-editor.ts:63:21`
- **Category**: Type
- **Violation**: Multiple `catch (error: any)` blocks in privileged file operations.
- **Concrete fix**: Use `unknown`, narrow via `instanceof Error`, and standardize typed error objects.
- **Risk if not fixed**: Unsafe assumptions in failure paths and reduced maintainability of high-risk code.

### 9) TypeScript financial-grade strictness profile is not enforced in default build
- **File:Line:Column**: `tsconfig.json:11:5`
- **Category**: Type
- **Violation**: `exactOptionalPropertyTypes` is disabled in main config (enabled only in secondary strict profile).
- **Concrete fix**: Enable `exactOptionalPropertyTypes` in default `tsconfig.json` and run CI typecheck against that baseline.
- **Risk if not fixed**: Optional property semantics drift and null/undefined edge-case bugs in production builds.

## Low (P3)

### 10) Dependency-lock drift risk from dual lockfiles
- **File:Line:Column**: `package-lock.json:1:1`, `bun.lock:1:1`
- **Category**: Architecture
- **Violation**: Two lockfiles exist, increasing chance of divergent dependency graphs across environments.
- **Concrete fix**: Standardize on one package manager in CI and repository policy; remove stale lockfile.
- **Risk if not fixed**: Non-reproducible builds and inconsistent vulnerability posture.

---

## Immediate production-incident ranking

1. **P0 — Unvalidated MCP config command execution path** (`src/mcp/config.ts` + transport creation):
   - **Blast radius**: arbitrary process execution in the CLI host context.
2. **P0 — Symlink path-escape in editor** (`src/tools/text-editor.ts`):
   - **Blast radius**: unauthorized overwrite/removal of files outside workspace.
3. **P1 — Search symlink-follow data exfiltration path** (`src/tools/search.ts`):
   - **Blast radius**: disclosure of sensitive files reachable from linked directories.
4. **P1 — MCP initialization race + silent failure** (`src/grok/tools.ts`, `src/mcp/transports.ts`):
   - **Blast radius**: partial outage, non-deterministic tool failures under normal operation.
5. **P1 — Plaintext API key persistence without file-mode hardening** (`src/utils/settings-manager.ts`):
   - **Blast radius**: credential compromise and account abuse.

## Note on “two subagents verifying each finding”
No multi-subagent primitive is available in this runtime. I compensated with two independent passes (systematic + adversarial) and command-backed source verification for each reported issue.
