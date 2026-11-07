import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

test('worker-backed diff rows and long code blocks degrade to the synchronous rendering', async () => {
  const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
  const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
  const server = await createServer({
    root: fileURLToPath(new URL('../packages/ui', import.meta.url)),
    configFile: false, server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  });
  try {
    const { ToolDiffView } = await server.ssrLoadModule('/src/components/toolRenderers/ToolDiffView.tsx');
    const { CodeBlock } = await server.ssrLoadModule('/src/components/CodeBlock.tsx');
    const { StreamingContentContext } = await server.ssrLoadModule('/src/streamingContent.ts');
    const { DIFF_PARSE_CHAR_LIMIT } = await server.ssrLoadModule('/src/diffWorkerPool.ts');

    // Without workers (SSR) useDiffParse answers synchronously — the fallback path.
    const rows = renderToStaticMarkup(createElement(ToolDiffView, { diff: ' 1 keep\n-2 old\n+2 new' }));
    assert.match(rows, /pd-diff-line is-addition/);
    assert.match(rows, /pd-diff-line is-deletion/);
    assert.ok(rows.includes('new'));
    const oversized = renderToStaticMarkup(createElement(ToolDiffView, { diff: `+1 ${'x'.repeat(DIFF_PARSE_CHAR_LIMIT)}` }));
    assert.match(oversized, /pd-diff-line is-addition/, 'even over the worker limit the fallback parses inline');

    // Over the synchronous highlight limit the block renders as escaped plain
    // text first — in SSR no effect runs, exactly like the pre-worker behaviour.
    const long = `const a = 1;\n${'line();\n'.repeat(2100)}`;
    const plain = renderToStaticMarkup(createElement(CodeBlock, { code: long, language: 'ts' }));
    assert.match(plain, /pd-code-block-language">ts</);
    assert.ok(plain.includes('line();'));
    assert.doesNotMatch(plain, /hljs-keyword/);

    // A streaming message keeps the same plain rendering; only stable content
    // would hand the block to the highlight worker.
    const streaming = renderToStaticMarkup(createElement(StreamingContentContext.Provider, { value: true },
      createElement(CodeBlock, { code: long, language: 'ts' })));
    assert.equal(streaming, plain);

    // Small blocks still highlight synchronously once hljs has loaded.
    await (await server.ssrLoadModule('/src/codeHighlighter.ts')).loadHighlighter();
    const small = renderToStaticMarkup(createElement(CodeBlock, { code: 'const a = 1;\n', language: 'ts' }));
    assert.match(small, /hljs-keyword/);
  } finally {
    await server.close();
  }
});
