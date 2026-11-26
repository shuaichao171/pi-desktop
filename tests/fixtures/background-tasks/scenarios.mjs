// Background tasks status bar in the conversation view:
// shows still-running tasks after a reply finishes, expands details, updates on
// completion/failure, handles multiple tasks, stop action, and hides old history.
// node tests/fixtures/model-settings/run.mjs --run --theme=dark --scenario=../background-tasks/scenarios.mjs
// node tests/fixtures/model-settings/run.mjs --run --theme=light --scenario=../background-tasks/scenarios.mjs
import assert from 'node:assert/strict';

function seedIdleConversationWithOneRunningTask() {
	const fixture = window.__modelReview;
	const now = Date.now();
	fixture.stoppedTasks = [];
	window.piDesktop.stopBackgroundTask = async (taskId) => {
		fixture.stoppedTasks.push(taskId);
		return true;
	};
	Object.assign(fixture.snapshot, {
		status: 'idle',
		sessionId: 'bg-ui-session',
		sessionPath: 'C:\\renderer-review\\bg-ui-session.jsonl',
		historyTotal: 2,
		runs: [{ id: 'bg-run-1', status: 'completed', startedAt: now - 30000, finishedAt: now - 15000 }],
		messages: [
			{ id: 'bg-u1', runId: 'bg-run-1', order: 0, role: 'user', text: '请在后台跑一下全量构建和测试', status: 'done' },
			{ id: 'bg-a1', runId: 'bg-run-1', order: 1, role: 'assistant', text: '已在后台启动构建任务，完成后会自动继续处理结果。', status: 'done' },
		],
		activities: [],
		backgroundTasks: [],
	});
	fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
	fixture.emitAgent({ type: 'status', status: 'idle' });
	fixture.emitAgent({
		type: 'background-tasks',
		sessionId: fixture.snapshot.sessionId,
		sessionPath: fixture.snapshot.sessionPath,
		tasks: [
			{
				taskId: 'bg-build01',
				command: 'pnpm --filter @pidesktop/desktop build && pnpm test',
				note: '构建桌面端并运行测试',
				pid: 24680,
				logFile: 'C:\\Users\\review\\.pi\\agent\\sessions\\project\\.pi-desktop-background-tasks\\bg-build01.log',
				startedAt: now - 18000,
				status: 'running',
			},
		],
	});
}

