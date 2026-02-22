import test from "node:test";
import assert from "node:assert/strict";
import { tokenizeBashLikeCommand, hasUnterminatedQuoteOrEscape } from "../src/tools/bash-tokenizer.js";

test("tokenizeBashLikeCommand splits basic command", () => {
  assert.deepEqual(tokenizeBashLikeCommand("ls -la /tmp"), ["ls", "-la", "/tmp"]);
});

test("tokenizeBashLikeCommand handles double quotes", () => {
  assert.deepEqual(tokenizeBashLikeCommand('echo "hello world"'), ["echo", "hello world"]);
});

test("tokenizeBashLikeCommand handles single quotes", () => {
  assert.deepEqual(tokenizeBashLikeCommand("echo 'hello world'"), ["echo", "hello world"]);
});

test("tokenizeBashLikeCommand handles escaped spaces", () => {
  assert.deepEqual(tokenizeBashLikeCommand("cat hello\\ world.txt"), ["cat", "hello world.txt"]);
});

test("tokenizeBashLikeCommand returns empty array for unterminated double quote", () => {
  assert.deepEqual(tokenizeBashLikeCommand('echo "hello'), []);
});

test("tokenizeBashLikeCommand returns empty array for unterminated single quote", () => {
  assert.deepEqual(tokenizeBashLikeCommand("echo 'hello"), []);
});

test("tokenizeBashLikeCommand returns empty array for trailing backslash", () => {
  assert.deepEqual(tokenizeBashLikeCommand("echo hello\\"), []);
});

test("tokenizeBashLikeCommand handles empty string", () => {
  assert.deepEqual(tokenizeBashLikeCommand(""), []);
});

test("tokenizeBashLikeCommand handles multiple spaces between tokens", () => {
  assert.deepEqual(tokenizeBashLikeCommand("ls    -la    /tmp"), ["ls", "-la", "/tmp"]);
});

test("tokenizeBashLikeCommand handles mixed quotes", () => {
  assert.deepEqual(tokenizeBashLikeCommand(`echo "it's" 'a "test"'`), ["echo", "it's", 'a "test"']);
});

test("tokenizeBashLikeCommand preserves null bytes within tokens", () => {
  const result = tokenizeBashLikeCommand("echo hello\x00world");
  assert.equal(result.length, 2);
  assert.equal(result[0], "echo");
  assert.ok(result[1]?.includes("\x00"));
});

test("hasUnterminatedQuoteOrEscape detects unterminated double quote", () => {
  assert.equal(hasUnterminatedQuoteOrEscape('echo "hello'), true);
});

test("hasUnterminatedQuoteOrEscape detects unterminated single quote", () => {
  assert.equal(hasUnterminatedQuoteOrEscape("echo 'hello"), true);
});

test("hasUnterminatedQuoteOrEscape detects trailing backslash", () => {
  assert.equal(hasUnterminatedQuoteOrEscape("echo hello\\"), true);
});

test("hasUnterminatedQuoteOrEscape returns false for complete command", () => {
  assert.equal(hasUnterminatedQuoteOrEscape("echo 'hello' \"world\""), false);
});

test("hasUnterminatedQuoteOrEscape returns false for empty string", () => {
  assert.equal(hasUnterminatedQuoteOrEscape(""), false);
});
