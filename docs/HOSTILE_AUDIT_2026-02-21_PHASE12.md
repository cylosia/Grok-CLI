# Hostile Production Audit (Phase 1 + Phase 2)

Date: 2026-02-21  
Repository: `Grok-CLI`  
Scope: `src/**/*.ts`, `src/**/*.tsx`, `test/**/*.ts`, `package.json`, `tsconfig*.json`, `eslint.config.js`.

## Audit execution model

- Phase 1 systematic decomposition was performed across runtime-critical modules (`tools/`, `mcp/`, `utils/`, entrypoints) plus config and tests.
- Phase 2 adversarial re-check explicitly re-reviewed:
  - "obvious" code paths (`SearchTool`, logger and CLI safety wrappers),
  - catch/error paths,
  - configuration surfaces (`tsconfig`, eslint),
  - dependency manifest (`package.json`).
- Dual verification for each finding:
  1. static source inspection at exact file/line/column, and
  2. runtime or pattern-level command verification.

## Context constraints / non-applicable domains

- No PostgreSQL driver/query layer/migrations found in this repository snapshot (`pg`, Prisma, Knex, Drizzle, SQL migrations absent). SQL/transaction/index findings are therefore non-applicable for this codebase version.

---

## 1) Critical (P0)

- None verified.

## 2) High (P1)

### P1-1: Ripgrep flag injection via untrusted query token
- **File:Line:Column:** `src/tools/search.ts:213:17`
- **Category:** Security|Command execution safety
- **Violation:** User-controlled `query` is appended directly as a positional arg without a `--` separator. Queries beginning with `-` are parsed by ripgrep as additional flags/options.
- **Concrete fix suggestion:** Change
  - `args.push(query, this.currentDirectory);`
  to
  - `args.push("--", query, this.currentDirectory);`
  and additionally reject query tokens that are empty or begin with `--` if regex mode is disabled.
- **Risk if not fixed:** Users/tools can alter search behavior, bypass intended constraints, produce malformed output formats, and trigger secondary failure modes.
- **Verification:**
  - Static source inspection at call site.
  - Runtime repro: `npx -y tsx -e "import { SearchTool } from './src/tools/search.ts'; const t=new SearchTool(); t.search('--files',{searchType:'text',maxResults:5}).then(r=>console.log(r.success,(r.output||r.error||'').slice(0,120)));"` produced non-JSON ripgrep lines and warning spam.

### P1-2: Log amplification from malformed rg JSON parsing path
- **File:Line:Column:** `src/tools/search.ts:306:9`
- **Category:** Observability|Availability
- **Violation:** `parseRipgrepOutput` logs one warning per unparsable line. Under malformed output conditions (including P1-1), this emits very high-volume logs in hot loops.
- **Concrete fix suggestion:** Add bounded logging:
  - count parse failures;
  - emit at most one warning per search invocation (or sample every N failures);
  - include aggregate counters instead of per-line exceptions.
- **Risk if not fixed:** Log flooding can degrade performance, obscure true incidents, and increase storage/egress costs.
- **Verification:**
  - Static inspection of catch block inside per-line loop.
  - Runtime repro from P1-1 emitted repeated `search-invalid-rg-json-line` warnings for a single request.

## 3) Medium (P2)

### P2-1: Output cap uses UTF-16 string length instead of byte length
- **File:Line:Column:** `src/tools/search.ts:231:13`
- **Category:** Performance|Resource control
- **Violation:** `appendWithCap` enforces `MAX_RG_OUTPUT_BYTES` using `current.length` / `chunk.length` (character count), not byte length. Multi-byte UTF-8 output can exceed intended cap.
- **Concrete fix suggestion:** Track bytes with `Buffer.byteLength(chunk, 'utf8')` and slice with byte-safe truncation logic (similar to hardened logic in `src/tools/bash.ts`).
- **Risk if not fixed:** Resource limits are porous under non-ASCII-heavy outputs, raising memory pressure and timeout risk.
- **Verification:**
  - Static inspection confirms char-length accounting.
  - Pattern check: `rg -n "MAX_RG_OUTPUT_BYTES|appendWithCap|current.length" src/tools/search.ts`.

### P2-2: Security audit gate cannot currently validate dependency CVEs in CI-like environment
- **File:Line:Column:** `package.json:12:5` (`audit:ci` script)
- **Category:** Security|Supply chain
- **Violation:** The repo has an `audit:ci` script, but practical execution in this environment fails on advisory endpoint access (`403 Forbidden`), leaving CVE status unverified for this run.
- **Concrete fix suggestion:** Add a fallback CI job that ingests an offline SBOM scanner (e.g., OSV + lockfile scan) when npm advisory API is unavailable, and fail build on unresolved high/critical findings.
- **Risk if not fixed:** Known vulnerable dependencies may ship undetected when npm advisory endpoint is blocked/unavailable.
- **Verification:**
  - Runtime command: `npm audit --audit-level=high --json` returned advisory API `403 Forbidden`.

## 4) Low (P3)

### P3-1: Large, multi-responsibility module increases regression surface
- **File:Line:Column:** `src/tools/search.ts:1:1`
- **Category:** Architecture|Maintainability
- **Violation:** Search module combines command assembly, process supervision, parsing, fallback filesystem traversal, scoring, and formatting in one class.
- **Concrete fix suggestion:** Split into:
  - `rg-command-builder`,
  - `rg-process-runner`,
  - `result-parser`,
  - `file-walker`,
  - `formatter`.
- **Risk if not fixed:** Higher defect density in emergency patches and reduced test seam clarity.
- **Verification:**
  - Static structure review.
  - Size check: `wc -l src/tools/search.ts`.

---

## Immediate production-incident ranking (deploy now)

1. **P1-1 query flag injection (`search.ts`)**
   - **Blast radius:** all search invocations that accept user/tool-provided query strings.
   - **Likely incident class:** malformed behavior, policy bypass of intended rg option constraints, and unexpected parser failures.
2. **P1-2 log amplification (`search.ts`)**
   - **Blast radius:** search-heavy workloads, especially under malformed-output conditions.
   - **Likely incident class:** observability overload, noisy alerting, increased latency/cost.
3. **P2-1 byte-cap mismatch (`search.ts`)**
   - **Blast radius:** non-ASCII/large-output repositories.
   - **Likely incident class:** memory pressure and degraded responsiveness under load.
