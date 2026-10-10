// Built-renderer regression through an owned headless shell; never attaches a user window.
// 完成对话（agent_settled → fireReady 重同步）不得把阅读位置拉回最底部（zcode 语义：内容变化 following?贴底:hold）。
// Prepare: node --check tests/fixtures/conversation-completion-scroll/scenarios.mjs
// Run after build: node tests/fixtures/model-settings/run.mjs --run --scenario=../conversation-completion-scroll/scenarios.mjs
export default async function conversationCompletionScrollScenarios(review) {
	await review.waitFor('window.__modelReview?.ready === true');
	await review.reducedMotion(true);
	await review.viewport(1440, 1000);

	// 一个已有多轮持久化消息的会话。
	await review.evaluate(`(() => {
		const fixture = window.__modelReview;
		const state = window.__completionReview = {};
		const turn = index => ([
			{ id: 'msg-u-' + index, order: index * 2, role: 'user', text: '问题 ' + (index + 1) + '：' + '这是一段足够长的正文，用来把会话撑出明显的可滚动高度。 '.repeat(6), status: 'done' },
			{ id: 'msg-a-' + index, order: index * 2 + 1, role: 'assistant', text: '回答 ' + (index + 1) + '：' + '这是对应的回答正文，同样保持足够的长度以便滚动定位。 '.repeat(6), status: 'done' },
		]);
		const messages = Array.from({ length: 8 }, (_, index) => turn(index)).flat();
		Object.assign(fixture.snapshot, { messages, activities: [], runs: [], historyTotal: messages.length, status: 'idle', error: null });
		window.piDesktop.listSessions = async () => [];
		fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
		fixture.emitAgent({ type: 'status', status: 'idle' });
	})()`);
	await review.waitFor('Boolean(document.querySelector("[data-message-id=msg-a-7]")) && document.querySelector(".pd-transcript").scrollHeight > document.querySelector(".pd-transcript").clientHeight');

	// 新一轮对话：瞬态 id 的用户消息与流式回答。
	await review.evaluate(`(() => {
		const fixture = window.__modelReview;
		fixture.emitAgent({ type: 'status', status: 'busy' });
		fixture.emitAgent({ type: 'user-message', id: 'live-user', order: 16, text: '请继续分析这个滚动问题。' });
		fixture.emitAgent({ type: 'assistant-start', id: 'live-assistant', order: 17 });
		fixture.emitAgent({ type: 'assistant-delta', id: 'live-assistant', delta: '流式回答正文。 '.repeat(40) });
	})()`);
	await review.waitFor('Boolean(document.querySelector("[data-message-id=live-assistant]"))');

	// 用户上滚离开底部，正在读较早的内容。
	const reading = await review.evaluate(`(() => {
		const transcript = document.querySelector('.pd-transcript');
		const row = document.querySelector('[data-message-id=msg-a-3]');
		row.scrollIntoView({ block: 'start' });
		transcript.dispatchEvent(new Event('scroll'));
		return { top: transcript.scrollTop, rowTop: row.getBoundingClientRect().top - transcript.getBoundingClientRect().top };
	})()`);
	await review.settle();
	await review.waitFor('document.querySelector(".pd-back-to-bottom").classList.contains("is-visible") === true');
	await review.screenshot('completion-scroll-reading');

	// agent_settled：fireReady 用持久化 id 重建可见窗口（瞬态 id 被替换）。
	await review.evaluate(`(() => {
		const fixture = window.__modelReview;
		const messages = fixture.snapshot.messages
			.filter(message => message.id !== 'live-user' && message.id !== 'live-assistant')
			.concat([
				{ id: 'msg-u-8', order: 16, role: 'user', text: '请继续分析这个滚动问题。', status: 'done' },
				{ id: 'msg-a-8', order: 17, role: 'assistant', text: '流式回答正文。 '.repeat(40), status: 'done' },
			]);
		Object.assign(fixture.snapshot, { messages, historyTotal: messages.length, status: 'idle' });
		fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready', resync: true });
		fixture.emitAgent({ type: 'status', status: 'idle' });
	})()`);

	// 回合完成后：阅读位置必须保持在原处，不得跳到最底部。
	await review.settle();
	await review.assert(`(() => {
		const transcript = document.querySelector('.pd-transcript');
		return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight > 200;
	})()`, 'Settled-turn resync keeps the reading position away from the bottom');
	await review.assert(`(() => {
		const row = document.querySelector('[data-message-id=msg-a-3]');
		const transcript = document.querySelector('.pd-transcript');
		return Math.abs(row.getBoundingClientRect().top - transcript.getBoundingClientRect().top - ${reading.rowTop}) < 8;
	})()`, 'The anchored row stays at the same viewport offset after the turn settles');
	await review.assert('document.querySelector(".pd-back-to-bottom").classList.contains("is-visible") === true', 'Back-to-bottom stays available while reading away from the bottom');
	await review.screenshot('completion-scroll-held');

	// 阅读锚点落在流式行（瞬态 id）上时，settle 重同步替换 id 后锚点必须从 DOM 重挂，
	// 否则重开会话时定位失败回退跳底。
	await review.evaluate(`(() => {
		const fixture = window.__modelReview;
		fixture.emitAgent({ type: 'status', status: 'busy' });
		fixture.emitAgent({ type: 'user-message', id: 'live-user-2', order: 18, text: '再分析一轮。' });
		fixture.emitAgent({ type: 'assistant-start', id: 'live-assistant-2', order: 19 });
		fixture.emitAgent({ type: 'assistant-delta', id: 'live-assistant-2', delta: '第二轮流式回答。 '.repeat(60) });
	})()`);
	await review.waitFor('Boolean(document.querySelector("[data-message-id=live-assistant-2]"))');
	await review.evaluate(`(() => {
		const transcript = document.querySelector('.pd-transcript');
		const row = document.querySelector('[data-message-id=live-assistant-2]');
		row.scrollIntoView({ block: 'start' });
		transcript.dispatchEvent(new Event('scroll'));
	})()`);
	await review.settle();
	await review.evaluate(`(() => {
		const fixture = window.__modelReview;
		const messages = fixture.snapshot.messages
			.filter(message => message.id !== 'live-user-2' && message.id !== 'live-assistant-2')
			.concat([
				{ id: 'msg-u-9', order: 18, role: 'user', text: '再分析一轮。', status: 'done' },
				{ id: 'msg-a-9', order: 19, role: 'assistant', text: '第二轮流式回答。 '.repeat(60), status: 'done' },
			]);
		Object.assign(fixture.snapshot, { messages, historyTotal: messages.length, status: 'idle' });
		fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready', resync: true });
		fixture.emitAgent({ type: 'status', status: 'idle' });
	})()`);
	await review.waitFor('Boolean(document.querySelector("[data-message-id=msg-a-9]"))');
	const beforeSwitch = await review.evaluate('(() => { const t = document.querySelector(".pd-transcript"); return { rowTop: document.querySelector("[data-message-id=msg-a-9]").getBoundingClientRect().top - t.getBoundingClientRect().top, top: t.scrollTop }; })()');
	// 切走再切回：阅读位置应恢复到同一行，而不是跳底。
	await review.evaluate(`(() => {
		const fixture = window.__modelReview;
		const state = window.__completionReview;
		state.kept = structuredClone(fixture.snapshot);
		Object.assign(fixture.snapshot, { sessionId: 'other-session', sessionPath: 'C:\\renderer-review\\other.jsonl', messages: [{ id: 'other-user', order: 0, role: 'user', text: '另一个会话', status: 'done' }], activities: [], runs: [], historyTotal: 1 });
		fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
	})()`);
	await review.waitFor('Boolean(document.querySelector("[data-message-id=other-user]"))');
	await review.evaluate(`(() => {
		const fixture = window.__modelReview;
		Object.assign(fixture.snapshot, window.__completionReview.kept);
		fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
	})()`);
	await review.waitFor('Boolean(document.querySelector("[data-message-id=msg-a-9]"))');
	await review.settle();
	await review.assert(`Math.abs(document.querySelector('[data-message-id=msg-a-9]').getBoundingClientRect().top - document.querySelector('.pd-transcript').getBoundingClientRect().top - ${beforeSwitch.rowTop}) < 8`, 'Reopening the session restores the reading row captured before the id swap');
	await review.assert(`Math.abs(document.querySelector('.pd-transcript').scrollTop - ${beforeSwitch.top}) < 8`, 'Reopening the session keeps scrollTop instead of falling back to the bottom');
	await review.screenshot('completion-scroll-reopened');

	// 贴底跟随的用户在回合完成后仍应贴底（following → stickToBottom）。
	await review.evaluate(`(() => {
		const transcript = document.querySelector('.pd-transcript');
		transcript.scrollTop = transcript.scrollHeight;
		transcript.dispatchEvent(new Event('scroll'));
	})()`);
	await review.settle();
	await review.waitFor('document.querySelector(".pd-back-to-bottom").classList.contains("is-visible") === false');
	await review.evaluate(`(() => {
		const fixture = window.__modelReview;
		const messages = fixture.snapshot.messages.concat([
			{ id: 'msg-u-10', order: 20, role: 'user', text: '追问一句。', status: 'done' },
			{ id: 'msg-a-10', order: 21, role: 'assistant', text: '追问回答。 '.repeat(20), status: 'done' },
			{ id: 'msg-a-9', order: 19, role: 'assistant', text: '追问回答。 '.repeat(20), status: 'done' },
		]);
		Object.assign(fixture.snapshot, { messages, historyTotal: messages.length });
		fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready', resync: true });
	})()`);
	await review.settle();
	await review.assert(`(() => {
		const transcript = document.querySelector('.pd-transcript');
		return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 24;
	})()`, 'A following reader stays pinned to the bottom across the resync');
}
