import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SearchTool } from "../src/tools/search.js";

test("search tool rejects directories outside workspace root", async () => {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grok-search-"));
  const workspace = path.join(tempRoot, "workspace");
  const outside = path.join(tempRoot, "outside");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(outside, { recursive: true });

  process.chdir(workspace);
  try {
    const tool = new SearchTool();
    assert.throws(() => tool.setCurrentDirectory("../outside"), /outside workspace root/i);
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
