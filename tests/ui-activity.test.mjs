import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

test('activity transcript presents genuine reasoning, accessible disclosures and live output', async (t) => {
  const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
  const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
  const server = await createServer({
    root: fileURLToPath(new URL('../packages/ui', import.meta.url)),
    configFile: false, server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  });
  try {
    const { MessageItem } = await server.ssrLoadModule('/src/components/MessageItem.tsx');
    const { ToolActivityPanel, ToolActivityItem } = await server.ssrLoadModule('/src/components/ToolActivity.tsx');
    const { translate } = await server.ssrLoadModule('/src/i18n.ts');
    const message = { id: 'a', order: 1, role: 'assistant', text: '', status: 'streaming' };
    const activity = { id: 'tool', order: 2, tool: 'bash', title: 'npm test', status: 'running', detail: 'First result' };
    const renderMessage = (change) => renderToStaticMarkup(createElement(MessageItem, { message: { ...message, ...change } }));

    await t.test('a plain model response does not invent a thought process', () => {
      const html = renderMessage({});
      assert.ok(html.includes(translate('message.preparing')));
      assert.doesNotMatch(html, /pd-thinking-activity/);
      assert.equal(renderMessage({ status: 'done' }), '');
    });

    await t.test('reasoning-only history remains inspectable and collapsed content is inert', () => {
      const html = renderMessage({ status: 'done', thinking: 'A **retained** explanation', thinkingStatus: 'done', thinkingTruncated: true });
      assert.ok(html.includes(translate('message.thinking.done')));
      assert.match(html, /A <strong>retained<\/strong> explanation/);
      assert.match(html, /aria-expanded="false"/);
      assert.match(html, /aria-hidden="true" inert=""/);
      assert.ok(html.includes(translate('message.thinking.truncated')));
      assert.doesNotMatch(html, /pd-activity-label is-active/);
    });

    await t.test('only streaming reasoning has active feedback; failed and interrupted states finish it', () => {
      const html = renderMessage({ thinking: 'Inspecting the parser', thinkingStatus: 'streaming' });
      assert.match(html, /aria-expanded="true"/);
      assert.match(html, /pd-activity-label is-active/);
      assert.ok(!html.includes(translate('message.preparing')));
      for (const status of ['error', 'interrupted']) {
        const ended = renderMessage({ status: 'error', thinking: 'Partial explanation', thinkingStatus: status });
        assert.ok(ended.includes(translate('message.thinking.' + status)));
        assert.doesNotMatch(ended, /pd-activity-label is-active/);
      }
    });

    await t.test('running groups expose tool rows, finished groups retain hidden readable output', () => {
      const running = renderToStaticMarkup(createElement(ToolActivityPanel, { sourceActivities: [activity], indices: [0] }));
      assert.ok(running.includes(translate('chat.tool.working')));
      assert.match(running, /aria-expanded="true"/);
      assert.match(running, /First result/);
      const done = renderToStaticMarkup(createElement(ToolActivityPanel, { sourceActivities: [{ ...activity, status: 'done' }], indices: [0] }));
      assert.match(done, /aria-expanded="false"/);
      assert.match(done, /aria-hidden="true" inert=""/);
      assert.doesNotMatch(done, /pd-activity-label is-active/);
    });

    await t.test('failures show output and long running tools expose their latest retained output', () => {
      const failed = renderToStaticMarkup(createElement(ToolActivityItem, { activity: { ...activity, status: 'error', detail: 'Missing configuration' } }));
      assert.match(failed, /aria-expanded="true"/);
      assert.match(failed, /Missing configuration/);
      assert.ok(failed.includes(translate('chat.tool.errorOutput')));
      const long = renderToStaticMarkup(createElement(ToolActivityItem, { activity: { ...activity, detail: 'OLD_START' + 'x'.repeat(13000) + 'LATEST_RESULT' } }));
      assert.match(long, /LATEST_RESULT/);
      assert.doesNotMatch(long, /OLD_START/);
      assert.ok(long.includes(translate('chat.tool.latestOutput')));
    });
  } finally {
    await server.close();
  }
});
