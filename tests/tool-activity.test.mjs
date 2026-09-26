import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activityPresentation } from '../packages/ui/src/activityCopy.ts';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

test('activity summaries translate known actions without losing custom tool identity or command content', () => {
  assert.deepEqual(activityPresentation({ tool: 'read', title: 'read(src/main.ts)' }, 'zh-CN'), { label: '读取', summary: 'src/main.ts' });
  assert.deepEqual(activityPresentation({ tool: 'grep', title: 'grep(useQueue)' }, 'en-US'), { label: 'Search', summary: 'useQueue' });
  assert.deepEqual(activityPresentation({ tool: 'bash', title: 'bash(node…)', command: 'node --test\n tests/a.test.mjs' }, 'en-US'), { label: 'Run', summary: 'node --test tests/a.test.mjs' });
  assert.deepEqual(activityPresentation({ tool: 'mcp__docs__search', title: 'mcp__docs__search(API retry)' }, 'zh-CN'), { label: 'mcp__docs__search', summary: 'API retry' });
  assert.deepEqual(activityPresentation({ tool: 'read', title: 'read', files: ['notes.md'] }, 'zh-CN'), { label: '读取', summary: 'notes.md' });
});

test('compact activity components preserve accessible details and support a parent process disclosure', async (context) => {
  const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
  const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
  const server = await createServer({ root: fileURLToPath(new URL('../packages/ui', import.meta.url)), configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { ToolActivityItem, ToolActivityPanel } = await server.ssrLoadModule('/src/components/ToolActivity.tsx');
    const { ThinkingActivity } = await server.ssrLoadModule('/src/components/ThinkingActivity.tsx');
    const { createDisclosureStore } = await server.ssrLoadModule('/src/conversationDisclosure.tsx');
    const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
    const read = { id: 'read-1', order: 1, tool: 'read', title: 'read(src/main.ts)', status: 'done', detail: 'retained file contents', files: ['src/main.ts'] };

    await context.test('conversation choices survive row subscriptions while phases, scopes and unrelated rows stay isolated', () => {
      const store = createDisclosureStore();
      let turnNotices = 0, thinkingNotices = 0;
      const stopTurn = store.subscribe('turn:a:running', () => turnNotices++);
      const stopThinking = store.subscribe('thinking:a', () => thinkingNotices++);
      store.set('turn:a:running', true);
      assert.equal(turnNotices, 1);
      assert.equal(thinkingNotices, 0);
      assert.equal(store.get('turn:a:settled'), null);
      store.set('thinking:a', false);
      stopTurn(); stopThinking();
      assert.equal(store.get('turn:a:running'), true);
      assert.equal(store.get('thinking:a'), false);
      assert.equal(createDisclosureStore().get('thinking:a'), null);
      const stopRemount = store.subscribe('thinking:a', () => thinkingNotices++);
      store.set('thinking:a', false);
      assert.equal(thinkingNotices, 1);
      store.set('thinking:a', true);
      assert.equal(thinkingNotices, 2);
      stopRemount();
      assert.equal(store.consumeRequest('turn:a', 3), true);
      store.set('turn:a:settled', false);
      assert.equal(store.consumeRequest('turn:a', 3), false);
      assert.equal(store.consumeRequest('turn:a', 2), false);
      assert.equal(store.get('turn:a:settled'), false);
      assert.equal(store.consumeRequest('turn:a', 4), true);
    });

    await context.test('inline mode has one independently expandable tool row and no nested group toggle', () => {
      const html = render(ToolActivityPanel, { sourceActivities: [read], indices: [0, 20], inline: true });
      assert.match(html, /pd-activity-list is-inline/);
      assert.doesNotMatch(html, /pd-activity-summary|pd-activity-group/);
      assert.equal((html.match(/class="pd-activity-head"/g) ?? []).length, 1);
      assert.match(html, /pd-activity-head[^>]*aria-expanded="false"/);
      assert.match(html, />读取<|>src\/main\.ts</);
      assert.match(html, /retained file contents/);
      assert.match(html, /aria-hidden="true" inert=""/);
      assert.match(render(ToolActivityPanel, { sourceActivities: [read], indices: [0] }), /pd-activity-summary/);
    });

    await context.test('failed command details retain full commands, errors, copy and wrapping controls', () => {
      const command = 'node --test\n tests/a.test.mjs --test-name-pattern=preserve-last-argument';
      const html = render(ToolActivityItem, { activity: { ...read, tool: 'bash', title: 'bash(node --test…)', status: 'error', command, exitCode: 1, detail: 'specific failure output', files: [] } });
      assert.match(html, /pd-activity-head[^>]*aria-expanded="true"/);
      assert.match(html, /pd-activity-command-text is-wrapped/);
      assert.ok(html.includes(command));
      assert.match(html, /specific failure output/);
      assert.match(html, /aria-label="复制完整命令"/);
      assert.match(html, /aria-label="切换命令自动换行"/);
      assert.match(html, /pd-activity-exit is-error/);
      assert.match(html, /pd-activity-status is-error/);
      const diff = render(ToolActivityItem, { activity: { ...read, tool: 'edit', diff: '-1 old line\n+1 new line' } });
      assert.match(diff, /pd-activity-diff/);
      assert.match(diff, /old line/);
      assert.match(diff, /new line/);
      assert.match(diff, /pd-activity-output-actions/);
    });

    await context.test('thinking defaults can follow the enclosing run while retaining the real model content', () => {
      const message = { id: 'thinking-1', order: 2, role: 'assistant', text: '', thinking: 'Actual model note with **a concrete check**.', thinkingStatus: 'done', status: 'done' };
      const opened = render(ThinkingActivity, { message, defaultExpanded: true });
      assert.match(opened, /pd-thinking-summary[^>]*aria-expanded="true"/);
      assert.match(opened, /Actual model note with <strong>a concrete check<\/strong>/);
      const closed = render(ThinkingActivity, { message: { ...message, thinkingStatus: 'streaming', status: 'streaming' }, defaultExpanded: false });
      assert.match(closed, /pd-thinking-summary[^>]*aria-expanded="false"/);
      assert.match(closed, /Actual model note/);
      assert.match(closed, /aria-hidden="true" inert=""/);
      assert.match(render(ThinkingActivity, { message: { ...message, thinkingStatus: 'streaming', status: 'streaming' } }), /pd-thinking-summary[^>]*aria-expanded="true"/);
      assert.doesNotMatch(render(ThinkingActivity, { message: { ...message, thinking: '' }, defaultExpanded: true }), /aria-expanded="true"/);
    });
  } finally { await server.close(); }
});
