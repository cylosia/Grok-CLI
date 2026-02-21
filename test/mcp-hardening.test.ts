import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../src/mcp/transports.js';
import { MCPManager } from '../src/mcp/client.js';

test('stdio transport rejects non-allowlisted env overrides', async () => {
  const transport = createTransport({
    type: 'stdio',
    command: 'node',
    args: ['-e', ''],
    env: {
      LD_PRELOAD: '/tmp/x.so',
    },
  });

  await assert.rejects(
    () => transport.connect(),
    /Unsupported MCP stdio env override keys: LD_PRELOAD/
  );
});

test('mcp manager prunes expired timeout cooldown entries and caps map size', () => {
  const manager = new MCPManager() as unknown as {
    timedOutCallCooldownUntil: Map<string, number>;
    pruneTimedOutCooldownKeys: () => void;
  };

  const now = Date.now();
  for (let i = 0; i < 2105; i += 1) {
    manager.timedOutCallCooldownUntil.set(`k-${i}`, now + 60_000);
  }
  manager.timedOutCallCooldownUntil.set('expired', now - 1);

  manager.pruneTimedOutCooldownKeys();

  assert.equal(manager.timedOutCallCooldownUntil.has('expired'), false);
  assert.ok(manager.timedOutCallCooldownUntil.size <= 2000);
});
