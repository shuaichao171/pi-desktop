import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUpdateFeedUrl } from '../packages/desktop/src/main/updateFeed.ts';

test('update feed accepts only credential-free HTTPS directory URLs', () => {
  assert.equal(parseUpdateFeedUrl('https://updates.example.com/pi-desktop/'), 'https://updates.example.com/pi-desktop/');
  for (const value of [undefined, '', 'http://updates.example.com/', 'file:///tmp/releases/', 'https://user:secret@updates.example.com/', 'https://updates.example.com/?token=secret', 'https://updates.example.com/#fragment', 'https://updates.example.com/release', 'https://127.0.0.1/', 'https://localhost/', 'https://[::1]/', 'not a URL']) {
    assert.equal(parseUpdateFeedUrl(value), null);
  }
});
