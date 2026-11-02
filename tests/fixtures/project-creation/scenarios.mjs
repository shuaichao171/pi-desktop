// Prepare without a browser: node tests/fixtures/project-creation/scenarios.mjs --check
// Run after building: node tests/fixtures/model-settings/run.mjs --run --scenario=../project-creation/scenarios.mjs
// All project creation, folder choices, and registration stay in memory.

function installProjectCreationFixture(options = {}) {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const state = window.__projectCreationReview = {
    directory: 'C:\\Users\\review\\Documents\\Pi Desktop',
    home: 'C:\\renderer-review\\home',
    existing: 'D:\\工作资料\\现有项目',
    longExisting: 'D:\\工作资料\\客户项目与设计文件\\用于检查窄屏布局的较长中文文件夹名称',
    workspaces: [], creates: [], registered: [], navigation: [], picks: [],
    nextPick: null, failNextCreate: null, deferCreate: false, pendingCreate: null,
    nameInputs: [], directoryReads: 0,
  };
  const mock = (name, implementation) => {
    bridge[name] = async (...args) => {
      fixture.calls.push({ name, args: clone(args) });
      return implementation(...args);
    };
  };
  const publish = cwd => {
    Object.assign(fixture.snapshot, {
      cwd, sessionId: 'project-creation-session-' + state.navigation.length,
      sessionPath: cwd + '\\review.jsonl', status: 'idle', messages: [], activities: [],
      runs: [], historyTotal: 0, error: null, queuedCount: 0, queuedMessages: [], fileChanges: [],
    });
    fixture.emitAgent({ type: 'reset', cwd });
    fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
    fixture.emitAgent({ type: 'status', status: 'idle' });
  };
  mock('getDefaultWorkspace', () => state.home);
  mock('listWorkspaces', () => [state.home, ...state.workspaces]);
  mock('listSessions', () => []);
  mock('listPinnedWorkspaces', () => []);
  mock('listSessionGroups', () => []);
  mock('getProjectsDirectory', () => { state.directoryReads++; return state.directory; });
  mock('pickWorkspace', () => {
    const selected = state.nextPick;
    state.picks.push(selected);
    state.nextPick = null;
    return selected;
  });
  mock('createProject', async name => {
    state.creates.push(name);
    if (state.failNextCreate) {
      const error = state.failNextCreate;
      state.failNextCreate = null;
      throw new Error(error);
    }
    if (state.deferCreate) {
      state.deferCreate = false;
      await new Promise((resolve, reject) => { state.pendingCreate = { resolve, reject }; });
      state.pendingCreate = null;
    }
    const cwd = state.directory + '\\' + name;
    state.registered.push(cwd);
    if (!state.workspaces.includes(cwd)) state.workspaces.push(cwd);
    return cwd;
  });
  mock('switchWorkspace', (cwd, options) => {
    state.navigation.push({ cwd, options: clone(options) });
    if (cwd !== state.home && !state.workspaces.includes(cwd)) state.workspaces.push(cwd);
    publish(cwd);
  });
  mock('getWorkspaceBranches', () => ({ isRepository: false, current: null, detached: false, branches: [] }));
  mock('getWorkspaceGitStatus', () => ({ isRepository: false, branch: null, entries: [], truncated: false }));
  document.addEventListener('input', event => {
    if (event.target instanceof HTMLInputElement && event.target.name === 'projectName') {
      state.nameInputs.push({ value: event.target.value, trusted: event.isTrusted });
    }
  }, true);
  localStorage.setItem('pi-desktop.locale', 'zh-CN');
  localStorage.setItem('pi-desktop.theme', options.theme ?? 'dark');
  publish(state.home);
}

