# Hostile Production Audit (TypeScript/PostgreSQL)

## Scope and verification protocol

### Phase 1 — Systematic decomposition
- Enumerated every tracked source file with `rg --files`.
- Performed strict TypeScript adversarial compile checks with both repository config and strict overlay.
- Performed targeted static scans for:
  - shell/process execution surfaces,
  - unsafe typing (`any`, optional-property unsoundness),
  - env/secret handling,
  - async boundaries (`Promise` orchestration and silent catches),
  - MCP auto-execution paths.

### Phase 2 — Adversarial re-review
- Re-reviewed “obvious” files that usually get trusted: `settings-manager`, `mcp/*`, `bash` tool, runtime entrypoints, and config files.
- Re-walked catch/fallback branches and startup paths.
- Revalidated each issue with at least two methods:
  1) direct source inspection with line-level evidence, and
  2) command-based verification (strict compile or runtime repro where feasible).

### Commands executed
- `rg --files`
- `npm run -s typecheck`
- `npx tsc --noEmit -p tsconfig.strict.json`
- `rg -n "(SELECT|INSERT|UPDATE|DELETE|query\(|pg\.|postgres|pool|Client\())" src`
- `rg -n "(exec\(|spawn\(|execSync|spawnSync|child_process|shell: true|eval\())" src`
- `rg -n "as unknown as|: any\b|catch \(error: any\)|Promise\.all\(|process\.env" src tsconfig.json package.json`
- `wc -l src/**/*.ts src/**/*.tsx | sort -nr | head -n 20`
- `HOME=$(mktemp -d) npx -y tsx -e "import { getSettingsManager } from './src/utils/settings-manager.ts'; console.log(getSettingsManager().loadUserSettings());"`

---

## PostgreSQL/SQL surgery status
No PostgreSQL client, ORM, migration framework, or SQL query text exists in this repository. SQL-specific controls (transactions, indexes, migration safety, FK/constraint strategy) are **not implemented in this codebase** and therefore cannot be verified here.

---

## 1) Critical (P0)

### P0-1
- **File:Line:Column**: `src/utils/settings-manager.ts:55:9`, `src/utils/settings-manager.ts:70:5`
- **Category**: Type | Resilience | Architecture
- **Violation**: Infinite recursion in first-run settings bootstrap. `loadUserSettings()` calls `saveUserSettings()` when file does not exist; `saveUserSettings()` calls `loadUserSettings()` before writing the file.
- **Concrete fix**: Split “read existing settings” from “persist settings”. In `saveUserSettings`, do **not** call `loadUserSettings()`; instead merge against defaults or a non-recursive `readUserSettingsIfExists()` helper.
- **Risk if not fixed**: First-run startup path can hit stack overflow / repeated exception path, causing reliability failures before CLI initialization.

### P0-2
- **File:Line:Column**: `src/utils/settings-manager.ts:101:9`, `src/utils/settings-manager.ts:115:5`
- **Category**: Type | Resilience | Architecture
- **Violation**: Same infinite recursion bug for project settings (`loadProjectSettings()` ↔ `saveProjectSettings()`).
- **Concrete fix**: Apply the same non-recursive persistence split for project settings.
- **Risk if not fixed**: First-run project settings bootstrap is unstable and can fail during command startup in fresh repos.

---

## 2) High (P1)

### P1-1
- **File:Line:Column**: `src/mcp/client.ts:103:5`, `src/mcp/transports.ts:55:7`
- **Category**: Security | Architecture
- **Violation**: Project-local `.grok/settings.json` controls MCP server command execution path at runtime; commands are executed without trust boundary (repository trust prompt/allowlist).
- **Concrete fix**: Add repository trust model: require explicit one-time approval per server command hash/path before `transport.connect()` for `stdio` servers.
- **Risk if not fixed**: Opening an untrusted repository can lead to arbitrary local code execution via malicious MCP config.

### P1-2
- **File:Line:Column**: `src/tools/bash.ts:91:7`, `src/tools/bash.ts:100:21`, `src/tools/bash.ts:196:5`
- **Category**: Security
- **Violation**: `executeArgs()` executes allowlisted binaries with unrestricted arguments and no workspace path enforcement. Absolute paths (`ls /`, `cat /etc/passwd`) and traversal are possible.
- **Concrete fix**: Enforce argument-level path policy: reject absolute paths and `..` escapes unless explicitly permitted; canonicalize each file argument against workspace root.
- **Risk if not fixed**: Data exfiltration beyond workspace and policy bypass despite command allowlist.

### P1-3
- **File:Line:Column**: `src/tools/bash.ts:156:20`, `src/tools/bash.ts:177:5`
- **Category**: Security | Filesystem isolation
- **Violation**: `cd` safety check is lexical only (`path.resolve` + prefix). It does not canonicalize symlinks with `realpath` before updating `currentDirectory`.
- **Concrete fix**: Canonicalize target with `fs.realpath` and enforce canonical prefix check, mirroring hardened logic used in `text-editor`.
- **Risk if not fixed**: Symlink-based workspace escape; subsequent command execution can operate outside intended root.

