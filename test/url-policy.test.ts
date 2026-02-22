import test from "node:test";
import assert from "node:assert/strict";
import { validateMcpUrl } from "../src/mcp/url-policy.js";

test("validateMcpUrl blocks https private host without opt-in", async () => {
  await assert.rejects(() => validateMcpUrl("https://127.0.0.1:7777"));
});

test("validateMcpUrl allows localhost http when local http explicitly allowed", async () => {
  const result = await validateMcpUrl("http://localhost:3000", { allowLocalHttp: true });
  assert.match(result, /^http:\/\/localhost:3000\/?$/);
});

test("validateMcpUrl keeps private https blocked when only local http is allowed", async () => {
  await assert.rejects(() => validateMcpUrl("https://127.0.0.1:7777", { allowLocalHttp: true }));
});

test("validateMcpUrl allows private https with explicit private https opt-in", async () => {
  const result = await validateMcpUrl("https://127.0.0.1:7777", { allowPrivateHttps: true });
  assert.match(result, /^https:\/\/127\.0\.0\.1:7777\/?$/);
});

test("validateMcpUrl blocks ipv4-mapped-ipv6 private addresses", async () => {
  await assert.rejects(() => validateMcpUrl("https://[::ffff:127.0.0.1]:7777"));
});

test("validateMcpUrl rejects credential-bearing URLs", async () => {
  await assert.rejects(() => validateMcpUrl("https://user:pass@example.com/mcp"));
});

test("validateMcpUrl blocks 0.0.0.0", async () => {
  await assert.rejects(() => validateMcpUrl("https://0.0.0.0:8080"));
});

test("validateMcpUrl blocks 0.0.0.0 even with allowLocalHttp for https", async () => {
  await assert.rejects(() => validateMcpUrl("https://0.0.0.0:8080", { allowLocalHttp: true }));
});

test("validateMcpUrl blocks ipv6 loopback ::1", async () => {
  await assert.rejects(() => validateMcpUrl("https://[::1]:7777"));
});

test("validateMcpUrl blocks fe80:: link-local addresses", async () => {
  await assert.rejects(() => validateMcpUrl("https://[fe80::1]:7777"));
});

test("validateMcpUrl rejects unsupported schemes", async () => {
  await assert.rejects(() => validateMcpUrl("ftp://example.com/mcp"), /Unsupported MCP URL scheme/);
});

test("validateMcpUrl rejects invalid URLs", async () => {
  await assert.rejects(() => validateMcpUrl("not-a-url"), /Invalid MCP URL/);
});

test("validateMcpUrl rejects empty host", async () => {
  await assert.rejects(() => validateMcpUrl("https:///path"));
});
