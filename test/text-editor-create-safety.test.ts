import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { TextEditorTool } from '../src/tools/text-editor.js';
import { ConfirmationService } from '../src/utils/confirmation-service.js';

test('text editor create does not overwrite existing file', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-create-safe-'));
  const previousCwd = process.cwd();
  const previousFlags = ConfirmationService.getInstance().getSessionFlags();
  ConfirmationService.getInstance().setSessionFlag('allOperations', true);

  try {
    process.chdir(tmpRoot);
    const tool = new TextEditorTool();

    const first = await tool.create('example.txt', 'first');
    assert.equal(first.success, true);

    const second = await tool.create('example.txt', 'second');
    assert.equal(second.success, false);
    assert.match(second.error ?? '', /File already exists/);

    const content = await fs.readFile(path.join(tmpRoot, 'example.txt'), 'utf8');
    assert.equal(content, 'first');
  } finally {
    process.chdir(previousCwd);
    ConfirmationService.getInstance().setSessionFlag('fileOperations', previousFlags.fileOperations);
    ConfirmationService.getInstance().setSessionFlag('bashCommands', previousFlags.bashCommands);
    ConfirmationService.getInstance().setSessionFlag('allOperations', previousFlags.allOperations);
    await fs.remove(tmpRoot);
  }
});
