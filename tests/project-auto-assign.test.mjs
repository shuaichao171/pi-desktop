// 识别项目目录：未归属的空对话，第一条消息里写了目录时，在输入框上方弹出横幅；
// 选择「转移」后等本轮回复结束，把对话复制到该项目、切换过去并删除临时会话。设置中默认开启，可关闭。
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { detectMessageProject, normalizeProjectAutoAssign, projectPathCandidates, setProjectAutoAssignEnabled } from '../packages/ui/src/projectAutoAssign.ts';
import { useChatStore } from '../packages/ui/src/store.ts';
import { sessionOpenMetrics } from '../packages/ui/src/sessionOpenMetrics.ts';

const projects = ['E:\\ai-work2\\pi_desttop', 'E:\\ai-work2\\other', 'D:\\code\\app', 'D:\\code\\app\\packages\\web', '/home/me/site'];

test('preference is on by default and only an explicit false turns it off', () => {
	assert.equal(normalizeProjectAutoAssign(null), true);
	assert.equal(normalizeProjectAutoAssign(undefined), true);
	assert.equal(normalizeProjectAutoAssign('nope'), true);
	assert.equal(normalizeProjectAutoAssign(false), false);
});

test('a leading project path is recognized regardless of separators and case', () => {
	assert.equal(detectMessageProject('E:\\ai-work2\\pi_desttop 审查项目', projects), 'E:\\ai-work2\\pi_desttop');
	assert.equal(detectMessageProject('e:/AI-WORK2/pi_desttop/ 审查项目', projects), 'E:\\ai-work2\\pi_desttop');
	assert.equal(detectMessageProject('E:\\\\ai-work2\\\\pi_desttop', projects), 'E:\\ai-work2\\pi_desttop');
	assert.equal(detectMessageProject('E:\\ai-work2\\pi_desttop审查项目', projects), 'E:\\ai-work2\\pi_desttop');
});

test('paths inside a project, quoted paths and mid-sentence paths resolve to the deepest project', () => {
	assert.equal(detectMessageProject('请看 "D:\\code\\app\\src\\main.ts" 的报错', projects), 'D:\\code\\app');
	assert.equal(detectMessageProject('修改 D:\\code\\app\\packages\\web\\index.html。', projects), 'D:\\code\\app\\packages\\web');
	assert.equal(detectMessageProject('review /home/me/site/src please', projects), '/home/me/site');
});

test('similar names, roots, unknown paths and POSIX case differences do not match', () => {
	assert.equal(detectMessageProject('E:\\ai-work2\\pi_desttop2 审查', projects), null);
	assert.equal(detectMessageProject('E:\\ai-work2\\pi_desttop.v2 审查', projects), null);
	assert.equal(detectMessageProject('F:\\elsewhere 审查', projects), null);
	assert.equal(detectMessageProject('review /home/me/SITE', projects), null);
	assert.equal(detectMessageProject('审查一下这个项目', projects), null);
	assert.equal(detectMessageProject('C:\\ anything', ['C:\\', '/']), null);
	assert.equal(detectMessageProject('xE:\\ai-work2\\pi_desttop', projects), null);
});

test('several different projects only resolve when the message opens with one', () => {
	assert.equal(detectMessageProject('比较 E:\\ai-work2\\pi_desttop 和 E:\\ai-work2\\other', projects), null);
	assert.equal(detectMessageProject('E:\\ai-work2\\other 参考 E:\\ai-work2\\pi_desttop 的实现', projects), 'E:\\ai-work2\\other');
	assert.equal(detectMessageProject('E:\\ai-work2\\other\\a 与 E:\\ai-work2\\other\\b', projects), 'E:\\ai-work2\\other');
});

test('path candidates cover quoted paths, paths glued to Chinese text and UNC shares', () => {
	assert.deepEqual(projectPathCandidates('E:\\ai-work2\\pi_desttop 审查项目'), ['E:\\ai-work2\\pi_desttop']);
	assert.deepEqual(projectPathCandidates('E:\\ai-work2\\pi_desttop审查项目'), ['E:\\ai-work2\\pi_desttop审查项目', 'E:\\ai-work2\\pi_desttop']);
	assert.equal(projectPathCandidates('请看 "C:\\Program Files\\App\\x.txt" 报错')[0], 'C:\\Program Files\\App\\x.txt');
	assert.deepEqual(projectPathCandidates('review /home/me/site/src please.'), ['/home/me/site/src']);
	assert.deepEqual(projectPathCandidates('https://a.com/x and/or E:/x/y。'), ['E:/x/y']);
	assert.deepEqual(projectPathCandidates('\\\\server\\share\\dir 看看'), ['\\\\server\\share\\dir']);
	assert.deepEqual(projectPathCandidates('随便聊聊'), []);
});

// ---- store integration ----

