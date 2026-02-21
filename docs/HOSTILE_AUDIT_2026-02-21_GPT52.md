# Hostile Code Review Audit (Phase 1 + Phase 2)

Date: 2026-02-21  
Repository: `Grok-CLI`

## Method and verification

- Phase 1: file-by-file static review across `src/`, `test/`, `package.json`, `tsconfig*.json`, and `eslint.config.js`.
- Phase 2: adversarial re-pass focused on config, error paths, and "obvious" code paths.
- Verification commands executed:
  - `npm run -s typecheck`
  - `npm run -s test:unit`
  - `npm audit --json` (registry endpoint denied with HTTP 403 in this environment)
  - `rg -n "postgres|pg\\b|SELECT |INSERT |UPDATE |DELETE |sql|query\\(" src test`
- PostgreSQL/SQL layer status: **not present in this repository snapshot** (no SQL client/migration/query code located by repo-wide scan).

## Findings

### 1) Critical (P0)

- None verified.

### 2) High (P1)

#### P1-1: Terminal escape-sequence injection from untrusted MCP metadata
- **File:Line:Column:** `src/commands/mcp.ts:319:15`, `src/commands/mcp.ts:355:13`
- **Category:** Security
- **Specific violation:** Tool names/descriptions returned by remote MCP servers are interpolated and printed directly to the terminal (`console.log`) without escaping control characters.
- **Concrete fix suggestion:** Introduce a shared `sanitizeTerminalText()` helper that strips ANSI/OSC control sequences (including `\x1b]...\x07`/ST variants), and wrap `displayName`/`tool.description` before logging.
- **Risk if not fixed:** Malicious MCP servers can inject terminal control payloads (spoofed prompts/output, clipboard exfiltration via OSC52 in vulnerable terminals), creating operator deception and potential secret leakage.

#### P1-2: Terminal escape-sequence injection from repository file names in search output
- **File:Line:Column:** `src/tools/search.ts:503:17`
- **Category:** Security
- **Specific violation:** File paths are rendered into terminal output without control-character scrubbing.
- **Concrete fix suggestion:** Apply the same terminal sanitization routine to `file` and `query` before formatting output in `formatUnifiedResults()`.
- **Risk if not fixed:** A crafted filename committed to a repo can poison terminal output and mislead operators during incident response/code review.

### 3) Medium (P2)

#### P2-1: MCP timeout/output env knobs are not range-validated
- **File:Line:Column:** `src/mcp/transports.ts:76:7`
- **Category:** Security|Resilience
- **Specific violation:** `MCP_TOOL_TIMEOUT_MS`, `MCP_CHILD_KILL_GRACE_MS`, and `MCP_MAX_OUTPUT_BYTES` are accepted as raw strings from environment/config and forwarded without numeric bounds checking.
- **Concrete fix suggestion:** Parse each as integer and enforce strict ranges (e.g., timeout 1000..120000, kill grace 100..10000, output cap 64KB..10MB); reject config on invalid values.
- **Risk if not fixed:** Misconfiguration (or malicious project config) can create effectively unbounded runtime behavior or pathological kill timing that degrades reliability under load.

#### P2-2: `useInputHandler` is a 773-line multi-responsibility hotspot
- **File:Line:Column:** `src/hooks/use-input-handler.impl.ts:34:1`
- **Category:** Architecture
- **Specific violation:** The hook handles command parsing, git flow, UI state, confirmation behavior, and control-flow branching in a single large file.
- **Concrete fix suggestion:** Split into focused modules (`git-ops`, `command-routing`, `confirmation-flow`, `state-transitions`) and inject dependencies behind interfaces.
- **Risk if not fixed:** Elevated regression risk and slower incident fixes because unrelated behavior changes are tightly coupled.

### 4) Low (P3)

- None beyond routine maintainability nits.

## Immediate-incident ranking (if deployed today)

1. **P1-1 MCP metadata terminal injection**
   - **Blast radius:** every operator running `grok mcp list`/`grok mcp test` against untrusted or compromised MCP servers.
2. **P1-2 Search-result terminal injection**
   - **Blast radius:** every operator searching repositories containing adversarial filenames.
3. **P2-1 Unvalidated MCP runtime env knobs**
   - **Blast radius:** all MCP stdio subprocess lifecycles in environments with custom MCP_* overrides.
4. **P2-2 `useInputHandler` hotspot**
   - **Blast radius:** ongoing change velocity and defect rate in interactive command handling.

## Dual-pass verification note

Each finding above was checked in two passes:
1. Primary pass: direct code-path inspection and threat modeling.
2. Adversarial re-pass: explicit re-check of catch/error and output formatting paths to validate exploitability and operational impact.
