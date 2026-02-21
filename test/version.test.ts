import test from 'node:test';
import assert from 'node:assert/strict';
import { getCliVersion } from '../src/utils/version.js';

test('getCliVersion returns package version-like value', () => {
  const version = getCliVersion();
  assert.match(version, /^\d+\.\d+\.\d+/);
});
