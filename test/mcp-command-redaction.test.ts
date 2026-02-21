import test from "node:test";
import assert from "node:assert/strict";
import { redactCliArg } from "../src/commands/mcp.js";

test("redactCliArg redacts key=value secret arguments", () => {
  assert.equal(redactCliArg("api_key=super-secret-token-value"), "api_key=[REDACTED]");
  assert.equal(redactCliArg("authorization=Bearer token-value-1234567890123"), "authorization=[REDACTED]");
});

test("redactCliArg redacts bare token-looking values", () => {
  assert.equal(redactCliArg("abcdefghijklmnopqrstuvwxyz123456"), "[REDACTED]");
});
