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
    const { ConversationTurn } = await server.ssrLoadModule('/src/components/ConversationTurn.tsx');
    const { buildConversationTimeline } = await server.ssrLoadModule('/src/conversationTimeline.ts');
    const { createDisclosureStore } = await server.ssrLoadModule('/src/conversationDisclosure.tsx');
    const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
    const read = { id: 'read-1', order: 1, tool: 'read', title: 'read(src/main.ts)', status: 'done', detail: 'retained file contents', files: ['src/main.ts'] };

    await context.test('running turns render thinking and prose together until the whole run settles', () => {
      const run = { id: 'live', status: 'running', startedAt: 1000, finishedAt: null };
      const messages = [{ id: 'live-a', order: 1, runId: 'live', role: 'assistant', text: 'Checking the source.', thinking: 'Inspect lifecycle boundaries.', thinkingStatus: 'done', status: 'streaming' }];
      const renderTurn = (currentMessages, currentRun, activities = [], legacyRunning = false) => render(ConversationTurn, {
        entry: buildConversationTimeline(currentMessages, activities, currentRun ? [currentRun] : [])[0],
        messages: currentMessages, activities, run: currentRun, legacyRunning,
        highlightedId: null, findIds: new Set(), query: '', reveal: null, canRegenerateId: null,
      });
      const assertLiveProcess = html => {
        assert.match(html, /pd-turn-summary[^>]*aria-expanded="true"/);
        assert.match(html, /pd-turn-process/);
        assert.match(html, /Inspect lifecycle boundaries\./);
        assert.match(html, /is-process-message[^>]*data-message-id="live-a"/);
        assert.match(html, /Checking the source\./);
        assert.doesNotMatch(html, /pd-turn-answer/);
      };
      assertLiveProcess(renderTurn(messages, run));
      const ended = [{ ...messages[0], status: 'done' }];
      assertLiveProcess(renderTurn(ended, run));
      assertLiveProcess(renderTurn(ended, run, [{ ...read, order: 2, runId: run.id }]));
      assertLiveProcess(renderTurn(messages.map(({ runId, ...message }) => message), undefined, [], true));
      const finalMessages = [...ended, { id: 'live-final', order: 3, runId: run.id, role: 'assistant', text: 'Final result.', status: 'done' }];
      assertLiveProcess(renderTurn(finalMessages, run));
      for (const status of ['completed', 'cancelled', 'failed', 'interrupted']) {
        const settled = renderTurn(finalMessages, { ...run, status, finishedAt: 3000 });
        assert.match(settled, /pd-turn-summary[^>]*aria-expanded="false"/);
        assert.match(settled, /pd-turn-answer[\s\S]*data-message-id="live-final"[\s\S]*Final result\./);
      }
      // The turn header summarizes its tools semantically (the inline groups have no header of their own).
      const explored = renderTurn(finalMessages, { ...run, status: 'completed', finishedAt: 3000 }, [
        { ...read, order: 2, runId: run.id },
        { ...read, id: 'grep-1', tool: 'grep', title: 'grep(TODO)', files: null, order: 2.5, runId: run.id },
      ]);
      assert.match(explored, /pd-turn-summary[\s\S]*(?:已探索|Explored)[\s\S]*pd-turn-count[^>]*>(?:读取 1 个文件 · 搜索 1 次|Read 1 file · 1 search)</);
      const mixed = renderTurn(finalMessages, { ...run, status: 'completed', finishedAt: 3000 }, [
        { ...read, order: 2, runId: run.id },
        { ...read, id: 'bash-1', tool: 'bash', title: 'bash(pnpm test)', command: 'pnpm test', files: null, order: 2.5, runId: run.id },
      ]);
      assert.match(mixed, /(?:已完成|Worked)[\s\S]*pd-turn-count[^>]*>(?:读取 1 个文件 · 运行 1 条命令|Read 1 file · Ran 1 command)</);
      const directReply = renderTurn([{ id: 'plain', order: 0, role: 'assistant', text: 'Direct reply.', status: 'streaming' }], undefined, [], true);
      assert.match(directReply, /pd-turn-process[\s\S]*Direct reply\./);
      assert.doesNotMatch(directReply, /pd-turn-answer/);
    });

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

    await context.test('failed commands stay collapsed by default yet retain full commands, errors, copy and wrapping controls', () => {
      const command = 'node --test\n tests/a.test.mjs --test-name-pattern=preserve-last-argument';
      const html = render(ToolActivityItem, { activity: { ...read, tool: 'bash', title: 'bash(node --test…)', status: 'error', command, exitCode: 1, detail: 'specific failure output', files: [] } });
      assert.match(html, /pd-activity-head[^>]*aria-expanded="false"/, 'failures no longer auto-expand (zcode keeps tool blocks folded)');
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

    await context.test('tool result images render a badge and lazy thumbnails that wait for the bridge', () => {
      const html = render(ToolActivityItem, { activity: { ...read, images: [{ mimeType: 'image/png', approxBytes: 9 }] } });
      assert.match(html, /pd-activity-image-badge/, 'head shows the image count badge');
      assert.match(html, /title="1 张图片"|title="1 images"/, 'badge tooltip is localized');
      assert.match(html, /pd-activity-images/, 'detail reserves the thumbnail strip');
      assert.match(html, /pd-activity-image-note[^>]*>image\/png</, 'placeholder names the mime type until the payload loads');
      assert.doesNotMatch(html, /<img /, 'no base64 payload ships with the activity');
    });

    await context.test('thinking stays collapsed by default with a live preview while retaining the real model content', () => {
      const message = { id: 'thinking-1', order: 2, role: 'assistant', text: '', thinking: 'Actual model note with **a concrete check**.', thinkingStatus: 'done', status: 'done' };
      const settled = render(ThinkingActivity, { message });
      assert.match(settled, /pd-thinking-summary[^>]*aria-expanded="false"/);
      assert.match(settled, /pd-thinking-preview[^>]*><span>Actual model note with \*\*a concrete check\*\*\.<\/span>/);
      assert.match(settled, /Actual model note with <strong>a concrete check<\/strong>/);
      assert.match(settled, /aria-hidden="true" inert=""/);
      const streaming = render(ThinkingActivity, { message: { ...message, thinkingStatus: 'streaming', status: 'streaming' } });
      assert.match(streaming, /pd-thinking-summary[^>]*aria-expanded="false"/);
      assert.match(streaming, /pd-thinking-preview/);
      assert.match(streaming, /Actual model note/);
      assert.doesNotMatch(render(ThinkingActivity, { message: { ...message, thinking: '' } }), /aria-expanded="true"/);
    });
  } finally { await server.close(); }
});
