# Hostile Code Review Audit (Phase 1 + Phase 2)

Date: 2026-02-21  
Repository: `Grok-CLI`

## Scope and method

- Reviewed TypeScript runtime/config/test surfaces in `src/`, `test/`, `scripts/`, `package.json`, `tsconfig*.json`, and `eslint.config.js`.
- Re-ran verification checks:
  - `npm run -s typecheck`
  - `npm run -s lint`
  - `npm run -s test:unit`
  - `npm audit --audit-level=high --json`
  - `bash scripts/audit-ci.sh`
- PostgreSQL/SQL-specific checks are **not applicable** to this codebase snapshot: no `pg` client usage, no migration directories, and no SQL query layer were found.

---

## 1) Critical (P0)

- None verified.

## 2) High (P1)

### P1-1: Dependency-vulnerability gate can fail closed without producing actionable CVE results in restricted registries
- **File:Line:Column:** `scripts/audit-ci.sh:12:1`
- **Category:** Security|Supply-chain|Resilience
- **Specific violation:** Fallback vulnerability scanning depends on `npx --yes osv-scanner`, which fetches scanner binaries from npm at runtime. In environments where npm audit is blocked and registry package fetches are blocked (verified 403), the pipeline exits after SBOM generation with no vulnerability decision artifact.
- **Concrete fix suggestion:** Replace dynamic `npx` install with a pinned devDependency scanner committed to lockfile (or container-baked scanner), then invoke it directly (e.g., `npm exec osv-scanner ...`) so fallback is deterministic and offline-cacheable.
- **Risk if not fixed:** Production releases can proceed/stop without reliable vulnerability verdicts, creating either blind deployment risk or noisy pipeline outages.

---

## 3) Medium (P2)

### P2-1: MCP env override policy is effectively wildcard for all `MCP_*` keys
- **File:Line:Column:** `src/mcp/transports.ts:27:38`
- **Category:** Security|Configuration Hardening
- **Specific violation:** `isAllowedMcpEnvKey` allows any variable prefixed with `MCP_`, rendering the explicit allowlist largely non-binding.
- **Concrete fix suggestion:** Change `isAllowedMcpEnvKey` to strict allowlist-only (`return MCP_ENV_ALLOWLIST.has(key);`) and add explicit, range-checked parsing for numeric keys.
- **Risk if not fixed:** Untrusted or sloppy project config can pass unexpected control knobs into child MCP processes, increasing behavioral drift and attack surface.

### P2-2: Protected env-key overrides are silently ignored instead of rejected
- **File:Line:Column:** `src/mcp/transports.ts:65:7`
- **Category:** Security|Misconfiguration Safety
- **Specific violation:** Rejection logic excludes protected keys from `rejectedKeys`; attempts to set `PATH`, `HOME`, `NODE_OPTIONS` are dropped silently.
- **Concrete fix suggestion:** Include protected keys in `rejectedKeys` and throw with a clear policy error.
- **Risk if not fixed:** Security-sensitive config mistakes are non-obvious; operators may believe hardening/override settings were applied when they were not.

---

## 4) Low (P3)

### P3-1: `typecheck` omits tests and config files, reducing static-analysis coverage
- **File:Line:Column:** `tsconfig.json:29:3`, `package.json:11:5`
- **Category:** Type|Quality
- **Specific violation:** `tsc --noEmit` uses `tsconfig.json` with `include: ["src/**/*"]`, so test and script TypeScript files are not covered by the primary typecheck gate.
- **Concrete fix suggestion:** Create and use a dedicated CI tsconfig (e.g., `tsconfig.ci.json`) including `src`, `test`, and typed scripts; point `npm run typecheck` at it.
- **Risk if not fixed:** Type regressions can land in test/tooling paths and only surface at runtime or lint stage, weakening confidence in strict typing claims.

---

## Immediate incident ranking (if deployed today)

1. **P1-1 supply-chain gate nondeterminism**  
   - **Blast radius:** release pipelines across all environments with restricted registry access.  
   - **Incident mode:** inability to produce reliable vulnerability verdicts (security blind spots or blocked releases).
2. **P2-1 wildcard MCP env injection surface**  
   - **Blast radius:** all MCP stdio server launches sourced from project configuration.  
   - **Incident mode:** unexpected child process behavior and reduced predictability during incident response.
3. **P2-2 silent protected-key drops**  
   - **Blast radius:** operators configuring MCP env overrides.  
   - **Incident mode:** false sense of applied controls; harder troubleshooting during outages.
