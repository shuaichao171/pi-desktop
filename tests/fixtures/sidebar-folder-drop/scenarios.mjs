// Built renderer regression coverage with an isolated, in-memory bridge.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-folder-drop/scenarios.mjs
// DragEvent/DataTransfer and directory entries are synthetic. This verifies renderer
// routing and state, not Windows Explorer, Electron File paths, or native drag trust.

function installSidebarFolderDropFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  // Keep the bootstrap path as historical conversations without a project.
  const paths = { home: fixture.snapshot.cwd, Alpha: 'C:\\folder-drop-review\\Alpha', Bravo: 'C:\\folder-drop-review\\Bravo', Added: 'C:\\folder-drop-review\\Added', Mixed: 'C:\\folder-drop-review\\Mixed' };
  const row = (id, cwd, name, extra = {}) => ({ id, path: cwd + '\\' + id + '.jsonl', name, firstMessage: name, modified: '2026-09-27T00:00:00Z', messageCount: 2, ...extra });
  const rows = {
    [paths.home]: [row('home-history', paths.home, '没有项目的已有对话'), row('home-pin', paths.home, '没有项目的置顶对话', { pinned: true })],
    [paths.Alpha]: [row('alpha-history', paths.Alpha, 'Alpha 项目对话')],
    [paths.Bravo]: [row('bravo-history', paths.Bravo, 'Bravo 项目对话')],
  };
  const state = window.__sidebarFolderDropReview = {
    paths, rows, workspaces: [paths.home, paths.Alpha, paths.Bravo], pinned: [paths.Bravo],
    groups: [{ id: 'folder-review-group', name: '自定义分组', sessionPaths: [rows[paths.Alpha][0].path] }],
    navigation: [], drops: [], reads: [], dragEvents: [], attachments: [], newSessions: 0, conversationWorkspaces: [],
  };
  const mock = (name, implementation) => {
    bridge[name] = async (...args) => {
      fixture.calls.push({ name, args: clone(args) });
      return implementation(...args);
    };
  };
  state.publish = (cwd, fresh = false) => {
    const current = state.rows[cwd]?.[0];
    const id = fresh ? 'draft-' + (++state.newSessions) : current.id;
    Object.assign(fixture.snapshot, { cwd, sessionId: id, sessionPath: fresh ? cwd + '\\' + id + '.jsonl' : current.path, messages: [], activities: [], runs: [], historyTotal: 0, status: 'idle', error: null, fileChanges: [], queuedCount: 0, queuedMessages: [] });
    fixture.emitAgent({ type: 'reset', cwd });
    fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
    fixture.emitAgent({ type: 'status', status: 'idle' });
  };
  // The first sent message is what turns an empty new conversation into a sidebar row.
  state.sendFirstMessage = text => {
    fixture.snapshot.messages = [{ id: 'draft-user-' + state.newSessions, order: 0, role: 'user', text, status: 'done' }];
    fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
  };
  mock('getDefaultWorkspace', () => paths.home);
  mock('listConversationWorkspaces', () => [paths.home, ...state.conversationWorkspaces]);
  mock('listWorkspaces', () => { state.reads.push('workspaces'); return clone(state.workspaces); });
  mock('listSessions', cwd => { state.reads.push(cwd); return clone(state.rows[cwd] ?? []); });
  mock('listSessionGroups', () => clone(state.groups));
  mock('listPinnedWorkspaces', () => clone(state.pinned));
  mock('newSession', options => {
    const cwd = options?.cwd ?? paths.home + '\\conversation-' + (state.newSessions + 1);
    if (!options?.cwd) state.conversationWorkspaces.push(cwd);
    if (!state.workspaces.includes(cwd)) state.workspaces.push(cwd);
    state.navigation.push({ kind: 'new-session', cwd, options: clone(options) });
    state.publish(cwd, true);
  });
  mock('switchWorkspace', (cwd, options) => { state.navigation.push({ kind: 'workspace', cwd }); state.publish(cwd, options?.fresh); });
  mock('switchSession', path => { state.navigation.push({ kind: 'session', path }); });
  mock('addDroppedWorkspaces', async files => {
    const names = files.map(file => file.name);
    state.drops.push(names);
    // Resolve after React has committed the drop reset, matching asynchronous IPC.
    await new Promise(resolve => setTimeout(resolve, 80));
    const added = names.filter(name => name === 'Added' || name === 'Mixed').map(name => paths[name]);
    for (const cwd of added) if (!state.workspaces.includes(cwd)) state.workspaces.push(cwd);
    return clone(added);
  });
  mock('getWorkspaceBranches', () => ({ isRepository: false, current: null, detached: false, branches: [] }));
  mock('getWorkspaceGitStatus', () => ({ isRepository: false, branch: null, entries: [], truncated: false }));
  mock('putInputAttachment', (scope, attachment) => {
    const id = 'attachment-' + (state.attachments.length + 1);
    state.attachments.push({ id, scope: clone(scope), attachment: clone(attachment) });
    return { id, version: 1, kind: attachment.kind, name: attachment.name, mimeType: attachment.mimeType, size: attachment.text?.length ?? 0 };
  });
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) document.addEventListener(type, event => {
    state.dragEvents.push({ type, trusted: event.isTrusted, target: event.target instanceof Element ? event.target.className : 'window' });
  }, true);
  // Files have real browser File identities and native DataTransfer membership.
  // Directory entry metadata is explicitly simulated because a renderer fixture
  // cannot obtain OS directory entries or Electron webUtils.getPathForFile paths.
  // Chromium creates new DataTransferItem wrappers on enumeration, so metadata
  // belongs on the isolated browser's prototype rather than a single wrapper.
  const directoryEntries = new Map();
  const nativeEntry = DataTransferItem.prototype.webkitGetAsEntry;
  DataTransferItem.prototype.webkitGetAsEntry = function () {
    const name = this.getAsFile()?.name;
    return directoryEntries.has(name) ? { name, isDirectory: directoryEntries.get(name), isFile: !directoryEntries.get(name) } : nativeEntry.call(this);
  };
  state.transfer = entries => {
    const transfer = new DataTransfer();
    for (const { name, directory = false, type = 'text/plain', text = 'fixture file' } of entries) {
      const file = new File([directory ? '' : text], name, { type: directory ? '' : type });
      directoryEntries.set(name, directory);
      transfer.items.add(file);
    }
    return transfer;
  };
  state.drag = (type, selector, entries, extra = {}) => {
    const target = selector === 'window' ? window : document.querySelector(selector);
    if (!target) throw new Error('Missing drag target: ' + selector);
    const transfer = state.transfer(entries);
    const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, ...extra });
    target.dispatchEvent(event);
    return { prevented: event.defaultPrevented, dropEffect: transfer.dropEffect, entries: Array.from(transfer.items, item => item.webkitGetAsEntry()?.isDirectory) };
  };
  state.publish(paths.home);
}

