import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unwrapIpcError } from '../packages/desktop/src/preload/ipcErrors.ts';

test('preload removes only the matching Electron IPC error wrapper', () => {
  const original = new Error("Error invoking remote method 'agent:set-model': Error: 模型不可用");
  const cleaned = unwrapIpcError(original, 'agent:set-model');
  assert.equal(cleaned.message, '模型不可用');
  assert.equal(cleaned.cause, original);
  assert.equal(unwrapIpcError(original, 'agent:prompt'), original);
  assert.equal(unwrapIpcError(new Error('网络断开'), 'agent:set-model').message, '网络断开');
});
