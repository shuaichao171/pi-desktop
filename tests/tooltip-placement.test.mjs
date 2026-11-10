// 侧栏行尾按钮的悬浮提示不能盖住同一行右侧的兄弟按钮（项目「新建会话」盖住项目菜单、
// 会话「置顶」盖住「归档」）。右侧提示改为从整条侧栏轨道的右缘之外弹出。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { placeTooltip, TOOLTIP_MIN_RIGHT_WIDTH, TOOLTIP_TRIGGER_GAP } from '../packages/ui/src/tooltipPlacement.ts';

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const viewport = { width: 1280, height: 800 };

test('right-side hints start past the sidebar rail instead of the trigger edge', () => {
	// Sidebar spans 0..280; "new chat" button at 220..244, the project menu button at 248..272.
	const newChat = rect(220, 100, 24, 24);
	const menuButton = rect(248, 100, 24, 24);
	const placement = placeTooltip({ trigger: newChat, hint: { width: 90, height: 28 }, viewport, side: 'right', align: 'center', railRight: 280 });
	assert.ok(placement);
	assert.equal(placement.side, 'right');
	assert.equal(placement.left, 280 + TOOLTIP_TRIGGER_GAP);
	// The hint box must not intersect the sibling button to the right.
	assert.ok(placement.left >= menuButton.right, 'hint overlaps the project menu button');
	assert.equal(placement.top, 98);
});

test('without a rail the hint keeps hugging the trigger', () => {
	const placement = placeTooltip({ trigger: rect(100, 100, 24, 24), hint: { width: 90, height: 28 }, viewport, side: 'right', align: 'start' });
	assert.equal(placement?.left, 124 + TOOLTIP_TRIGGER_GAP);
	assert.equal(placement?.top, 100);
});

test('a right-side hint hides instead of falling back over the list when the window is too narrow', () => {
	const narrow = { width: 280 + TOOLTIP_TRIGGER_GAP + TOOLTIP_MIN_RIGHT_WIDTH, height: 800 };
	assert.equal(placeTooltip({ trigger: rect(220, 100, 24, 24), hint: { width: 90, height: 28 }, viewport: narrow, side: 'right', align: 'center', railRight: 280 }), null);
});

test('top hints flip below when there is no room above and clamp to the viewport', () => {
	const placement = placeTooltip({ trigger: rect(4, 10, 200, 22), hint: { width: 300, height: 50 }, viewport, side: 'top', align: 'start' });
	assert.equal(placement?.side, 'bottom');
	assert.equal(placement?.left, 8);
	assert.equal(placement?.top, 10 + 22 + TOOLTIP_TRIGGER_GAP);
});

test('HoverTooltip resolves the sidebar rail for right-side hints', () => {
	const source = readFileSync(new URL('../packages/ui/src/components/HoverTooltip.tsx', import.meta.url), 'utf8');
	assert.match(source, /closest<HTMLElement>\(TOOLTIP_RAIL_SELECTOR\)/);
	assert.match(source, /placeTooltip\(/);
});
