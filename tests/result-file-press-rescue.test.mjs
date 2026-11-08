import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { resultFileCandidates } from '../packages/ui/src/resultFileCandidates.ts';
import { parseResultFileReference as realParseResultFileReference } from '../packages/ui/src/resultFileReferences.ts';

/**
 * The press rescue (resultFilePressRescue.ts) must produce the same
 * candidates-enriched target as ResultFileLink's normal click path. Both read
 * the chat store snapshot, so the contract under test is: openFromPress
 * attaches resultFileCandidates(reference.path, messages, activities) to the
 * opened target. The DOM-dependent module is exercised through a stubbed
 * window/store harness mirroring app-shell-storage.test.mjs.
 */

async function loadRescue({ storeState, opened }) {
  // TypeScript-strip via the repo's own typescript dependency (see app-shell-storage.test.mjs).
  const { createRequire } = await import('node:module');
  const typescript = createRequire(new URL('../packages/desktop/package.json', import.meta.url))('typescript');
  const source = typescript.transpileModule(
    readFileSync(new URL('../packages/ui/src/resultFilePressRescue.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 } },
  ).outputText
    .replace(/"use strict";/, '')
    .replace(/Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);/, '')
    .replace(/const \w+_1 = require\([^)]*\);/g, '')
    .replace(/\w+_1\./g, '')
    .replace(/exports\.installResultFilePressRescue = installResultFilePressRescue;/, '');
  const sandbox = {
    console,
    window: { addEventListener(_type, handler) { sandbox.__handlers.push([_type, handler]); } },
    document: undefined,
    resultFileCandidates,
    Element: class Element {},
    parseResultFileReference: realParseResultFileReference,
    useChatStore: { getState: () => storeState },
    useResultFilePreviewStore: { getState: () => ({ open: (target) => opened.push(target) }) },
    __handlers: [],
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  sandbox.installResultFilePressRescue();
  return sandbox;
}

const pointer = (type, opts) => ({ type, button: 0, clientX: opts?.x ?? 10, clientY: opts?.y ?? 10, target: opts?.target ?? null });

test('press rescue attaches conversation-mentioned candidates like the normal click path', async () => {
  const opened = [];
  const storeState = {
    bridge: {},
    cwd: 'C:\\Users\\Administrator\\PiDesktopWorkspace',
    navigationPending: false,
    messages: [{ id: '1', order: 1, role: 'assistant', text: '都在 `D:\\steam\\steamapps\\common\\Don\'t Starve Together\\data\\anim\\` 下面', status: 'done' }],
    activities: [],
  };
  const sandbox = await loadRescue({ storeState, opened });
  const down = sandbox.__handlers.find(([type]) => type === 'pointerdown')[1];
  const up = sandbox.__handlers.find(([type]) => type === 'pointerup')[1];
  // The vm realm's own Element: the rescue checks `event.target instanceof Element`.
  const link = new sandbox.Element();
  link.closest = () => ({ getAttribute: () => 'axe.zip' });
  down(pointer('pointerdown', { target: link }));
  up(pointer('pointerup', { target: link }));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].cwd, storeState.cwd);
  assert.deepEqual(opened[0].candidates, ["D:\\steam\\steamapps\\common\\Don't Starve Together\\data\\anim\\axe.zip"]);
  // Contract parity with ResultFileLink.withFallback:
  assert.deepEqual(opened[0].candidates, resultFileCandidates('axe.zip', storeState.messages, storeState.activities));
});

test('press rescue sends no candidates when the conversation mentions none', async () => {
  const opened = [];
  const storeState = {
    bridge: {}, cwd: 'C:\\ws', navigationPending: false,
    messages: [{ id: '1', order: 1, role: 'assistant', text: '没有任何路径', status: 'done' }],
    activities: [],
  };
  const sandbox = await loadRescue({ storeState, opened });
  const down = sandbox.__handlers.find(([type]) => type === 'pointerdown')[1];
  const up = sandbox.__handlers.find(([type]) => type === 'pointerup')[1];
  // The vm realm's own Element: the rescue checks `event.target instanceof Element`.
  const link = new sandbox.Element();
  link.closest = () => ({ getAttribute: () => 'axe.zip' });
  down(pointer('pointerdown', { target: link }));
  up(pointer('pointerup', { target: link }));
  assert.equal(opened.length, 1);
  assert.equal('candidates' in opened[0], false);
});
