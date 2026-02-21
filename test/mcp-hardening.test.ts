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

test('stdio transport rejects protected env override keys explicitly', async () => {
  const transport = createTransport({
    type: 'stdio',
    command: 'node',
    args: ['-e', ''],
    env: {
      PATH: '/tmp',
    },
  });

  await assert.rejects(
    () => transport.connect(),
    /Unsupported MCP stdio env override keys: PATH/
  );
});

test('stdio transport rejects unknown MCP-prefixed env override keys', async () => {
  const transport = createTransport({
    type: 'stdio',
    command: 'node',
    args: ['-e', ''],
    env: {
      MCP_CUSTOM_UNSAFE: '1',
    },
  });

  await assert.rejects(
    () => transport.connect(),
    /Unsupported MCP stdio env override keys: MCP_CUSTOM_UNSAFE/
  );
});

test('mcp manager prunes expired timeout cooldown entries and caps map size', () => {
  const manager = new MCPManager() as unknown as {
    callSafety: {
      timedOutCallCooldownUntil: Map<string, number>;
      assertCallAllowed: (callKey: string, name: string) => void;
    };
  };

  const now = Date.now();
  for (let i = 0; i < 2105; i += 1) {
    manager.callSafety.timedOutCallCooldownUntil.set(`k-${i}`, now + 60_000);
  }
  manager.callSafety.timedOutCallCooldownUntil.set('expired', now - 1);

  manager.callSafety.assertCallAllowed('new-call', 'test-call');

  assert.equal(manager.callSafety.timedOutCallCooldownUntil.has('expired'), false);
  assert.ok(manager.callSafety.timedOutCallCooldownUntil.size <= 2000);
});
