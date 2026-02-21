import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BashTool } from "../src/tools/bash.js";
import { ConfirmationService } from "../src/utils/confirmation-service.js";

test("bash tool blocks path-bearing git -C outside workspace", async () => {
  const confirmations = ConfirmationService.getInstance();
  confirmations.setSessionFlag("bashCommands", true);

  const tool = new BashTool();
  const result = await tool.executeArgs("git", ["-C/tmp", "status"]);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /outside workspace/i);

  confirmations.resetSession();
});

test("bash tool blocks windows-style traversal segments", async () => {
  const confirmations = ConfirmationService.getInstance();
  confirmations.setSessionFlag("bashCommands", true);

  const tool = new BashTool();
  const result = await tool.executeArgs("cat", ["..\\secret.txt"]);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /outside workspace/i);

  confirmations.resetSession();
});

test("bash tool blocks symlink escape outside workspace", async () => {
  const confirmations = ConfirmationService.getInstance();
  confirmations.setSessionFlag("bashCommands", true);

  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grok-bash-"));
  const workspace = path.join(tempRoot, "workspace");
  const outside = path.join(tempRoot, "outside");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf-8");
  await fs.symlink(outside, path.join(workspace, "link-out"));

  process.chdir(workspace);
  try {
    const tool = new BashTool();
    const result = await tool.executeArgs("cat", ["link-out/secret.txt"]);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /outside workspace/i);
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
    confirmations.resetSession();
  }
});

test("bash tool does not treat git revision args as path args", async () => {
  const confirmations = ConfirmationService.getInstance();
  confirmations.setSessionFlag("bashCommands", true);

  const tool = new BashTool();
  const result = await tool.executeArgs("git", ["rev-parse", "HEAD"]);
  assert.equal(Boolean(result.error?.includes("outside workspace")), false);

  confirmations.resetSession();
});

test("bash tool blocks git --git-dir outside workspace", async () => {
  const confirmations = ConfirmationService.getInstance();
  confirmations.setSessionFlag("bashCommands", true);

  const tool = new BashTool();
  const result = await tool.executeArgs("git", ["--git-dir=/etc", "status"]);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /outside workspace/i);

  confirmations.resetSession();
});

test("bash tool blocks non-allowlisted git subcommands", async () => {
  const confirmations = ConfirmationService.getInstance();
  confirmations.setSessionFlag("bashCommands", true);

  const tool = new BashTool();
  const result = await tool.executeArgs("git", ["config", "user.name"]);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not allowed by policy/i);

  confirmations.resetSession();
});


test("bash tool blocks git network subcommands by policy", async () => {
  const confirmations = ConfirmationService.getInstance();
  confirmations.setSessionFlag("bashCommands", true);

  const tool = new BashTool();
  const result = await tool.executeArgs("git", ["push"]);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not allowed by policy/i);

  confirmations.resetSession();
});
