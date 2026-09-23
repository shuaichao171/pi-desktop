import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

test('message component renders historical image and text attachments', async () => {
  const { createServer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href);
  const { createElement } = await import(pathToFileURL(uiRequire.resolve('react')).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href);
  const server = await createServer({
    root: fileURLToPath(new URL('../packages/ui', import.meta.url)),
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  try {
    const { MessageItem } = await server.ssrLoadModule('/src/components/MessageItem.tsx');
    const html = renderToStaticMarkup(createElement(MessageItem, {
      message: {
        id: 'message-1', order: 1, role: 'user', text: 'Please review', status: 'done',
        attachments: [
          { kind: 'image', name: 'old.gif', mimeType: 'image/gif', data: 'R0lGODlhAQABAAAAACw=' },
          { kind: 'text', name: 'notes.md', mimeType: 'text/markdown', text: '# Notes' },
        ],
      },
    }));
    assert.match(html, /old\.gif/);
    assert.match(html, /data:image\/gif;base64,/);
    assert.match(html, /notes\.md/);
    assert.match(html, /# Notes/);

  } finally {
    await server.close();
  }
});