export default async function projectCreationScenarios(review) {
  const q = JSON.stringify;
  const state = 'window.__projectCreationReview';
  const dialog = '.pd-project-create-dialog';
  const name = dialog + ' input[name="projectName"]';
  const source = dialog + ' select[name="projectSource"]';
  const choose = dialog + ' button[data-action="choose-folder"]';
  const submit = dialog + ' button[type="submit"]';
  const cancel = dialog + ' button[data-action="cancel"]';
  const field = selector => `document.querySelector(${q(selector)})`;
  const noWrites = `${state}.creates.length === 0 && ${state}.registered.length === 0 && ${state}.navigation.length === 0`;
  const closed = `!${field(dialog)}`;

  async function open() {
    await review.click('[aria-label="新建项目"]');
    await review.waitFor(`Boolean(${field(dialog)}) && Boolean(${field(name)}) && Boolean(${field(source)})`);
  }
  async function install(theme = 'dark') {
    await review.reloadWithFixture(`(${installProjectCreationFixture.toString()})(${q({ theme })});`);
    await review.waitFor(`Boolean(document.querySelector('[aria-label="新建项目"]'))`);
  }
  async function layout(label) {
    await review.assert(`(() => {
      const dialog = ${field(dialog)};
      if (!dialog) return false;
      const box = dialog.getBoundingClientRect();
      if (box.width < 280 || box.height < 200 || box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) return false;
      if (dialog.scrollWidth > dialog.clientWidth + 1) return false;
      return [...dialog.querySelectorAll('input, select, button')].filter(node => node.getClientRects().length).every(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 20 && rect.height >= 24 && rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
      });
    })()`, label);
    await review.record(label + '-bounds', `(() => {
      const rect = ${field(dialog)}.getBoundingClientRect();
      return { viewport: { width: innerWidth, height: innerHeight }, dialog: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, theme: document.documentElement.dataset.theme };
    })()`);
  }

  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-activity-bar"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await install();
  await open();
  await review.waitFor(`${state}.directoryReads > 0 && ${field(dialog)}.textContent.includes(${state}.directory)`);
  await review.assert(`${field(source)}.value === 'create' && ${field(submit)}.disabled && ${state}.picks.length === 0 && ${noWrites}`, 'New project opens the in-app dialog in create mode without opening a native picker or writing a project');
  await review.fill(name, '取消的中文项目');
  await review.click(cancel);
  await review.assert(`${closed} && ${noWrites}`, 'Cancelling a named project closes the dialog without creation, registration, or navigation');

  await open();
  await review.fill(source, 'existing');
  await review.assert(`${field(submit)}.disabled && ${state}.picks.length === 0`, 'Existing-folder mode requires a chosen folder and does not automatically launch the native picker');
  await review.evaluate(`${state}.nextPick = ${state}.existing`);
  await review.click(choose);
  await review.waitFor(`${field(name)}.value === '现有项目' && ${field(submit)}.disabled === false`);
  await review.assert(`${field(name)}.readOnly && ${field(submit)}.textContent.includes('添加项目') && ${field(dialog)}.textContent.includes(${state}.existing) && ${noWrites}`, 'Choosing an existing folder previews its path and read-only folder name without registering it');
  await review.click(choose);
  await review.waitFor(`${state}.picks.length === 2`);
  await review.assert(`${state}.picks[1] === null && ${field(name)}.value === '现有项目' && ${field(dialog)}.textContent.includes(${state}.existing) && !${field(submit)}.disabled && ${noWrites}`, 'Cancelling a second native folder choice preserves the previously selected folder and remains ready to add');
  await review.click(cancel);
  await review.assert(`${closed} && ${noWrites}`, 'Cancelling after folder selection still makes no project changes');

  await open();
  await review.fill(name, '中文研究项目');
  await layout('Desktop dark create dialog fits its viewport and contains every control');
  await review.screenshot('project-creation-dark-chinese');
  await review.evaluate(`${state}.failNextCreate = '同名文件夹已存在，请换一个项目名称。'`);
  await review.click(submit);
  await review.waitFor(`${field(dialog)}?.textContent.includes('同名文件夹已存在') && ${field(submit)}?.disabled === false`);
  await review.assert(`${field(name)}.value === '中文研究项目' && ${state}.creates.length === 1 && ${state}.registered.length === 0 && ${state}.navigation.length === 0`, 'A creation failure keeps the entered name and dialog open for correction without navigation');
  await review.fill(name, '中文研究项目（二）');
  await review.evaluate(`${state}.deferCreate = true`);
  await review.click(submit);
  await review.waitFor(`Boolean(${state}.pendingCreate) && ${field(submit)}?.disabled === true`);
  await review.key('Enter');
  await review.key('Enter');
  await review.assert(`${state}.creates.length === 2 && ${state}.registered.length === 0 && ${state}.navigation.length === 0 && Boolean(${field(dialog)})`, 'Repeated Enter while creation is pending cannot create or navigate a second time');
  await review.evaluate(`${state}.pendingCreate.resolve()`);
  await review.waitFor(`${closed} && ${state}.navigation.length === 1`);
  await review.assert(`${state}.creates.length === 2 && ${state}.registered.length === 1 && ${state}.registered[0] === ${state}.directory + '\\\\中文研究项目（二）' && ${state}.navigation[0].cwd === ${state}.registered[0] && window.__modelReview.snapshot.cwd === ${state}.registered[0]`, 'Successful creation registers one folder in the app documents directory and navigates there exactly once');
  await review.assert(`${state}.nameInputs.length >= 3 && ${state}.nameInputs.every(event => event.trusted)`, 'All project-name edits came from trusted keyboard input');
  await review.record('project-creation-and-navigation', `({ creates: ${state}.creates, registered: ${state}.registered, navigation: ${state}.navigation, picks: ${state}.picks })`);

  await install('light');
  await open();
  await review.fill(source, 'existing');
  await review.evaluate(`${state}.nextPick = ${state}.existing`);
  await review.click(choose);
  await review.waitFor(`${field(name)}.value === '现有项目' && ${field(submit)}.disabled === false`);
  await review.assert(`document.documentElement.dataset.theme === 'light'`, 'The project dialog uses the application light theme');
  await layout('Desktop light existing-folder dialog fits its viewport and contains every control');
  await review.screenshot('project-creation-light-existing-folder');
  await review.click(submit);
  await review.waitFor(`${closed} && ${state}.navigation.length === 1`);
  await review.assert(`${state}.creates.length === 0 && ${state}.registered.length === 0 && ${state}.navigation[0].cwd === ${state}.existing && ${state}.workspaces.includes(${state}.existing) && window.__modelReview.snapshot.cwd === ${state}.existing`, 'Adding an existing folder performs one workspace switch without creating another folder');

  await install('dark');
  await open();
  await review.fill(source, 'existing');
  await review.evaluate(`${state}.nextPick = ${state}.longExisting`);
  await review.click(choose);
  await review.waitFor(`${field(submit)}.disabled === false`);
  await review.viewport(420, 760);
  await layout('Narrow dark dialog keeps its long Chinese folder path and controls inside the viewport');
  await review.screenshot('project-creation-narrow-long-chinese-path');
  await review.click(cancel);
  await review.assert(`${closed} && ${noWrites}`, 'Cancelling from the narrow dialog also leaves project state unchanged');
}

if (process.argv.includes('--check')) {
  let count = 0;
  const compile = expression => { new Function(expression); count++; };
  await projectCreationScenarios({
    evaluate: async expression => compile(expression), waitFor: async expression => compile(expression),
    assert: async expression => compile(expression), record: async (_name, expression) => compile(expression),
    reloadWithFixture: async expression => compile(expression),
    click: async () => {}, fill: async () => {}, key: async () => {}, settle: async () => {},
    screenshot: async () => {}, viewport: async () => {}, reducedMotion: async () => {},
  });
  console.log(`Prepared ${count} project-creation expressions including injected fixtures; no browser launched.`);
}
