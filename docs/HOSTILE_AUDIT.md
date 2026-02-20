# Hostile Production Audit (TypeScript/PostgreSQL)

## Scope & Verification Method
- Audited all `src/**/*.ts(x)` modules and root config files (`package.json`, `tsconfig.json`, `tsconfig.strict.json`) with a hostile, failure-first posture.
- Ran static safety checks and dependency/audit commands where environment allowed.
- PostgreSQL-specific checks are **not applicable** in this repository because no SQL client, migrations, schema files, query builders, or DB connection code exist.

## Phase 1 — Systematic Decomposition Findings

### Critical (P0)

1. **Untrusted remote MCP servers auto-connect without trust gate (silent data exfiltration path)**
   - **File:Line:Column:** `src/mcp/client.ts:47:5`, `src/mcp/client.ts:52:11`, `src/mcp/client.ts:121:5`
   - **Category:** Security|Architecture
   - **Violation:** `ensureTrustedServer` only enforces fingerprint trust for `stdio` transports, but `ensureServersInitialized()` auto-connects all configured servers from project settings. `http`/`sse` endpoints are connected without any trust prompt or pinning.
   - **Concrete fix:** Change `ensureTrustedServer` to enforce trust records for **all transport types** (including URL + headers fingerprint for `http`/`sse`), and block initialization unless explicitly trusted by the local user. Add first-run interactive approval before persisting trust.
   - **Risk if not fixed:** Opening an untrusted repo with a crafted `.grok/settings.json` can trigger outbound connections to attacker-controlled MCP endpoints and leak prompts/tool outputs.

### High (P1)

2. **HTTP/SSE transport allows arbitrary URL schemes/targets (SSRF + internal pivot risk)**
   - **File:Line:Column:** `src/mcp/transports.ts:82:9`, `src/mcp/transports.ts:116:9`, `src/commands/mcp.ts:77:11`
   - **Category:** Security
   - **Violation:** URL inputs are accepted without strict validation/allowlist (scheme, host, loopback restrictions). Code directly instantiates axios clients and POSTs to derived RPC endpoints.
   - **Concrete fix:** Validate URL using `new URL(...)`; allow only `https:` by default, optionally `http://127.0.0.1`/`localhost` behind explicit opt-in flag. Reject private-network targets unless explicitly approved.
   - **Risk if not fixed:** Malicious config or user mistake can force requests to sensitive internal services (metadata endpoints, internal admin APIs).

3. **Confirmation queue concurrency model is unsafe; promise handle is overwritten**
   - **File:Line:Column:** `src/utils/confirmation-service.ts:27:11`, `src/utils/confirmation-service.ts:73:5`, `src/utils/confirmation-service.ts:107:5`
   - **Category:** Architecture|Async
   - **Violation:** `pendingConfirmation` stores only one Promise while `pendingQueue` can contain multiple requests. Subsequent requests overwrite the shared Promise handle, creating potential mismatched confirmations/hangs under concurrent tool actions.
   - **Concrete fix:** Remove singleton `pendingConfirmation`; instead create per-request deferred promises in queue entries (`{id, resolve, reject, promise}`) and await the specific request promise.
   - **Risk if not fixed:** Incorrect confirmation routing can authorize wrong operations or deadlock pending operations.

4. **Potential sensitive data leakage through structured logger context passthrough**
   - **File:Line:Column:** `src/utils/logger.ts:7:1`, `src/utils/logger.ts:13:5`, `src/index.tsx:74:7`
   - **Category:** Security|Observability
   - **Violation:** Logger serializes arbitrary context objects with no redaction policy; future callsites can inadvertently include secrets/tokens and emit them to stdout/stderr.
   - **Concrete fix:** Introduce centralized redaction (`apiKey`, `token`, `authorization`, `password`, etc.), depth-limited serialization, and safe error formatter before `JSON.stringify`.
   - **Risk if not fixed:** Secret leakage into CI logs, terminal recordings, or telemetry sinks.

### Medium (P2)

5. **Unsafe type assertions bypass compile-time guarantees at API boundary**
   - **File:Line:Column:** `src/grok/client.ts:70:21`, `src/grok/client.ts:71:40`, `src/grok/client.ts:89:44`
   - **Category:** Type
   - **Violation:** Uses direct casts from internal message/tool shapes to OpenAI SDK types (`as ...MessageParam[]`, `as ...Tool[]`, `as GrokToolCall[]`) without structural validation.
   - **Concrete fix:** Add explicit converter/validator functions with runtime guards; return typed errors on invalid message/tool payloads rather than force-casting.
   - **Risk if not fixed:** Runtime request failures or malformed tool-call handling that escapes static analysis.