const project = 'C:/projects/source';
const temporary = 'C:/conversations/temp';
const source = `${temporary}/current.jsonl`;
const tick = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ cwd = temporary, messages = [], resolved = null, moveError = null } = {}) {
	const calls = [], prompts = [];
	const bridge = {
		listWorkspaces: async () => [project, temporary],
		listConversationWorkspaces: async () => [temporary],
		getDefaultWorkspace: async () => temporary,
		listSessions: async () => [],
		listSessionsPage: async () => ({ sessions: [], total: 0, hasMore: false, revision: 1 }),
		prompt: async text => { prompts.push(text); },
		resolveProjectDirectory: async candidates => { calls.push(['resolve', candidates]); return resolved; },
		moveSessionToWorkspace: async (path, target) => {
			calls.push(['move', path, target]);
			if (moveError) throw new Error(moveError);
			return { path: `${target}/current.jsonl`, cwd: target };
		},
		switchWorkspace: async target => { calls.push(['switchWorkspace', target]); },
		switchSession: async path => {
			calls.push(['switchSession', path]);
			const target = path.slice(0, path.lastIndexOf('/'));
			useChatStore.getState().handleEvent({ type: 'ready', cwd: target, sessionId: 'moved', sessionPath: path, model: 'model', modelProvider: 'provider',
				thinkingLevel: 'off', availableThinkingLevels: ['off'], contextUsage: null, messages: [], activities: [], fileChanges: [] });
		},
		deleteSession: async path => { calls.push(['delete', path]); },
	};
	useChatStore.setState({ bridge, cwd, sessionId: 'current', sessionPath: `${cwd}/current.jsonl`, status: 'idle',
		workspaces: [project, temporary], conversationWorkspaces: [temporary], defaultWorkspace: temporary, messages });
	return { bridge, calls, prompts };
}

beforeEach(() => {
	sessionOpenMetrics.cancel();
	useChatStore.setState(useChatStore.getInitialState(), true);
	setProjectAutoAssignEnabled(true);
});

test('a message naming an opened project is sent where it is and offers a move', async () => {
	const host = fixture();
	await useChatStore.getState().send('C:\\projects\\source 审查项目');
	assert.deepEqual(host.prompts, ['C:\\projects\\source 审查项目'], 'the message is sent unchanged in the temporary conversation');
	await tick();
	assert.equal(useChatStore.getState().cwd, temporary);
	assert.deepEqual(useChatStore.getState().projectOffer, { sessionId: 'current', directory: project, registered: true, state: 'offered' });
	assert.equal(host.calls.length, 0, 'opened projects match without asking the main process');
});

test('an accepted offer waits for the reply to finish, then moves, opens the copy and deletes the source', async () => {
	const host = fixture();
	await useChatStore.getState().send(`${project} 审查项目`);
	await tick();
	useChatStore.getState().handleEvent({ type: 'status', status: 'busy' });
	useChatStore.getState().acceptProjectOffer();
	await tick();
	assert.equal(useChatStore.getState().projectOffer.state, 'waiting');
	assert.equal(host.calls.length, 0, 'nothing moves while the reply is still running');
	useChatStore.getState().handleEvent({ type: 'status', status: 'idle' });
	await tick();
	assert.deepEqual(host.calls.map(call => call[0]), ['move', 'switchWorkspace', 'switchSession', 'delete']);
	assert.deepEqual(host.calls[0], ['move', source, project]);
	assert.deepEqual(host.calls.at(-1), ['delete', source]);
	assert.equal(useChatStore.getState().cwd, project);
	assert.equal(useChatStore.getState().sessionPath, `${project}/current.jsonl`);
	assert.equal(useChatStore.getState().projectOffer, null);
});

test('a folder that is not a project yet is checked on disk and offered as a new project', async () => {
	const host = fixture({ resolved: 'D:\\new\\app' });
	await useChatStore.getState().send('D:\\new\\app 审查项目');
	await tick();
	assert.deepEqual(host.calls[0], ['resolve', ['D:\\new\\app']]);
	assert.deepEqual(useChatStore.getState().projectOffer, { sessionId: 'current', directory: 'D:\\new\\app', registered: false, state: 'offered' });
	useChatStore.getState().acceptProjectOffer();
	await tick();
	assert.deepEqual(host.calls[1], ['move', source, 'D:\\new\\app']);
	assert.equal(useChatStore.getState().projectOffer, null);
});

test('a failed move stays on the bar with its reason and can be retried or dismissed', async () => {
	const host = fixture({ moveError: '会话文件不存在' });
	await useChatStore.getState().send(`${project} 看看`);
	await tick();
	useChatStore.getState().acceptProjectOffer();
	await tick();
	assert.equal(useChatStore.getState().projectOffer.state, 'failed');
	assert.equal(useChatStore.getState().projectOffer.error, '会话文件不存在');
	assert.equal(useChatStore.getState().cwd, temporary);
	useChatStore.getState().acceptProjectOffer();
	await tick();
	assert.equal(host.calls.filter(call => call[0] === 'move').length, 2, 'retry tries again');
	useChatStore.getState().dismissProjectOffer();
	assert.equal(useChatStore.getState().projectOffer, null);
});

test('no offer when the setting is off, the message has no folder, or the conversation is not new and unassigned', async () => {
	let host = fixture({ resolved: 'D:\\new\\app' });
	setProjectAutoAssignEnabled(false);
	await useChatStore.getState().send(`${project} 审查项目`);
	await tick();
	assert.equal(useChatStore.getState().projectOffer, null);
	assert.equal(host.calls.length, 0);
	setProjectAutoAssignEnabled(true);

	fixture();
	await useChatStore.getState().send('随便聊聊');
	await tick();
	assert.equal(useChatStore.getState().projectOffer, null);

	fixture({ cwd: 'C:/projects/other' });
	useChatStore.setState({ workspaces: [project, 'C:/projects/other', temporary] });
	await useChatStore.getState().send(`${project} 审查项目`);
	await tick();
	assert.equal(useChatStore.getState().projectOffer, null);

	host = fixture({ messages: [{ id: 'old', order: 0, role: 'user', text: 'earlier', status: 'done' }] });
	await useChatStore.getState().send(`${project} 审查项目`);
	await tick();
	assert.equal(useChatStore.getState().projectOffer, null);
	assert.equal(host.prompts.length, 1);
});
