import test from "node:test";
import assert from "node:assert/strict";
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