export default async function sidebarFolderDropScenarios(review) {
  const q = JSON.stringify, state = 'window.__sidebarFolderDropReview', snapshot = 'window.__modelReview.snapshot';
  const unassigned = '.pd-sidebar-group[data-section-key="unassigned"]';
  const overlay = '.pd-project-folder-drop-overlay';
  const composer = '.pd-composer-shell';
  // Rows carry a compact recency label at their end, but never a project subtitle under the title.
  const noMetadata = '!document.querySelector(".pd-session-row .pd-session-copy small, .pd-session-row .pd-session-copy time")';
  const uniqueRows = '(() => { const paths = [...document.querySelectorAll(".pd-session-item[data-session-path]")].map(row => row.dataset.sessionPath); return paths.length === new Set(paths).size; })()';
  const projectOrder = '[...document.querySelectorAll(".pd-sidebar-group[data-project-path]")].map(node => node.dataset.projectPath)';
  const dropped = [{ name: 'Added', directory: true }];
  const mixed = [{ name: 'Mixed', directory: true }, { name: 'must-not-attach.txt', text: 'Mixed drag must be handled as project registration.' }];
  const drag = async (type, selector, entries, extra) => {
    const event = await review.evaluate(`${state}.drag(${q(type)}, ${q(selector)}, ${q(entries)}, ${q(extra ?? {})})`);
    await review.record('synthetic-' + type, `({ event: ${q(event)}, dropCalls: ${state}.drops, projectPaths: ${projectOrder} })`);
  };

  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installSidebarFolderDropFixture.toString()})()`);
  await review.waitFor(`document.querySelectorAll('.pd-session-item[data-session-path]').length === 4`);
  await review.assert(`${noMetadata} && ${uniqueRows}`, 'Conversation rows have no project subtitle and remain unique in custom-group mode');
  await review.assert(`document.querySelector(${q('[data-section-key="group:folder-review-group"]')})?.textContent.includes('Alpha 项目对话') && document.querySelector('[data-section-key=pinned]')?.textContent.includes('没有项目的置顶对话')`, 'Custom grouping and pinned conversations remain available');
  await review.click('[data-mode="project"]');
  await review.waitFor(`Boolean(document.querySelector(${q(unassigned)}))`);
  await review.assert(`JSON.stringify(${projectOrder}) === JSON.stringify([${state}.paths.Bravo, ${state}.paths.Alpha])`, 'Project mode excludes the default workspace and retains the pinned project partition');
  await review.assert(`document.querySelector(${q(unassigned)}).textContent.includes('没有项目的已有对话') && !document.querySelector(${q(unassigned)}).textContent.includes('没有项目的置顶对话') && ${uniqueRows}`, 'Unassigned saved conversations appear once below projects while pinned conversations stay pinned');
  await review.assert(`(() => { const groups = [...document.querySelectorAll('.pd-organized-list > .pd-sidebar-group')]; return groups.at(-1)?.dataset.sectionKey === 'unassigned' && groups[0]?.dataset.sectionKey === 'pinned'; })()`, 'Unassigned is the last section below projects and pinned conversations');
  await review.assert(noMetadata, 'Project-grouped saved conversation rows omit timestamp and project subtitle');

  await review.click('.pd-new-session');
  await review.waitFor(`${state}.newSessions === 1 && ${snapshot}.cwd === ${state}.conversationWorkspaces[0]`);
  await review.assert(`${snapshot}.cwd !== ${state}.paths.home && !${state}.navigation.at(-1).options?.cwd && ${projectOrder}.length === 2`, 'Global New conversation creates a separate directory without adding an explicit project');
  await review.assert('!document.querySelector(".pd-session-item.is-unsaved")', 'An empty new conversation stays out of the sidebar until its first message');
  await review.evaluate(`${state}.sendFirstMessage('没有项目的新对话')`);
  await review.waitFor(`Boolean(document.querySelector(${q(unassigned + ' .pd-session-item.is-unsaved .pd-session-row[aria-current="page"]')}))`);
  await review.assert(`document.querySelector(${q(unassigned + ' .pd-session-row[aria-current="page"] strong')}).textContent === '没有项目的新对话' && ${noMetadata}`, 'A new conversation without a project appears under Unassigned, titled by its first message, with no secondary metadata');
  await review.fill(composer + ' > textarea', '添加项目时保留当前对话和这段草稿。');
  await review.screenshot('sidebar-unassigned-and-compact-conversation-rows');
  await review.evaluate(`${state}.beforeDrop = { cwd: ${snapshot}.cwd, sessionId: ${snapshot}.sessionId, sessionPath: ${snapshot}.sessionPath, navigation: ${state}.navigation.length, text: document.querySelector(${q(composer + ' > textarea')}).value, reads: ${state}.reads.length }`);

  await drag('dragenter', '.pd-sidebar', dropped);
  await review.waitFor(`Boolean(document.querySelector(${q(overlay)}))`);
  await review.assert('!document.querySelector(".pd-composer-attachment")', 'Dragging a directory displays the global project overlay without attaching anything');
  await review.screenshot('folder-drop-global-project-overlay');
  await drag('dragleave', '.pd-sidebar', dropped, { relatedTarget: null });
  await review.waitFor(`!document.querySelector(${q(overlay)})`);
  await review.assert(`${state}.drops.length === 0`, 'Leaving the application dismisses the overlay without registering a project');

  await review.click('[data-mode="grouped"]');
  await drag('dragenter', '.pd-sidebar', dropped);
  await review.waitFor(`Boolean(document.querySelector(${q(overlay)}))`);
  await drag('dragover', composer, dropped);
  await drag('drop', composer, dropped);
  await review.waitFor(`${state}.drops.length === 1 && ${projectOrder}.includes(${state}.paths.Added) && !document.querySelector(${q(overlay)})`);
  await review.assert('document.querySelector("[data-mode=project]").getAttribute("aria-selected") === "true"', 'An asynchronously registered folder reveals project mode after dropping from custom-group mode');
  await review.assert(`${state}.drops[0].length === 1 && ${state}.drops[0][0] === 'Added' && ${state}.reads.length > ${state}.beforeDrop.reads`, 'Dropping a directory registers it once and refreshes the sidebar project list');
  const preserved = `${snapshot}.cwd === ${state}.beforeDrop.cwd && ${snapshot}.sessionId === ${state}.beforeDrop.sessionId && ${snapshot}.sessionPath === ${state}.beforeDrop.sessionPath && ${state}.navigation.length === ${state}.beforeDrop.navigation && document.querySelector(${q(composer + ' > textarea')}).value === ${state}.beforeDrop.text`;
  await review.assert(preserved, 'Adding a dropped project preserves the current conversation, workspace, and typed draft');

  await drag('dragenter', composer, mixed);
  await review.waitFor(`Boolean(document.querySelector(${q(overlay)}))`);
  await drag('drop', composer, mixed);
  await review.waitFor(`${state}.drops.length === 2 && ${projectOrder}.includes(${state}.paths.Mixed) && !document.querySelector(${q(overlay)})`);
  await review.assert(`${state}.drops[1].length === 1 && ${state}.drops[1][0] === 'Mixed' && !document.querySelector('.pd-composer-attachment')`, 'Mixed file/directory drops register only the directory and never become composer attachments');
  await review.assert(preserved, 'Mixed directory registration also preserves the current conversation and draft');

  const file = [{ name: 'normal-attachment.txt', text: 'Ordinary files remain composer attachments.' }];
  await drag('dragenter', composer, file);
  await drag('dragover', composer, file);
  await review.assert(`!document.querySelector(${q(overlay)})`, 'Dragging a normal text file keeps the project overlay hidden');
  await drag('drop', composer, file);
  await review.waitFor(`document.querySelector('.pd-composer-attachment-name')?.textContent.includes('normal-attachment.txt') && ${state}.attachments.length === 1`);
  await review.assert(`${state}.drops.length === 2 && document.querySelectorAll('.pd-composer-attachment').length === 1 && ${preserved}`, 'A file-only drop remains one attachment and does not register a project or navigate');
  await review.assert(`${state}.attachments[0].attachment.text === 'Ordinary files remain composer attachments.'`, 'The ordinary dropped file is read and persisted with its original text');
  await review.assert(`${noMetadata} && ${uniqueRows} && ${projectOrder}.length === 4 && document.querySelector(${q(unassigned)}).textContent.includes('没有项目的已有对话')`, 'Added projects retain compact rows, unique sessions, and the Unassigned section');
  await review.screenshot('folder-drop-added-projects-and-normal-attachment');
  await review.viewport(900, 1000);
  await review.assert('document.documentElement.scrollWidth <= innerWidth', 'The updated sidebar and composer have no horizontal page overflow at 900 pixels');
  await review.screenshot('sidebar-folder-drop-compact-viewport');
  await review.record('folder-drop-validation-boundary', `({ directoryDragEventsAreSynthetic: true, nativeExplorerAndElectronPathsTested: false, dragEvents: ${state}.dragEvents, dropCalls: ${state}.drops, projectPaths: ${projectOrder} })`);
}
