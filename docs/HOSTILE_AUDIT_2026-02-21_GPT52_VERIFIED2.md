# Hostile Production Audit (TypeScript/PostgreSQL rubric)

Date: 2026-02-21  
Repo: `Grok-CLI`

## Audit method (Phase 1 + Phase 2)

- **Phase 1 (systematic decomposition):** reviewed all tracked TypeScript/config/test files under `src/`, `test/`, and root configs (`package.json`, `tsconfig*.json`, `eslint.config.js`, `scripts/audit-ci.sh`).
- **Phase 2 (adversarial re-pass):** re-checked error paths, retry logic, config gates, and dependency scanning paths; re-opened files with previous hardening changes.
- **Dual verification per finding:**
  1. **Pass A (mechanical):** command-driven scan (`rg`, `nl -ba`, `npm run -s typecheck`, `npm test -s`).
  2. **Pass B (semantic):** manual control-flow/data-flow re-check at exact lines below.

## PostgreSQL/SQL scope result

- No PostgreSQL client, SQL query builder/ORM, migrations, or SQL strings were found in this snapshot (`rg` checks returned no matches for `pg`, `postgres`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`).
- Therefore SQL-specific checklist items are **N/A for this codebase snapshot**.

---

## 1) Critical (P0)

- None verified.

## 2) High (P1)

### P1-1 — SSRF/network-policy bypass via DNS-resolving hostnames in `GROK_BASE_URL`
- **File:Line:Column:** `src/utils/settings-manager.ts:53:1`
- **Category:** Security
- **Specific violation:** Base URL validation only checks whether the **hostname string itself** looks private (`localhost`, `.local`, literal private IP ranges), but it does **not resolve DNS** to verify resolved IPs. A public hostname that resolves to private/link-local IP can bypass current private-network restrictions.
- **Concrete fix suggestion:** Change base URL validation to resolve A/AAAA records and deny if any resolved address is private unless explicitly opted-in (same pattern already used in MCP URL validation).
- **Risk if not fixed:** CLI can be tricked into sending API key-bearing requests to internal/private infrastructure through hostile DNS, enabling credential exfiltration or internal network reachability.

### P1-2 — Retry loop can duplicate side-effectful upstream operations
- **File:Line:Column:** `src/grok/client.ts:258:3`
- **Category:** Architecture|Resilience
- **Specific violation:** `withRetry` retries `chat` / `chatStream` requests on transport/server failures without request idempotency tokening at the API boundary. For financial-grade systems, this can double-submit non-idempotent operations triggered by model output or tool orchestration.
- **Concrete fix suggestion:** Add explicit idempotency keys per user request and propagate them to upstream API calls where supported; otherwise, disable automatic retries for operation classes that may produce side effects.
- **Risk if not fixed:** Duplicate charges/transfers/actions under intermittent network faults, with inconsistent UI state and reconciliation burden.

---

## 3) Medium (P2)

### P2-1 — Predictable temp-file path for “atomic” writes enables symlink/race abuse
- **File:Line:Column:** `src/utils/settings-manager.ts:151:3` and `src/utils/settings-manager.ts:243:7`
- **Category:** Security|Filesystem integrity
- **Specific violation:** Temp files are always written as `${filePath}.tmp`. Predictable temporary path can be attacked in hostile multi-process environments (symlink/hardlink/race patterns), undermining integrity of config writes.
- **Concrete fix suggestion:** Use `mkdtemp` + random file names opened with exclusive flags (`O_EXCL`), and perform post-open `lstat`/`fstat` checks before rename.
- **Risk if not fixed:** Corrupted settings writes or overwrite of unintended targets under local adversarial conditions.

### P2-2 — Unbounded workspace-keyed singleton map can leak memory in long-lived sessions
- **File:Line:Column:** `src/utils/settings-manager.ts:188:3`
- **Category:** Performance|Architecture
- **Specific violation:** `SettingsManager.instancesByWorkspace` grows per distinct workspace path with no eviction/upper bound.
- **Concrete fix suggestion:** Add LRU eviction or explicit disposal API; cap maximum instances.
- **Risk if not fixed:** Memory growth over long-running agent sessions that touch many repositories/workspaces.

### P2-3 — CI type gate does not enforce strongest checked-index safety
- **File:Line:Column:** `tsconfig.strict.json:1:1`, `tsconfig.ci.json:1:1`, `package.json:11:5`
- **Category:** Type
- **Specific violation:** `noUncheckedIndexedAccess` exists only in `tsconfig.strict.json` and is not used by CI `typecheck` script (`tsconfig.ci.json`).
- **Concrete fix suggestion:** Enable `noUncheckedIndexedAccess` in CI-used tsconfig and fix resulting unsafe index reads.
- **Risk if not fixed:** Undefined access bugs slip through compile-time checks and appear in production edge cases.

### P2-4 — Vulnerability scan fallback can fail without actionable advisory output
- **File:Line:Column:** `scripts/audit-ci.sh:6:1`
- **Category:** Security|Supply chain
- **Specific violation:** If `npm audit` is blocked and `osv-scanner` is unavailable, pipeline emits SBOM then exits 1, but no deterministic vulnerability verdict artifact is produced.
- **Concrete fix suggestion:** Bake pinned scanner into CI image (or devDependency lockfile path) and require machine-readable advisory output as a hard gate.
- **Risk if not fixed:** Security gating becomes environment-dependent and operationally noisy.

---

## 4) Low (P3)

### P3-1 — Mixed console output paths reduce observability consistency
- **File:Line:Column:** `src/index.tsx:14:5`, `src/ui/components/api-key-input.tsx:65:9`
- **Category:** Observability
- **Specific violation:** Production paths still use direct `console.log` in addition to structured logger.
- **Concrete fix suggestion:** Route all operational output through structured logger (with context/correlation id), reserving plain stdout only for explicit user-facing render output.
- **Risk if not fixed:** Harder incident triage and log aggregation inconsistencies.

---

## Immediate production-incident ranking (if deployed now)

1. **P1-1 SSRF via DNS-resolving base URL hosts**  
   **Blast radius:** any runtime using `GROK_BASE_URL` override.  
   **Likely incident:** API key/data egress to internal or attacker-controlled endpoints.

2. **P1-2 Non-idempotent retry duplication**  
   **Blast radius:** all chat/tool flows under transient failures.  
   **Likely incident:** duplicate side effects and billing/transaction inconsistency.

3. **P2-4 nondeterministic vuln scanning gate**  
   **Blast radius:** CI/release pipelines.  
   **Likely incident:** blocked releases or false sense of security.

4. **P2-1 predictable temp write path**  
   **Blast radius:** local host integrity where adversarial local process exists.  
   **Likely incident:** settings corruption/tampering.
