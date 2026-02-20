# Hostile Production Audit (Financial-Grade Standards)

## Methodology

### Phase 1 — Systematic decomposition
I reviewed the TypeScript codebase file-by-file with focus on trust boundaries, async behavior, type safety, and operational resilience.

### Phase 2 — Adversarial re-check
I re-reviewed:
- “obvious” paths (command execution, settings, startup flow)
- catch/fallback paths that can hide failure
- config and dependency posture (`tsconfig*.json`, `package.json`)

### Verification commands executed
- `rg --files`
- `npm run typecheck`
- `rg -n "(postgres|pg\.|Pool|SELECT|INSERT|UPDATE|DELETE|query\(|sql|typeorm|prisma|knex)" src package.json README.md`
- `rg -n "\bany\b|useState<any>|catch \(error: any\)|as unknown as|process\.env\.[A-Z0-9_]+" src tsconfig.json package.json`
- `npm audit --omit=dev --json` (failed due npm registry 403)

## PostgreSQL / SQL scope conclusion
No PostgreSQL or SQL query layer exists in this repository (no `pg` dependency, migrations, SQL files, ORM models, or DB client usage). All SQL-specific checks are therefore **N/A by absence** in this codebase.

---

## Critical (P0)

### 1) Arbitrary destructive command capability exposed via allowlist
- **File:Line:Column**: `src/tools/bash.ts:7:1`
- **Category**: Security
- **Violation**: `rm`, `cp`, `mv`, and `node` are explicitly allowlisted for AI-driven command execution, with no path sandbox and no policy layer beyond one confirmation gate.
- **Concrete fix**: Replace static allowlist with policy tiers and hard-block destructive commands by default in production (`rm`, `mv`, `cp`, `node`, `npm`). Add path sandbox enforcement and require explicit runtime capability grants.
- **Risk if not fixed**: A prompt-injected tool call can wipe or alter repository and host files; blast radius includes full workspace destruction.

### 2) Command output is accumulated unbounded in memory
- **File:Line:Column**: `src/tools/bash.ts:88:7`
- **Category**: Performance
- **Violation**: `stdout`/`stderr` buffers are appended indefinitely with no byte cap or streaming limit.
- **Concrete fix**: Enforce max captured bytes (e.g., 1–4 MB) and truncate with explicit marker; optionally stream chunks to UI.
- **Risk if not fixed**: Large-output commands (`find /`, `cat large.log`) can trigger memory pressure and process termination.

---

## High (P1)

### 3) Confirmation service has single mutable pending promise (race condition)
- **File:Line:Column**: `src/utils/confirmation-service.ts:69:5`
- **Category**: Architecture
- **Violation**: `pendingConfirmation`/`resolveConfirmation` are singleton mutable fields. Concurrent confirmation requests overwrite each other.
- **Concrete fix**: Replace with request queue keyed by requestId; resolve/reject by id and reject stale superseded requests.
- **Risk if not fixed**: Wrong operation may be approved/denied, enabling unintended file writes or command execution.

### 4) Shared mutable agent state is not concurrency-safe
- **File:Line:Column**: `src/agent/grok-agent.ts:46:3`
- **Category**: Architecture
- **Violation**: `messages`, `chatHistory`, and `abortController` are mutated across async flows without locking/single-flight protection.
- **Concrete fix**: Enforce one active session per agent instance (mutex) or isolate state per request context.
- **Risk if not fixed**: Interleaved conversations, wrong tool-call pairing, aborted wrong request, corrupted dialog state.

### 5) Sensitive source code exfiltration to third-party API without classification guard
- **File:Line:Column**: `src/tools/morph-editor.ts:123:13`
- **Category**: Security
- **Violation**: Full file contents are posted to external API (`morphllm`) with no redaction/classification controls.
- **Concrete fix**: Add data-classification gate (deny secret-bearing files), redact known secret patterns, and require explicit per-call opt-in for external transmission.
- **Risk if not fixed**: Proprietary or secret material may leave trust boundary; compliance/security incident risk is high.

### 6) HTTP/SSE transports have no request timeout/circuit-breaker
- **File:Line:Column**: `src/mcp/transports.ts:84:5`, `src/mcp/transports.ts:187:13`
- **Category**: Resilience
- **Violation**: Axios clients are created without timeout/retry budget; hung endpoints can stall execution indefinitely.
- **Concrete fix**: Set `timeout`, bounded retries with backoff+jitter, and failure-open/close policy with circuit breaker.
- **Risk if not fixed**: Long hangs, cascading latency, tool plane partial outage under network degradation.

