import test from "node:test";
import assert from "node:assert/strict";
import { safeJsonStringify } from "../src/utils/logger.js";

test("safeJsonStringify serializes bigint and circular values", () => {
  const payload: { amount: bigint; self?: unknown } = { amount: 42n };
  payload.self = payload;

  const serialized = safeJsonStringify(payload);
  assert.match(serialized, /"amount":"42"/);
  assert.match(serialized, /"self":"\[CIRCULAR\]"/);
});
