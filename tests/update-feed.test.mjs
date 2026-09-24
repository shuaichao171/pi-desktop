import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGitHubReleaseFeedUrl, parseUpdateFeedUrl } from '../packages/desktop/src/main/updateFeed.ts';

test('update feed accepts only credential-free HTTPS directory URLs', () => {
  assert.equal(parseUpdateFeedUrl('https://updates.example.com/pi-desktop/'), 'https://updates.example.com/pi-desktop/');
  for (const value of [undefined, '', 'http://updates.example.com/', 'file:///tmp/releases/', 'https://user:secret@updates.example.com/', 'https://updates.example.com/?token=secret', 'https://updates.example.com/#fragment', 'https://updates.example.com/release', 'https://127.0.0.1/', 'https://localhost/', 'https://[::1]/', 'not a URL']) {
    assert.equal(parseUpdateFeedUrl(value), null);
  }
});

test('GitHub release feed detection recognizes latest and pinned release asset directories only', () => {
  for (const url of ['https://github.com/shuaichao171/pi-desktop/releases/latest/download/', 'https://github.com/shuaichao171/pi-desktop/releases/download/v0.1.0/']) {
    assert.equal(parseUpdateFeedUrl(url), url);
    assert.equal(isGitHubReleaseFeedUrl(url), true);
  }
  for (const url of ['https://github.com.example.org/a/b/releases/latest/download/', 'https://github.com/a/b/', 'https://github.com/a/b/releases/latest/', 'https://updates.example.org/releases/latest/download/', 'http://github.com/a/b/releases/latest/download/', 'https://github.com:4443/a/b/releases/latest/download/', 'https://user:secret@github.com/a/b/releases/latest/download/', 'not a URL']) {
    assert.equal(isGitHubReleaseFeedUrl(url), false);
  }
});