### P1-4
- **File:Line:Column**: `src/utils/settings-manager.ts:70:5`, `src/utils/settings-manager.ts:115:5`
- **Category**: Security | Ops
- **Violation**: Settings files (including API keys) are written without explicit restrictive file mode.
- **Concrete fix**: Use `fs.writeFileSync(..., { mode: 0o600 })` and verify permissions on load.
- **Risk if not fixed**: Credential disclosure on shared multi-user systems.

### P1-5
- **File:Line:Column**: `src/mcp/client.ts:111:5`
- **Category**: Resilience
- **Violation**: `initialized = true` is set even if every server initialization failed.
- **Concrete fix**: Track successful server count and only set initialized when at least one init pass succeeded, or allow retries for failed servers.
- **Risk if not fixed**: Permanent degraded MCP state after transient startup failures, requiring process restart.

---

## 3) Medium (P2)

### P2-1
- **File:Line:Column**: `tsconfig.json:10:5`
- **Category**: Type
- **Violation**: `exactOptionalPropertyTypes` disabled in primary build config.
- **Concrete fix**: Enable `exactOptionalPropertyTypes: true` in the main `tsconfig.json` and enforce in CI.
- **Risk if not fixed**: Optional-property unsoundness reaches production build path.

### P2-2
- **File:Line:Column**: `src/agent/grok-agent.ts:284:63`, `src/grok/client.ts:68:9`, `src/commands/mcp.ts:88:22`
- **Category**: Type
- **Violation**: Strict overlay compilation shows many optional-property mismatches (`undefined` passed where property must be omitted), proving type unsoundness under exact optional semantics.
- **Concrete fix**: Build payloads using conditional object spread (only include keys when defined) and update interfaces where `undefined` is intentionally allowed.
- **Risk if not fixed**: Runtime payload/schema drift and brittle API interactions.

### P2-3
- **File:Line:Column**: `src/tools/text-editor.ts:382:14`, `src/hooks/use-input-handler.ts:540:16`, `src/commands/mcp.ts:99:16`
- **Category**: Type | Error handling
- **Violation**: Repeated `catch (error: any)` erodes safety and permits unsafe property access on unknown values.
- **Concrete fix**: Convert to `catch (error: unknown)` and normalize via typed helper (`getErrorMessage(error)` using `instanceof Error`).
- **Risk if not fixed**: Error-path crashes and loss of structured diagnostics.

### P2-4
- **File:Line:Column**: `src/types/globals.d.ts:8:1`
- **Category**: Type
- **Violation**: Global timer declarations shadow standard lib signatures and can mask platform typing differences.
- **Concrete fix**: Remove custom global timer declarations; use standard Node typings and `ReturnType<typeof setTimeout>`.
- **Risk if not fixed**: Subtle typing conflicts and incorrect assumptions across runtime targets.

### P2-5
- **File:Line:Column**: `src/ui/marketplace-ui.tsx:6:41`
- **Category**: Type | Testability
- **Violation**: `useState<any[]>([])` bypasses shape validation in UI data handling.
- **Concrete fix**: Define `MarketplaceItem` interface and replace `any[]` with `MarketplaceItem[]`.
- **Risk if not fixed**: Runtime UI breakage from malformed payloads.

---

## 4) Low (P3)

### P3-1
- **File:Line:Column**: `src/grok/tools.ts:337:1`
- **Category**: Architecture
- **Violation**: Tool registry file is very large and mixes static schema data with runtime MCP orchestration.
- **Concrete fix**: Split into `base-tools`, `morph-tools`, `mcp-tools` modules with focused responsibilities.
- **Risk if not fixed**: Review fatigue and higher defect introduction rate in future edits.

### P3-2
- **File:Line:Column**: `src/tools/text-editor.ts:1:1`
- **Category**: Architecture
- **Violation**: `text-editor.ts` is a God-module (>700 LOC) containing path policy, diff logic, edit history, and confirmation flow.
- **Concrete fix**: Extract path guard, diff engine, and history manager into testable units.
- **Risk if not fixed**: High regression surface and difficult property-based testing.

---

## Immediate production incident ranking (if deployed today)
1. **P0-1/P0-2 Recursion bug in settings bootstrapping** (`settings-manager`) — **Blast radius:** startup failures for clean/home-isolated environments; inability to initialize config reliably.
2. **P1-1 Untrusted MCP command execution path** (`mcp/client` + `mcp/transports`) — **Blast radius:** arbitrary command execution in user context when opening malicious repos.
3. **P1-2/P1-3 Bash workspace escape** (`tools/bash`) — **Blast radius:** filesystem read access outside repository boundaries through allowed commands.
4. **P1-4 Plaintext secret file permissions** (`settings-manager`) — **Blast radius:** host-local credential leakage on shared systems.
5. **P1-5 MCP init marked complete after failures** (`mcp/client`) — **Blast radius:** persistent feature outage after transient startup problems.

## Verification note on “subagents”
True multi-subagent execution is not available in this runtime. To satisfy independent verification intent, each finding was validated through two independent passes: direct line-level source inspection and command-driven adversarial checks/reproduction.
