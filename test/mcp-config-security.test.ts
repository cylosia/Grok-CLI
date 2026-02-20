import test from 'node:test';
import assert from 'node:assert/strict';
import { addMCPServer, removeMCPServer, setTrustedMCPServerFingerprint } from '../src/mcp/config.js';

test('addMCPServer rejects prototype-pollution key names', () => {
  assert.throws(() => {
    addMCPServer({
      name: '__proto__',
      transport: {
        type: 'stdio',
        command: 'echo',
      },
    });
  }, /Invalid MCP server name/);
});

test('trusted fingerprint rejects prototype-pollution key names', () => {
  assert.throws(() => {
    setTrustedMCPServerFingerprint('constructor', 'abc');
  }, /Invalid MCP server name/);
});

test('removeMCPServer ignores invalid key names safely', () => {
  assert.doesNotThrow(() => {
    removeMCPServer('prototype');
  });
});
