import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SearchTool } from "../src/tools/search.js";
import { logger } from "../src/utils/logger.js";

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

test("search tool treats dash-prefixed query as literal pattern", async () => {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grok-search-"));
  const workspace = path.join(tempRoot, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "notes.txt"), "token --files appears in this file\n", "utf8");

  process.chdir(workspace);
  try {
    const tool = new SearchTool();
    const result = await tool.search("--files", { searchType: "text", maxResults: 10, regex: false });
    assert.equal(result.success, true);
    assert.match(result.output || "", /notes\.txt/);
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("search ripgrep parser logs at most one warning for invalid JSON output", () => {
  const tool = new SearchTool() as unknown as {
    parseRipgrepOutput: (output: string, query: string) => unknown;
  };

  const originalWarn = logger.warn;
  const calls: unknown[] = [];
  logger.warn = (message: string, context?: Record<string, unknown>) => {
    calls.push({ message, context });
  };

  try {
    tool.parseRipgrepOutput("not json\nalso not json\nstill bad", "needle");
    assert.equal(calls.length, 1);
    const [firstCall] = calls as Array<{ message: string; context?: Record<string, unknown> }>;
    assert.equal(firstCall.message, "search-invalid-rg-json-output");
    assert.equal(firstCall.context?.component, "search-tool");
    assert.equal(firstCall.context?.invalidLineCount, 3);
    assert.equal(firstCall.context?.query, "needle");
    assert.equal(typeof firstCall.context?.firstParseError, "string");
  } finally {
    logger.warn = originalWarn;
  }
});


test("search tool setCurrentDirectory rejects missing directory with controlled error", async () => {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grok-search-"));
  const workspace = path.join(tempRoot, "workspace");
  await fs.mkdir(workspace, { recursive: true });

  process.chdir(workspace);
  try {
    const tool = new SearchTool();
    assert.throws(() => tool.setCurrentDirectory("./does-not-exist"), /does not exist/i);
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
