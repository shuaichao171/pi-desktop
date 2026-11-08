// 「正在后台重载」浮动提示卡片的渲染端回归：一个 id 贯穿整批修改，
// 连续保存只替换同一张卡片，重载结果就地改写而不是另开一张。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useChatStore } from '../packages/ui/src/store.ts';
import { operationFeedback } from '../packages/ui/src/operationFeedback.ts';
import { translate } from '../packages/ui/src/i18n.ts';

const card = () => operationFeedback.getSnapshot().filter((notice) => notice.id === 'provider-resync');

test('provider resync uses one floating card per burst and rewrites it in place', () => {
	const store = useChatStore.getState();
	store.handleEvent({ type: 'provider-resync', providers: ['alpha'], status: 'pending' });
	assert.equal(card().length, 1);
	assert.equal(card()[0].kind, 'pending');
	assert.equal(card()[0].title, translate('settings.providerResyncPending'));
	assert.equal(card()[0].detail, translate('settings.providerResyncProviders', { providers: 'alpha' }));

	// Consecutive saves during the same burst widen the same card instead of stacking notices.
	store.handleEvent({ type: 'provider-resync', providers: ['alpha', 'beta'], status: 'pending' });
	assert.equal(card().length, 1);
	assert.equal(card()[0].kind, 'pending');
	assert.equal(card()[0].detail, translate('settings.providerResyncProviders', { providers: 'alpha / beta' }));

	store.handleEvent({ type: 'provider-resync', providers: ['alpha', 'beta'], status: 'done', warnings: [] });
	assert.equal(card().length, 1);
	assert.equal(card()[0].kind, 'success');
	assert.equal(card()[0].title, translate('settings.providerResyncDone'));
	assert.equal(card()[0].detail, undefined);

	// Extension load problems keep the result visible instead of claiming a clean reload.
	store.handleEvent({ type: 'provider-resync', providers: ['alpha'], status: 'done', warnings: ['extension failed'] });
	assert.equal(card()[0].kind, 'warning');
	assert.equal(card()[0].detail, 'extension failed');

	store.handleEvent({ type: 'provider-resync', providers: ['alpha'], status: 'failed', error: 'reload exploded' });
	assert.equal(card().length, 1);
	assert.equal(card()[0].kind, 'error');
	assert.equal(card()[0].title, translate('settings.providerResyncFailed'));
	assert.equal(card()[0].detail, 'reload exploded');
	operationFeedback.dismiss('provider-resync');
});
