import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const opened = [];
globalThis.__externalLinksTest = {
  shell: { openExternal: (url) => { opened.push(url); return Promise.resolve(); } },
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: `data:text/javascript,${encodeURIComponent('export const { shell } = globalThis.__externalLinksTest;')}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { openExternalHttpUrl, guardExternalNavigation } = await import('../packages/desktop/src/main/externalLinks.ts');

/** The three members the guard uses; a real WebContents satisfies the same shape. */
function fakeSurface(url = 'file:///app/index.html') {
  const handlers = {};
  let windowOpen = null;
  return {
    openWindow: (detail) => windowOpen(detail),
    handlers,
    getURL: () => url,
    setWindowOpenHandler: (handler) => { windowOpen = handler; },
    on: (event, handler) => { handlers[event] = handler; },
  };
}

/** Runs one guarded navigation and reports whether the surface stayed put. */
function navigate(surface, target) {
  let prevented = false;
  surface.handlers['will-navigate']({ preventDefault: () => { prevented = true; } }, target);
  return prevented;
}

test('only http(s) destinations leave the app', () => {
  opened.length = 0;
  for (const url of [
    'http://127.0.0.1:5173', 'https://example.com/a?b=1#c',
    'javascript:alert(1)', 'file:///C:/Users/me/secret.txt', 'mailto:someone@example.com', 'not a url', '',
  ]) openExternalHttpUrl(url);
  assert.deepEqual(opened, ['http://127.0.0.1:5173/', 'https://example.com/a?b=1#c']);
});

test('a new-window request hands the address to the browser instead of opening a window', () => {
  opened.length = 0;
  const surface = fakeSurface();
  guardExternalNavigation(surface);
  assert.deepEqual(surface.openWindow({ url: 'http://127.0.0.1:5173' }), { action: 'deny' });
  assert.deepEqual(surface.openWindow({ url: 'about:blank' }), { action: 'deny' });
  assert.deepEqual(opened, ['http://127.0.0.1:5173/']);
});

test('a link to a dead address cannot replace the surface the user is reading', () => {
  opened.length = 0;
  const surface = fakeSurface();
  guardExternalNavigation(surface);
  assert.equal(navigate(surface, 'http://127.0.0.1:5173'), true);
  assert.equal(navigate(surface, 'file:///C:/Users/me/secret.txt'), true);
  assert.deepEqual(opened, ['http://127.0.0.1:5173/']);
});

test('reloading the document already loaded is not treated as leaving the app', () => {
  opened.length = 0;
  const surface = fakeSurface('file:///app/index.html?mode=pai');
  guardExternalNavigation(surface);
  assert.equal(navigate(surface, 'file:///app/index.html?mode=pai'), false);
  assert.deepEqual(opened, []);
});

test('every renderer surface installs the navigation guard', () => {
  const surfaces = {
    'main window': '../packages/desktop/src/main/index.ts',
    'pai window': '../packages/desktop/src/main/ipc.ts',
    'split pane': '../packages/desktop/src/main/splitPanes.ts',
  };
  for (const [name, path] of Object.entries(surfaces)) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /guardExternalNavigation\(/, `${name} must route transcript links through guardExternalNavigation`);
  }
});
