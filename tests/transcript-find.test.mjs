import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

test('the transcript find bar counts matches and exposes keyboard stepping', async () => {
  const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
  const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
  const server = await createServer({
    root: fileURLToPath(new URL('../packages/ui', import.meta.url)),
    configFile: false, server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  });
  try {
    const { TranscriptFind } = await server.ssrLoadModule('/src/components/TranscriptFind.tsx');
    const { translate } = await server.ssrLoadModule('/src/i18n.ts');
    const html = renderToStaticMarkup(createElement(TranscriptFind, { query: 'needle', onQueryChange() {}, index: 1, total: 3, onStep() {}, onClose() {} }));
    assert.match(html, /pd-transcript-find/);
    assert.ok(html.includes(translate('chat.find.count', { current: '2', total: '3' })));
    assert.ok(!html.includes('disabled'));
    const empty = renderToStaticMarkup(createElement(TranscriptFind, { query: 'zzz', onQueryChange() {}, index: null, total: 0, onStep() {}, onClose() {} }));
    assert.match(empty, /pd-transcript-find-count is-empty/);
    assert.ok(empty.includes(translate('chat.find.noResults')));
    assert.ok(empty.includes('disabled'));

    const partial = renderToStaticMarkup(createElement(TranscriptFind, { query: 'old needle', onQueryChange() {}, index: null, total: 0, onStep() {}, onClose() {}, loadedMessages: 40, hasOlder: true, onLoadOlder() {} }));
    assert.ok(partial.includes(translate('chat.find.loadedOnly', { count: '40' })));
    assert.ok(partial.includes(translate('chat.find.loadOlder')));
    assert.match(partial, /pd-transcript-find-scope.*role="status"/);
    assert.ok(!empty.includes('pd-transcript-find-scope'), 'complete histories do not show a scope warning');
  } finally {
    await server.close();
  }
});

test('a folded turn keeps an sr-only data-find-omitted placeholder that disappears when a hit expands it', async () => {
  const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
  const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
  const server = await createServer({
    root: fileURLToPath(new URL('../packages/ui', import.meta.url)),
    configFile: false, server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  });
  try {
    const { ConversationTurn } = await server.ssrLoadModule('/src/components/ConversationTurn.tsx');
    const { buildConversationTimeline } = await server.ssrLoadModule('/src/conversationTimeline.ts');
    const { translate } = await server.ssrLoadModule('/src/i18n.ts');
    const messages = [
      { id: 'u1', order: 0, role: 'user', text: 'go', status: 'done' },
      { id: 'a1', order: 2, runId: 'r1', role: 'assistant', text: 'done', thinking: 'needle thought', thinkingStatus: 'done', status: 'done' },
    ];
    const activities = [{ id: 't1', order: 1, runId: 'r1', tool: 'bash', title: 'bash(grep needle src)', status: 'done', command: 'grep needle src' }];
    const runs = [{ id: 'r1', status: 'completed', startedAt: 1, finishedAt: 2 }];
    const timeline = buildConversationTimeline(messages, activities, runs);
    const turnEntry = timeline.find((entry) => entry.kind === 'turn');
    assert.ok(turnEntry, 'the run groups into a turn');
    const props = (query) => ({ entry: turnEntry, messages, activities, run: runs[0], changesReview() {}, legacyRunning: false, highlightedId: null, findIds: new Set(), query, reveal: null, canRegenerateId: null, findTurnIds: new Set([turnEntry.id]), activeFindTurnId: null });
    const folded = renderToStaticMarkup(createElement(ConversationTurn, props('')));
    assert.match(folded, /data-turn-id=/, 'turns expose a jumpable row id');
    assert.ok(folded.includes('data-find-omitted'), 'the folded placeholder carries the omission marker');
    assert.ok(folded.includes(translate('chat.find.omittedLabel').trim()), 'the placeholder is introduced for screen readers');
    assert.ok(folded.includes('grep needle src'), 'the omitted tool title stays readable in the placeholder');
    assert.ok(folded.includes('pd-conversation-turn is-completed is-find-match'), 'a turn with tool-title hits gets the match outline');

    const expanded = renderToStaticMarkup(createElement(ConversationTurn, props('needle')));
    assert.ok(!expanded.includes('data-find-omitted'), 'an expanded turn drops the placeholder');
    assert.match(expanded, /aria-expanded="true"/, 'a tool-title hit expands the fold so the original is visible');
    assert.ok(expanded.includes('pd-turn-steps'), 'the process content mounts once expanded');
  } finally {
    await server.close();
  }
});
