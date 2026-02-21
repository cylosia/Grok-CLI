import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeAndValidateBaseUrl } from "../src/utils/settings-manager.js";

test("base URL validation rejects insecure http by default", () => {
  assert.throws(() => sanitizeAndValidateBaseUrl("http://api.example.com/v1"), /Unsupported GROK base URL scheme/i);
});

test("base URL validation rejects private hosts by default", () => {
  assert.throws(() => sanitizeAndValidateBaseUrl("https://localhost:8443/v1"), /Private-network GROK base URL/i);
});

test("base URL validation strips and normalizes valid https URL", () => {
  const out = sanitizeAndValidateBaseUrl("  https://api.x.ai/v1  ");
  assert.equal(out, "https://api.x.ai/v1");
});


test("base URL validation rejects custom hosts by default", () => {
  const previous = process.env.GROK_ALLOW_CUSTOM_BASE_URL_HOST;
  delete process.env.GROK_ALLOW_CUSTOM_BASE_URL_HOST;
  try {
    assert.throws(() => sanitizeAndValidateBaseUrl("https://example.com/v1"), /Custom GROK base URL hosts require/i);
  } finally {
    if (previous === undefined) {
      delete process.env.GROK_ALLOW_CUSTOM_BASE_URL_HOST;
    } else {
      process.env.GROK_ALLOW_CUSTOM_BASE_URL_HOST = previous;
    }
  }
});
