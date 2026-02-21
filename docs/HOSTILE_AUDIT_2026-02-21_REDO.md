# Hostile Code Review Audit (Phase 1 + Phase 2)

Date: 2026-02-21  
Repo: `Grok-CLI`  
Scope: `src/**/*.ts`, `src/**/*.tsx`, `test/**/*.ts`, `package.json`, `tsconfig*.json`, `eslint.config.js`

## Method

- Phase 1: systematic per-file review of runtime paths (`src/index.tsx`, `src/grok/*`, `src/mcp/*`, `src/tools/*`, `src/utils/*`, `src/commands/*`, `src/ui/*`) plus tests and config.
- Phase 2: adversarial re-pass focused on “obvious” code, error paths (`catch` blocks), config files (`tsconfig*`, eslint), and dependencies (`package.json`, lockfile/audit command).
- Verification model per finding:
  1. source-level inspection at exact location, and
  2. secondary validation using tests/lint/typecheck and targeted command output.

## Non-applicable domain notes

- No PostgreSQL integration, SQL migrations, or DB driver usage were found in this snapshot (`pg`, Prisma, Knex, Drizzle, Sequelize absent). PostgreSQL-specific checks were evaluated as **not applicable** for this repository revision.

---

## 1) Critical (P0)

- None verified in current snapshot.

## 2) High (P1)

### P1-1
- **File:Line:Column:** `src/tools/bash.ts:38:3`, `src/tools/bash.ts:39:3`, `src/tools/bash.ts:40:3`, `src/tools/bash.ts:41:3`
- **Category:** Security|Architecture
- **Violation:** `BashTool` allowlist includes network-capable Git subcommands (`push`, `pull`, `fetch`, `remote`). In an agentic execution context, this permits unreviewed outbound network and repository mutation actions.
- **Concrete fix suggestion:** In `GIT_ALLOWED_SUBCOMMANDS`, remove `push`, `pull`, `fetch`, `remote` from default policy. Re-introduce only behind explicit high-friction confirmation + dedicated allow flag (e.g. `GROK_ENABLE_NETWORK_GIT=1`).
- **Risk if not fixed:** Data exfiltration or destructive remote operations triggered by prompt/tool misuse. Blast radius includes any repo where the tool runs and has credentials/configured remotes.
- **Verification:** Source inspection + policy review under `executeArgs`/`validateGitArgs` confirms these subcommands are accepted.

### P1-2
- **File:Line:Column:** `src/utils/settings-manager.ts:264:5`, `src/grok/client.ts:131:7`
- **Category:** Security|Transport integrity
- **Violation:** API base URL is loaded from environment/settings without scheme/host validation and passed directly into API client construction.
- **Concrete fix suggestion:** Validate base URL before use: enforce `https:` scheme by default, block private-network/loopback hosts unless explicitly opted in, and reject credential-bearing URLs. Implement in `SettingsManager.getBaseURL()` (or a dedicated validator) before `new OpenAI(...)`.
- **Risk if not fixed:** Misconfiguration or malicious config can route model traffic (including API key-bearing requests) to insecure/untrusted endpoints.
- **Verification:** Source inspection confirms direct pass-through from config/env to OpenAI `baseURL`.

## 3) Medium (P2)

### P2-1
- **File:Line:Column:** `src/commands/mcp.ts:288:34`
- **Category:** Security|Observability
- **Violation:** MCP server list output prints full stdio command + args. Sensitive tokens passed in args are exposed to terminal/session logs.
- **Concrete fix suggestion:** Redact argument values matching secret patterns (`token`, `key`, `secret`, `password`, bearer-like strings) before rendering; optionally show only command basename + arg count.
- **Risk if not fixed:** Credential disclosure to shell history capture, CI logs, support transcripts, or terminal recordings.
- **Verification:** Source inspection of list rendering path.

### P2-2
- **File:Line:Column:** `src/utils/logger.ts:9:28`, `src/utils/logger.ts:26:3`
- **Category:** Security|Logging hygiene
- **Violation:** Redaction is key-name based only. Secret-bearing free-form strings in error messages/stack fragments are logged verbatim.
- **Concrete fix suggestion:** Add value-level scrubbing in `sanitize()` for common token formats (Bearer tokens, long hex/base64-like secrets, private key markers) before emission.
- **Risk if not fixed:** Sensitive material can leak despite structured logging redaction.
- **Verification:** Source inspection shows no value-pattern sanitization for string payloads except truncation.

### P2-3
- **File:Line:Column:** `package.json:12:5`
- **Category:** Security|Supply chain
- **Violation:** Dependency vulnerability audit cannot complete in this environment due to npm advisory API 403; high/critical CVE posture is currently unverifiable.
- **Concrete fix suggestion:** Add CI fallback scanner that does not depend solely on npm advisory endpoint (e.g., OSV-based lockfile scan); fail builds on unresolved high/critical findings.
- **Risk if not fixed:** Vulnerable dependencies may pass undetected in constrained environments.
- **Verification:** `npm audit --audit-level=high --json` returns `403 Forbidden` from advisory endpoint.

## 4) Low (P3)

### P3-1
- **File:Line:Column:** `src/agent/supervisor.ts:24:3`
- **Category:** Type|Architecture
- **Violation:** Task identity and resource identifiers are plain `string` types without branding (`TaskId`, `ServerName`, etc.).
- **Concrete fix suggestion:** Introduce branded ID types and parse/construct boundaries (pattern used elsewhere via `parseMCPServerName`) across task orchestration paths.
- **Risk if not fixed:** Increased chance of identifier mix-ups and weaker compile-time guarantees in orchestrator code.
- **Verification:** Interface definitions and map keys are generic strings.

---

## Immediate production-incident ranking (if deployed today)

1. **P1-1: Git network subcommands exposed in agent shell policy**  
   - **Blast radius:** any workspace with configured remotes/credentials.
2. **P1-2: Unvalidated outbound model endpoint (`baseURL`)**  
   - **Blast radius:** all model API traffic; potential key/traffic interception on insecure endpoints.
3. **P2-1: MCP command/arg disclosure in CLI output**  
   - **Blast radius:** operator terminals, logs, and recorded sessions.
