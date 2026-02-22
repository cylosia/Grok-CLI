import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeTerminalText } from "../src/utils/terminal-sanitize.js";

test("sanitizeTerminalText strips ANSI CSI and OSC sequences", () => {
  const payload = "safe\u001b[31mred\u001b[0m\u001b]52;c;SGVsbG8=\u0007text";
  assert.equal(sanitizeTerminalText(payload), "saferedtext");
});

test("sanitizeTerminalText strips control characters", () => {
  const payload = "line1\u0001\u0002\rline2";
  assert.equal(sanitizeTerminalText(payload), "line1line2");
});

test("sanitizeTerminalText strips terminal title-setting sequences", () => {
  const payload = "\u001b]0;Evil Title\u0007safe text";
  assert.equal(sanitizeTerminalText(payload), "safe text");
});

test("sanitizeTerminalText strips OSC hyperlink sequences", () => {
  const payload = "\u001b]8;;https://evil.com\u0007click me\u001b]8;;\u0007";
  assert.equal(sanitizeTerminalText(payload), "click me");
});

test("sanitizeTerminalText strips OSC with ST terminator", () => {
  const payload = "\u001b]52;c;base64data\u001b\\normal text";
  assert.equal(sanitizeTerminalText(payload), "normal text");
});

test("sanitizeTerminalText handles long CSI sequences", () => {
  const longSequence = "\u001b[" + "0;".repeat(100) + "m";
  const payload = `before${longSequence}after`;
  assert.equal(sanitizeTerminalText(payload), "beforeafter");
});

test("sanitizeTerminalText strips null bytes", () => {
  const payload = "hello\u0000world";
  assert.equal(sanitizeTerminalText(payload), "helloworld");
});

test("sanitizeTerminalText preserves normal text including newlines and tabs", () => {
  const payload = "line1\nline2\ttabbed";
  assert.equal(sanitizeTerminalText(payload), "line1\nline2\ttabbed");
});

test("sanitizeTerminalText handles empty string", () => {
  assert.equal(sanitizeTerminalText(""), "");
});

test("sanitizeTerminalText strips partial escape sequences (bare ESC)", () => {
  const payload = "text\u001bmore text";
  const result = sanitizeTerminalText(payload);
  assert.ok(!result.includes("\u001b"));
});
