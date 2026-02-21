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