export default async function backgroundTasksScenarios(review) {
	await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-composer-shell"))');
	await review.viewport(1440, 1000);
	await review.reducedMotion(true);
	const theme = await review.evaluate('document.documentElement.dataset.theme === "light" ? "light" : "dark"');

	// 1. Reply finished (idle) with 1 running background task.
	await review.evaluate(`(${seedIdleConversationWithOneRunningTask.toString()})()`);
	await review.waitFor('document.querySelector(".pd-bg-tasks")?.dataset.bgState === "running"');
	await review.evaluate('document.querySelector(".pd-composer-shell > textarea")?.blur()');

	const singleText = await review.evaluate('document.querySelector(".pd-bg-tasks")?.textContent ?? ""');
	assert.ok(singleText.includes('构建桌面端并运行测试'), 'shows task name');
	assert.ok(singleText.includes('运行中'), 'shows running status');
	assert.ok(singleText.includes('完成后自动继续'), 'shows idle auto-resume hint');
	await review.screenshot(`bgtasks-01-single-running-${theme}`);

	// 2. Click strip to expand command/PID/log detail.
	await review.click('.pd-bg-tasks-strip');
	await review.waitFor('Boolean(document.querySelector(".pd-bg-task-detail"))');
	const detailText = await review.evaluate('document.querySelector(".pd-bg-task-detail")?.textContent ?? ""');
	assert.ok(detailText.includes('pnpm --filter @pidesktop/desktop build'));
	assert.ok(detailText.includes('bg-build01'));
	await review.screenshot(`bgtasks-02-single-expanded-${theme}`);
	await review.click('.pd-bg-tasks-strip');

	// 3. Task completes and assistant wakes up (busy): bar updates in place to completed!
	await review.evaluate(`(() => {
		const f = window.__modelReview;
		const now = Date.now();
		f.emitAgent({ type: 'status', status: 'busy' });
		f.emitAgent({
			type: 'background-tasks',
			sessionId: f.snapshot.sessionId,
			sessionPath: f.snapshot.sessionPath,
			tasks: [{
				taskId: 'bg-build01',
				command: 'pnpm --filter @pidesktop/desktop build && pnpm test',
				note: '构建桌面端并运行测试',
				pid: 24680,
				logFile: 'C:\\\\Users\\\\review\\\\.pi\\\\agent\\\\sessions\\\\project\\\\.pi-desktop-background-tasks\\\\bg-build01.log',
				startedAt: now - 25000,
				endedAt: now - 1000,
				exitCode: 0,
				status: 'completed',
				delivered: true,
			}],
		});
	})()`);
	await review.waitFor('document.querySelector(".pd-bg-tasks")?.dataset.bgState === "completed"');
	const doneText = await review.evaluate('document.querySelector(".pd-bg-tasks")?.textContent ?? ""');
	assert.ok(doneText.includes('已完成'), 'updates status to completed');
	assert.ok(await review.evaluate('Boolean(document.querySelector(".pd-bg-tasks-dismiss"))'), 'shows dismiss button when settled');
	await review.screenshot(`bgtasks-03-single-completed-${theme}`);

	// Dismiss settled notice.
	await review.click('.pd-bg-tasks-dismiss');
	await review.waitFor('!document.querySelector(".pd-bg-tasks")');

	// 4. Two concurrent running tasks after reply finishes: expanded by default so both names show.
	await review.evaluate(`(() => {
		const f = window.__modelReview;
		const now = Date.now();
		f.emitAgent({ type: 'status', status: 'idle' });
		f.emitAgent({
			type: 'background-tasks',
			sessionId: f.snapshot.sessionId,
			sessionPath: f.snapshot.sessionPath,
			tasks: [
				{ taskId: 'bg-t1', command: 'pnpm --filter @pidesktop/ui build', note: '构建界面包', pid: 30001, logFile: 'C:\\\\logs\\\\bg-t1.log', startedAt: now - 42000, status: 'running' },
				{ taskId: 'bg-t2', command: 'node scripts/run-tests.mjs tests/background-tasks.test.mjs', pid: 30002, logFile: 'C:\\\\logs\\\\bg-t2.log', startedAt: now - 12000, status: 'running' },
			],
		});
	})()`);
	await review.waitFor('document.querySelectorAll(".pd-bg-task-row").length === 2');
	const multiRunningText = await review.evaluate('document.querySelector(".pd-bg-tasks")?.textContent ?? ""');
	assert.ok(multiRunningText.includes('构建界面包'));
	assert.ok(multiRunningText.includes('node scripts/run-tests.mjs'));
	await review.screenshot(`bgtasks-04-multi-running-${theme}`);

	// Clicking Stop on the first task invokes stopBackgroundTask with its taskId.
	await review.click('.pd-bg-task-row[data-task-id="bg-t1"] .pd-bg-task-stop');
	const stopped = await review.evaluate('window.__modelReview.stoppedTasks');
	assert.deepEqual(stopped, ['bg-t1']);

	// 5. First finishes, second fails with exit code 1 -> updates rows and header tone.
	await review.evaluate(`(() => {
		const f = window.__modelReview;
		const now = Date.now();
		f.emitAgent({
			type: 'background-tasks',
			sessionId: f.snapshot.sessionId,
			sessionPath: f.snapshot.sessionPath,
			tasks: [
				{ taskId: 'bg-t1', command: 'pnpm --filter @pidesktop/ui build', note: '构建界面包', pid: 30001, logFile: 'C:\\\\logs\\\\bg-t1.log', startedAt: now - 45000, endedAt: now - 5000, exitCode: 0, status: 'completed', delivered: true },
				{ taskId: 'bg-t2', command: 'node scripts/run-tests.mjs tests/background-tasks.test.mjs', pid: 30002, logFile: 'C:\\\\logs\\\\bg-t2.log', startedAt: now - 15000, endedAt: now - 1000, exitCode: 1, status: 'failed', delivered: false },
			],
		});
	})()`);
	await review.waitFor('document.querySelector(".pd-bg-tasks")?.dataset.bgState === "failed"');
	const multiSettledText = await review.evaluate('document.querySelector(".pd-bg-tasks")?.textContent ?? ""');
	assert.ok(multiSettledText.includes('已完成'));
	assert.ok(multiSettledText.includes('失败 (退出码 1)'));
	assert.ok(multiSettledText.includes('结果待投递'));
	await review.screenshot(`bgtasks-05-multi-settled-${theme}`);

	// Narrow pane check (680px).
	await review.viewport(680, 900);
	await review.screenshot(`bgtasks-06-narrow-${theme}`);

	// 6. Switch to a session that only has historical completed+delivered tasks -> bar stays hidden.
	await review.evaluate(`(() => {
		const f = window.__modelReview;
		const now = Date.now();
		Object.assign(f.snapshot, { sessionId: 'bg-old-session', sessionPath: 'C:\\\\renderer-review\\\\bg-old-session.jsonl' });
		f.emitAgent({ ...structuredClone(f.snapshot), type: 'ready' });
		f.emitAgent({
			type: 'background-tasks',
			sessionId: 'bg-old-session',
			sessionPath: 'C:\\\\renderer-review\\\\bg-old-session.jsonl',
			tasks: [{ taskId: 'bg-ancient', command: 'echo old', note: '昨天的构建', pid: 99, logFile: 'C:\\\\logs\\\\old.log', startedAt: now - 3600000, endedAt: now - 3500000, exitCode: 0, status: 'completed', delivered: true }],
		});
	})()`);
	await review.waitFor('!document.querySelector(".pd-bg-tasks")');
}
