import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

test('structured tool cards, edit diffs and code blocks stay readable and accessible', async (t) => {
  const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
  const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
  const server = await createServer({
    root: fileURLToPath(new URL('../packages/ui', import.meta.url)),
    configFile: false, server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  });
  try {
    const { ToolActivityItem } = await server.ssrLoadModule('/src/components/ToolActivity.tsx');
    const { CodeBlock } = await server.ssrLoadModule('/src/components/CodeBlock.tsx');
    const { MessageItem } = await server.ssrLoadModule('/src/components/MessageItem.tsx');
    const { parsePiEditDiff } = await server.ssrLoadModule('/src/unifiedDiff.ts');
    const { buildTimelineLayout } = await server.ssrLoadModule('/src/timeline.ts');
    const { translate } = await server.ssrLoadModule('/src/i18n.ts');

    await t.test('Pi edit diff rows parse into numbered line kinds', () => {
      const rows = parsePiEditDiff(' 1 keep\n-2 old line\n+2 new line\n  ...');
      assert.deepEqual(rows[0], { kind: 'context', text: 'keep', oldLine: 1, newLine: 1 });
      assert.deepEqual(rows[1], { kind: 'deletion', text: 'old line', oldLine: 2 });
      assert.deepEqual(rows[2], { kind: 'addition', text: 'new line', newLine: 2 });
      assert.deepEqual(rows[3], { kind: 'elision', text: '…' });
    });

    await t.test('finished edit cards show timing, path chips and a real diff', () => {
      const html = renderToStaticMarkup(createElement(ToolActivityItem, { activity: {
        id: 'e1', order: 1, tool: 'edit', title: 'edit(src/a.ts)', status: 'done',
        startedAt: 1_000, endedAt: 2_500, files: ['src/a.ts'], diff: '-1 old\n+1 new',
      } }));
      assert.match(html, /pd-activity-diff/);
      assert.match(html, /pd-diff-line is-addition/);
      assert.match(html, /pd-diff-line is-deletion/);
      assert.match(html, /pd-activity-file/);
      assert.ok(html.includes('src/a.ts'));
      assert.ok(html.includes('1.5s'));
      assert.doesNotMatch(html, /pd-activity-exit/);
    });

    await t.test('failed bash calls surface the exit code next to elapsed time', () => {
      const html = renderToStaticMarkup(createElement(ToolActivityItem, { activity: {
        id: 'b1', order: 2, tool: 'bash', title: 'bash(npm run build)', status: 'error',
        detail: 'error text\n\nCommand exited with code 1', exitCode: 1,
        startedAt: Date.now() - 57_000, endedAt: Date.now() - 1_000,
      } }));
      assert.match(html, /pd-activity-exit/);
      assert.ok(html.includes(translate('chat.tool.exitCode', { code: 1 })));
      assert.match(html, /56s|57s|58s/);
    });

    await t.test('legacy activities without timing still render', () => {
      const html = renderToStaticMarkup(createElement(ToolActivityItem, { activity: {
        id: 'l1', order: 3, tool: 'read', title: 'read(src/old.ts)', status: 'done', detail: 'contents',
      } }));
      assert.doesNotMatch(html, /pd-activity-duration/);
      assert.ok(html.includes('contents'));
    });

    await t.test('code blocks label, fold and highlight fenced content', () => {
      // Digit-free rows keep hljs from splitting the text with token spans.
      const long = Array.from({ length: 40 }, (_, index) => `const ${'a'.repeat(index + 1)} = value;`).join('\n');
      const folded = renderToStaticMarkup(createElement(CodeBlock, { code: long, language: 'ts' }));
      assert.match(folded, /pd-code-block-language">ts</);
      assert.match(folded, /aria-expanded="false"/);
      assert.ok(folded.includes(`${'a'.repeat(30)} = value;`));
      assert.ok(!folded.includes(`${'a'.repeat(40)} = value;`));
      assert.ok(folded.includes(translate('chat.code.expand', { count: '40' })));
      const highlighted = renderToStaticMarkup(createElement(CodeBlock, { code: 'const value = 1;', language: 'ts' }));
      assert.match(highlighted, /hljs-keyword/);
      const unknown = renderToStaticMarkup(createElement(CodeBlock, { code: 'plain', language: 'no-such-lang' }));
      assert.ok(unknown.includes(translate('chat.code.plain')));
      assert.doesNotMatch(unknown, /hljs-/);
    });

    await t.test('markdown code renders as blocks while inline code stays inline', () => {
      const block = renderToStaticMarkup(createElement(MessageItem, { message: {
        id: 'm1', order: 1, role: 'assistant', text: 'Explanation\n```ts\nconst a = 1;\n```', status: 'done',
      } }));
      assert.match(block, /pd-code-block/);
      assert.match(block, /hljs-keyword/);
      assert.match(block, /pd-assistant-heading/);
      const continuation = renderToStaticMarkup(createElement(MessageItem, { message: {
        id: 'm1', order: 1, role: 'assistant', text: 'Explanation\n```ts\nconst a = 1;\n```', status: 'done',
      }, showHeading: false }));
      assert.doesNotMatch(continuation, /pd-assistant-heading/);
      const inline = renderToStaticMarkup(createElement(MessageItem, { message: {
        id: 'm2', order: 2, role: 'assistant', text: 'use `code` inline', status: 'done',
      } }));
      assert.ok(!inline.includes('pd-code-block'));
    });

    await t.test('the assistant heading marks block starts only', () => {
      const messages = [
        { id: 'u1', order: 0, role: 'user', text: 'hi', status: 'done' },
        { id: 'a1', order: 1, role: 'assistant', text: 'one', status: 'done' },
        { id: 'a2', order: 2, role: 'assistant', text: 'two', status: 'done' },
      ];
      const headings = buildTimelineLayout(messages, [])
        .filter((entry) => entry.kind === 'message')
        .map((entry) => entry.showAssistantHeading);
      assert.deepEqual(headings, [false, true, false]);
    });
  } finally {
    await server.close();
  }
});
