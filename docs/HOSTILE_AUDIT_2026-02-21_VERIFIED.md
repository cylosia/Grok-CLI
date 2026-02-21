# Hostile Audit (Verified) — 2026-02-21

Scope: TypeScript CLI codebase under `src/`, config files, tests, and dependency manifest.

## Verification commands executed
- `npm run -s typecheck`
- `npm run -s lint`
- `npm run -s test:unit`
- `python` import-graph cycle detection over `src/**/*.ts(x)`
- `npm audit --omit=dev --json` (registry access denied in this environment)
- `rg -n "postgres|\bpg\b|sequelize|prisma|knex" src test package.json`

## Phase 1 + Phase 2 findings

### P1 (High)
1. **File: `src/commands/mcp.ts:300:13`**  
   **Category:** Security  
   **Violation:** Terminal output injection window: `server.transport.command` is printed without `sanitizeTerminalText(...)`; attacker-controlled config can embed escape sequences.  
   **Fix:** Change `console.log(\`  Command: ${server.transport.command} ...\`)` to sanitize both command and rendered args before output.  
   **Risk:** Operator terminal spoofing/log tampering, including deceptive prompt rewriting and hidden text.

2. **File: `src/tools/bash.ts:133:28` + `src/tools/bash.ts:390:26`**  
   **Category:** Security/Concurrency  
   **Violation:** TOCTOU path validation race: path is validated (`validatePathArg`) before execution, but filesystem can change between check and command use (symlink swap race).  
   **Fix:** For path-bearing commands, resolve all path args to canonical absolute paths at validation time and execute only canonicalized immutable paths (or open descriptors and use fd-based operations where possible).  
   **Risk:** Workspace escape under concurrent local attacker conditions.

### P2 (Medium)
3. **File: `src/mcp/url-policy.ts:104:1`**  
   **Category:** Security  
   **Violation:** MCP URL validation does not explicitly reject embedded URL credentials (`user:pass@host`), unlike `sanitizeAndValidateBaseUrl`.  
   **Fix:** Parse username/password and throw if either is present before DNS validation.  
   **Risk:** Secret leakage in config snapshots, logs, telemetry, and support bundles.

4. **File: `tsconfig.json:1:1` + `tsconfig.strict.json:1:1`**  
   **Category:** Type  
   **Violation:** `noUncheckedIndexedAccess` is enabled only in `tsconfig.strict.json`; default compile path (`npm run build`) does not enforce it.  
   **Fix:** Promote `noUncheckedIndexedAccess: true` into `tsconfig.json` and remediate resulting index access sites.  
   **Risk:** Latent `undefined` access bugs in production code paths.

5. **File: `src/utils/settings-manager.ts:216:11`**  
   **Category:** Performance/Architecture  
   **Violation:** Synchronous filesystem I/O (`existsSync`, `statSync`, `readFileSync`, sync atomic writes) on runtime settings paths in core service singleton.  
   **Fix:** Move load/save to async-only code paths and warm caches at startup; preserve atomicity with async write+rename flow.  
   **Risk:** Event-loop stalls and degraded responsiveness under slow filesystems or network home directories.

### P3 (Low)
6. **File: `src/mcp/client.ts:1:1`, `src/agent/grok-agent.ts:1:1`, `src/utils/settings-manager.ts:1:1`, `src/grok/tools.ts:1:1`**  
   **Category:** Architecture  
   **Violation:** Large multi-responsibility files (345–440 LOC) increase defect density and reduce reviewability.  
   **Fix:** Split by responsibility (transport policy, lifecycle management, tool registry, persistence), keep files <250 LOC where feasible.  
   **Risk:** Higher change-failure rate and slower incident response.

## PostgreSQL/SQL-specific review result
No PostgreSQL integration, SQL query layer, or migration framework is present in this repository snapshot (`rg` scans returned no SQL/ORM usage). That means SQL-specific controls (transaction isolation, FK/index quality, migration safety, deadlock ordering, JSONB index strategy) cannot be verified here and should be audited in the actual service repository containing DB access code.

## Immediate-incident ranking (if deployed today)
1. `src/commands/mcp.ts:300` terminal injection output path (operator deception risk, broad blast radius for anyone using `mcp list`).
2. `src/tools/bash.ts` TOCTOU path race (local privilege boundary bypass risk; blast radius limited to shared-host or adversarial local process scenarios).
3. `src/mcp/url-policy.ts` credential-bearing URLs accepted (secret exposure risk; blast radius includes logs/config distribution).
