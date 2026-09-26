import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

test('shortcut registry parsing, matching and conflicts (4.3)', async (t) => {
  const { parseKeys, matchesShortcut, bindingKeysFor, readShortcutOverrides, writeShortcutOverrides, SHORTCUT_BINDINGS } = await import('../packages/ui/src/shortcuts/bindings.ts');
  const { findShortcutConflicts, isShortcutTaken } = await import('../packages/ui/src/shortcuts/conflicts.ts');

  await t.test('parseKeys handles modifiers, aliases and rejects empty specs', () => {
    assert.deepEqual(parseKeys('Ctrl+Shift+P'), { ctrl: true, shift: true, alt: false, key: 'P' });
    assert.deepEqual(parseKeys('Alt+ArrowUp'), { ctrl: false, shift: false, alt: true, key: 'ArrowUp' });
    assert.deepEqual(parseKeys('Ctrl+]'), { ctrl: true, shift: false, alt: false, key: ']' });
    assert.equal(parseKeys('Ctrl+'), null);
    assert.equal(parseKeys(''), null);
  });

  await t.test('matchesShortcut maps Ctrl/⌘ to the primary modifier and brackets to keys or codes', () => {
    const ctrlK = { ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: 'k', code: 'KeyK' };
    const metaK = { ctrlKey: false, metaKey: true, shiftKey: false, altKey: false, key: 'k', code: 'KeyK' };
    assert.equal(matchesShortcut(ctrlK, 'Ctrl+K'), true);
    assert.equal(matchesShortcut(metaK, 'Ctrl+K'), true);
    assert.equal(matchesShortcut({ ...ctrlK, shiftKey: true }, 'Ctrl+K'), false);
    const bracket = { ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: '[', code: 'BracketLeft' };
    assert.equal(matchesShortcut(bracket, 'Ctrl+['), true);
    const codeOnlyBracket = { ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: 'Dead', code: 'BracketLeft' };
    assert.equal(matchesShortcut(codeOnlyBracket, 'Ctrl+['), true);
    const altDown = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: true, key: 'ArrowDown', code: 'ArrowDown' };
    assert.equal(matchesShortcut(altDown, 'Alt+ArrowDown'), true);
  });

  await t.test('registry defaults are conflict-free', () => {
    assert.deepEqual(findShortcutConflicts({}), []);
  });

  await t.test('unassigned shortcuts do not conflict with each other', () => {
    const overrides = { search: '', historyBack: '', historyForward: '   ' };
    assert.deepEqual(findShortcutConflicts(overrides), []);
		assert.equal(isShortcutTaken('historyBack', '', overrides), false);
    assert.equal(isShortcutTaken('search', '   ', overrides), false);
  });

	await t.test('shortcut overrides persist and resetting restores the default binding', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const values = new Map();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    } });
    try {
			writeShortcutOverrides({ historyBack: 'Ctrl+Shift+U', search: 'Ctrl+G' });
			const overrides = readShortcutOverrides();
			assert.equal(bindingKeysFor('historyBack'), 'Ctrl+Shift+U');
			delete overrides.historyBack;
			writeShortcutOverrides(overrides);
			assert.equal(bindingKeysFor('historyBack'), 'Ctrl+[');
      assert.equal(bindingKeysFor('search'), 'Ctrl+G');
      assert.deepEqual(findShortcutConflicts(readShortcutOverrides()), []);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
      else delete globalThis.localStorage;
    }
  });

  await t.test('overrides take effect and conflicts are detected within the window namespace', () => {
    const overrides = { search: 'Ctrl+B' };
    assert.equal(bindingKeysFor('search', overrides), 'Ctrl+B');
    assert.equal(bindingKeysFor('toggleSidebar', overrides), 'Ctrl+B');
    const conflicts = findShortcutConflicts(overrides);
    assert.equal(conflicts.length, 1);
    assert.deepEqual([...conflicts[0].ids].sort(), ['search', 'toggleSidebar']);
    assert.equal(isShortcutTaken('search', 'Ctrl+K', overrides), false);
    assert.equal(isShortcutTaken('historyBack', 'Ctrl+B', overrides), true);
  });

  await t.test('composer entries never collide with window-level bindings', () => {
    assert.equal(isShortcutTaken('search', 'Enter'), false);
  });

  await t.test('every registry label key and id is unique', () => {
    const ids = SHORTCUT_BINDINGS.map((binding) => binding.id);
    assert.equal(new Set(ids).size, ids.length);
    const labels = SHORTCUT_BINDINGS.map((binding) => binding.labelKey);
    assert.equal(new Set(labels).size, labels.length);
  });
});
