import test from "node:test";
import assert from "node:assert/strict";
import { safeJsonStringify, logger } from "../src/utils/logger.js";

test("logger serialization remains stable for bigint", () => {
  assert.equal(safeJsonStringify({ id: 1n }), '{"id":"1"}');
});

test("logger redacts bearer token value strings", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (line?: unknown) => warnings.push(String(line));
  try {
    logger.warn("auth-error", { component: "test", error: "Bearer abcdefghijklmnopqrstuvwxyz123456" });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[REDACTED\]/);
  assert.equal(warnings[0].includes("abcdefghijklmnopqrstuvwxyz123456"), false);
});