6. **`Math.random()` used for request IDs in security-relevant confirmation flow**
   - **File:Line:Column:** `src/utils/confirmation-service.ts:72:37`
   - **Category:** Security
   - **Violation:** Non-cryptographic randomness for request IDs in an approval-routing path.
   - **Concrete fix:** Replace with `crypto.randomUUID()`.
   - **Risk if not fixed:** Predictable IDs increase collision/spoof risk in event-driven UIs and weaken auditability.

7. **Blocking synchronous filesystem I/O on hot path can stall CLI responsiveness**
   - **File:Line:Column:** `src/utils/settings-manager.ts:55:21`, `src/utils/settings-manager.ts:66:16`, `src/utils/settings-manager.ts:74:5`
   - **Category:** Performance|Resilience
   - **Violation:** `readFileSync`, `writeFileSync`, `fsyncSync`, and `renameSync` are used in interactive runtime paths.
   - **Concrete fix:** Migrate to async fs/promises equivalents with same atomic write strategy and bounded retry.
   - **Risk if not fixed:** Event-loop stalls under slow disks or networked home directories.

8. **Catch-and-continue patterns suppress operational visibility**
   - **File:Line:Column:** `src/mcp/client.ts:127:9`, `src/index.tsx:48:5`, `src/tools/search.ts:339:15`
   - **Category:** Resilience|Observability
   - **Violation:** Multiple catch blocks intentionally swallow errors with no structured context.
   - **Concrete fix:** Emit structured warning logs with error class, operation, and target identifier before continuing.
   - **Risk if not fixed:** Incident triage is delayed due to missing breadcrumbs.

### Low (P3)

9. **No branded types for identity-like strings (`task.id`, server names, tool names)**
   - **File:Line:Column:** `src/agent/grok-agent.ts:393:11`, `src/mcp/client.ts:6:3`, `src/mcp/client.ts:8:5`
   - **Category:** Type|Architecture
   - **Violation:** Plain `string` used for semantically distinct IDs with no branding.
   - **Concrete fix:** Introduce branded aliases (`type TaskId = string & {readonly __brand: 'TaskId'}` etc.) at boundaries.
   - **Risk if not fixed:** Cross-assignment bugs remain invisible to the type checker.

10. **Empty `disconnect()` implementations for network transports reduce lifecycle clarity**
   - **File:Line:Column:** `src/mcp/transports.ts:106:3`, `src/mcp/transports.ts:142:3`
   - **Category:** Architecture
   - **Violation:** Methods intentionally no-op; no cancellation/cleanup for in-flight resources.
   - **Concrete fix:** Track transport lifecycle state and implement abort/close hooks for pending requests or event streams.
   - **Risk if not fixed:** Harder graceful shutdown semantics and hidden leaks in future transport evolution.

---

## Phase 2 — Adversarial Re-check

### Files/configs re-examined explicitly
- `package.json`: dependency governance scripts exist (`audit:ci`) but advisory endpoint is inaccessible in this environment.
- `tsconfig.json` + `tsconfig.strict.json`: strict settings are enabled (`strict`, `noImplicitAny`, `exactOptionalPropertyTypes`).
- "Obvious" and high-confidence files rechecked: `src/index.tsx`, `src/utils/logger.ts`, `src/mcp/client.ts`, `src/mcp/transports.ts`, `src/utils/confirmation-service.ts`.
- Error/catch paths re-reviewed for swallowed exceptions and partial-failure handling.

### Immediate-incident ranking (if deployed today)
1. **P0: Untrusted remote MCP auto-connect** — **Blast radius: high** (all users opening untrusted repos with hostile MCP config).
2. **P1: Arbitrary MCP URL/SSRF exposure** — **Blast radius: high** (network pivot to internal services where runtime has access).
3. **P1: Confirmation queue race/mismatch** — **Blast radius: medium-high** (incorrectly approved operations, stuck sessions under concurrency).
4. **P1: Logger secret leakage risk** — **Blast radius: medium** (credential/token exposure to logs and downstream systems).

## SQL/PostgreSQL Status
- No PostgreSQL code path found; SQL surgery checks (N+1, transactions, migrations, indexes, lock hierarchy, timestamptz correctness) are not applicable to this repository.
