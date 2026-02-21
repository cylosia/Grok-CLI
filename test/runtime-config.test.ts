import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../src/utils/runtime-config.js";

test("loadRuntimeConfig rejects unsafe GROK_BASE_URL values", () => {
  const previousKey = process.env.GROK_API_KEY;
  const previousBase = process.env.GROK_BASE_URL;
  process.env.GROK_API_KEY = "test-key";
  process.env.GROK_BASE_URL = "http://127.0.0.1:8080";

  try {
    assert.throws(() => loadRuntimeConfig(), /Unsupported GROK base URL scheme|Private-network GROK base URL/);
  } finally {
    if (previousKey === undefined) {
      delete process.env.GROK_API_KEY;
    } else {
      process.env.GROK_API_KEY = previousKey;
    }
    if (previousBase === undefined) {
      delete process.env.GROK_BASE_URL;
    } else {
      process.env.GROK_BASE_URL = previousBase;
    }
  }
});

test("loadRuntimeConfig accepts safe HTTPS GROK_BASE_URL values", () => {
  const previousKey = process.env.GROK_API_KEY;
  const previousBase = process.env.GROK_BASE_URL;
  process.env.GROK_API_KEY = "test-key";
  process.env.GROK_BASE_URL = " https://api.x.ai/v1 ";

  try {
    const config = loadRuntimeConfig();
    assert.equal(config.grokBaseUrl, "https://api.x.ai/v1");
  } finally {
    if (previousKey === undefined) {
      delete process.env.GROK_API_KEY;
    } else {
      process.env.GROK_API_KEY = previousKey;
    }
    if (previousBase === undefined) {
      delete process.env.GROK_BASE_URL;
    } else {
      process.env.GROK_BASE_URL = previousBase;
    }
  }
});