### 7) Startup/auth configuration lacks strict validation model
- **File:Line:Column**: `src/ui/app.tsx:5:1`, `src/index.tsx:40:5`
- **Category**: Security
- **Violation**: Environment validation is ad hoc and duplicated; no centralized schema validation for required runtime config.
- **Concrete fix**: Introduce a single `loadConfig()` with strict schema (e.g., Zod `.strict()`), fail-fast before app boot, and pass validated config object.
- **Risk if not fixed**: Drift between entrypoints and inconsistent fail behavior in production environments.

---

## Medium (P2)

### 8) Type boundary erosion through pervasive `any` at trust boundaries
- **File:Line:Column**: `src/types/index.ts:5:1`, `src/tools/search.ts:236:15`, `src/utils/token-counter.ts:27:28`, `src/ui/components/chat-interface.tsx:14:61`
- **Category**: Type
- **Violation**: `any` is used in core tool result and parsing/state code, weakening static guarantees.
- **Concrete fix**: Replace with explicit discriminated unions/interfaces; introduce runtime schema parsing for external JSON.
- **Risk if not fixed**: Malformed payloads propagate to privileged operations undetected.

### 9) Secret persistence in plaintext settings file without explicit file-mode hardening
- **File:Line:Column**: `src/utils/settings-manager.ts:69:5`
- **Category**: Security
- **Violation**: API keys are written to JSON under home dir without setting restrictive mode on write.
- **Concrete fix**: Prefer OS keychain/credential store; if file fallback is required, use `fs.writeFileSync(..., { mode: 0o600 })` and validate existing permissions.
- **Risk if not fixed**: Credential exposure on multi-user hosts and backup pipelines.

### 10) Insert path bypasses confirmation flow unlike other file writes
- **File:Line:Column**: `src/tools/text-editor.ts:59:3`
- **Category**: Security
- **Violation**: `insert()` writes directly to disk but does not request confirmation, unlike `create`, `strReplace`, and `replaceLines`.
- **Concrete fix**: Reuse the same confirmation gate and diff preview in `insert()`.
- **Risk if not fixed**: Policy inconsistency allows silent file mutation path.

### 11) Error swallowing hides initialization and connectivity failures
- **File:Line:Column**: `src/agent/grok-agent.ts:103:5`, `src/mcp/client.ts:102:7`, `src/mcp/transports.ts:96:7`
- **Category**: Resilience
- **Violation**: Broad catches suppress concrete errors and proceed with partially initialized state.
- **Concrete fix**: Log structured error (redacted), attach failure reason to health state, and surface degraded mode explicitly.
- **Risk if not fixed**: Latent production failures become silent and hard to diagnose.

---

## Low (P3)

### 12) Strictness profile is diluted for financial-grade expectations
- **File:Line:Column**: `tsconfig.json:10:5`
- **Category**: Type
- **Violation**: `exactOptionalPropertyTypes` is disabled in primary config (only enabled in `tsconfig.strict.json`).
- **Concrete fix**: Enable strict options in default build config and enforce in CI (`npm run typecheck` against strict profile).
- **Risk if not fixed**: Optional-property ambiguity and hidden nullish bugs in production build path.

### 13) Dependency risk posture not verifiable in CI run (audit endpoint blocked)
- **File:Line:Column**: `package.json:1:1`
- **Category**: Security
- **Violation**: Vulnerability scan could not complete due registry access policy (403), leaving dependency risk unverified.
- **Concrete fix**: Add alternate SCA source in CI (e.g., GitHub Advisory / Snyk / OSV scanner) and fail builds on critical advisories.
- **Risk if not fixed**: Known vulnerable packages can ship undetected.

---

## Immediate incident ranking (if deployed today)

1. **P0: AI-enabled destructive command surface (`src/tools/bash.ts`)**
   - **Blast radius**: entire workspace and potentially host/user files if process has permissions.
2. **P0: Unbounded command output buffering (`src/tools/bash.ts`)**
   - **Blast radius**: process OOM, CLI crash, production automation outage.
3. **P1: Confirmation race (`src/utils/confirmation-service.ts`)**
   - **Blast radius**: unauthorized file/command action due cross-request confirmation mix-up.
4. **P1: Concurrency-unsafe shared agent state (`src/agent/grok-agent.ts`)**
   - **Blast radius**: corrupted conversation/tool execution state across concurrent operations.
5. **P1: Source exfiltration by design without governance (`src/tools/morph-editor.ts`)**
   - **Blast radius**: proprietary code/secret leakage to external provider.

## Notes on requested “two-subagent verification”
This environment does not expose a multi-subagent orchestration primitive. I compensated by doing two independent passes (systematic + adversarial) and validating findings with direct source inspection and command-based probes.
