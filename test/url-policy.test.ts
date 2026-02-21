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
