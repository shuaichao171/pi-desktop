// Build first, then run only a dedicated headless renderer:
// node tests/fixtures/model-settings/run.mjs --run --scenario=../chat-header/scenarios.mjs
function installChatHeaderFixture() {
  const f = window.__modelReview, cwd = f.snapshot.cwd;
  const conversation = { ...structuredClone(f.snapshot), sequence: 10, sessionId: 'header-review', sessionPath: cwd + '/header.jsonl', status: 'idle',
    messages: [
      { id: 'header-user', order: 0, role: 'user', text: '请帮我整理今天的开发计划。', status: 'done' },
      { id: 'header-answer', order: 1, role: 'assistant', text: '### 今天的开发计划\n\n1. 检查近期改动与会话切换体验。\n2. 完成界面调整，保持清晰的阅读层级。\n3. 运行测试并核对截图。\n\n顶部保留会话标题、历史导航和工作台入口，正文区域可以完整显示。', status: 'done' },
    ], activities: [], runs: [], historyTotal: 2 };
  Object.assign(f.snapshot, conversation);
  const state = window.__headerReview = { conversation, diagnostics: [], terminalWrites: [], creations: [] };
  const oldPane = { kind: 'pane', id: 'old-primary', session: { cwd, sessionId: conversation.sessionId, sessionPath: conversation.sessionPath, title: '旧分屏布局' } };
  sessionStorage.setItem('pi-desktop.conversation-panes.v1', JSON.stringify({ tree: { kind: 'split', id: 'old-split', direction: 'horizontal', ratio: 50, first: oldPane, second: { kind: 'pane', id: 'old-secondary', session: null } }, active: oldPane.id }));
  const mock = (name, fn) => window.piDesktop[name] = async (...args) => { f.calls.push({ name, args: structuredClone(args) }); return fn(...args); };
  mock('listSessions', path => path === cwd ? [{ path: conversation.sessionPath, id: conversation.sessionId, name: '开发计划与界面检查', firstMessage: conversation.messages[0].text, modified: '2026-09-28T00:00:00Z', messageCount: 2 }] : []);
  mock('listWorkspaces', () => [cwd, ...state.creations.map(item => item.cwd)]);
  mock('listConversationWorkspaces', () => state.creations.map(item => item.cwd));
  mock('newSession', () => {
    const fresh = { ...structuredClone(conversation), cwd: 'C:/renderer-review/new-conversation', sessionId: 'new-header-review', sessionPath: null, messages: [], activities: [], runs: [], historyTotal: 0, queuedMessages: [], queuedCount: 0 };
    state.creations.push(fresh);
    Object.assign(f.snapshot, fresh);
    f.emitAgent({ type: 'reset', cwd: fresh.cwd });
    f.emitAgent({ ...fresh, type: 'ready' });
    f.emitAgent({ type: 'status', status: 'idle' });
  });
  mock('recordUiDiagnostic', event => state.diagnostics.push(event));
  mock('listWorkspaceEntries', () => []);
  mock('getWorkspaceTerminal', cwd => ({ id: 'fixture-terminal', cwd, shell: 'Renderer fixture', running: true, output: 'Renderer fixture terminal', sequence: 1, truncated: false }));
  mock('writeWorkspaceTerminal', request => state.terminalWrites.push(request));
  mock('resizeWorkspaceTerminal', () => undefined);
  mock('acknowledgeWorkspaceTerminal', () => undefined);
  window.piDesktop.onWorkspaceTerminalEvent = () => () => {};
}

export default async function chatHeaderScenarios(review) {
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installChatHeaderFixture.toString()})()`);
  await review.viewport(1440,1000);
  await review.waitFor('document.querySelector(".pd-turn-answer")?.textContent.includes("今天的开发计划") && Boolean(document.querySelector(".pd-window-controls"))');
  const headerAligned = `(() => { const h=document.querySelector('.pd-top-bar').getBoundingClientRect(); const w=document.querySelector('.pd-window-controls').getBoundingClientRect(); const t=document.querySelector('.pd-top-bar-workspace-button').getBoundingClientRect(); const border=parseFloat(getComputedStyle(document.querySelector('.pd-app-shell')).borderTopWidth); return Math.abs(h.y-border)<0.5 && Math.abs(h.height-48)<1 && Math.abs(w.y+w.height/2-(h.y+h.height/2))<2 && Math.abs(t.y+t.height/2-(h.y+h.height/2))<2; })()`;
  await review.assert(`!document.querySelector('.pd-pane-toolbar,.pd-conversation-panes,.pd-conversation-pane,.pd-pane-divider') && document.querySelectorAll('.pd-top-bar').length===1`, 'Saved split layouts are ignored and only the window top bar is rendered');
  await review.record('header-geometry', `['.pd-top-bar','.pd-window-controls','.pd-top-bar-workspace-button'].map(selector => { const e=document.querySelector(selector); const r=e.getBoundingClientRect(); const s=getComputedStyle(e); return {selector,y:r.y,height:r.height,display:s.display,flexBasis:s.flexBasis}; })`);
  await review.assert(headerAligned, 'The 48px top bar starts at the top and aligns with the window controls and workbench button');
  await review.assert(`Math.abs(document.querySelector('.pd-main').getBoundingClientRect().width-document.querySelector('.pd-chat-view-host').getBoundingClientRect().width)<1`, 'The conversation fills the available main area');
  await review.record('font-rendering', `(() => { const s=getComputedStyle(document.querySelector('.pd-turn-answer .pd-markdown'));return {family:s.fontFamily,weight:s.fontWeight,size:s.fontSize,color:s.color}; })()`);
  await review.screenshot('chat-header-conversation');
  await review.click('.pd-activity-new-session');
  await review.waitFor(`window.__headerReview.creations.length===1 && Boolean(document.querySelector('.pd-main.is-empty')) && document.querySelector('.pd-composer-shell textarea')?.disabled===false`);
  await review.assert(headerAligned, 'An empty new conversation retains the same top header alignment');
  await review.assert(`!document.querySelector('.pd-pane-toolbar') && document.querySelector('.pd-composer-shell textarea').value==='' && !document.querySelector('.pd-turn-answer')`, 'New conversations stay blank and editable without split controls');
  await review.screenshot('chat-header-new-conversation');
  await review.key('`',{ctrl:true});
  await review.waitFor('document.querySelector(".pd-workbench.is-open [data-segment-key=terminal]")?.getAttribute("aria-current")==="page"');
  await review.evaluate('document.querySelector(".pd-workbench .xterm-helper-textarea").focus()');
  await review.assert('document.activeElement?.classList.contains("xterm-helper-textarea")','The terminal owns keyboard focus before toggling it closed');
  await review.key('`',{ctrl:true});
  await review.waitFor('!document.querySelector(".pd-workbench.is-open")');
  await review.assert('window.__headerReview.terminalWrites.length===0','The terminal shortcut is consumed before xterm can send it to the shell');
  await review.evaluate('document.querySelector(".pd-settings-entry").focus()');
  await review.key('`',{ctrl:true});
  await review.waitFor('Boolean(document.querySelector(".pd-workbench.is-open"))');
  await review.click('.pd-workbench [data-segment-key="files"]');
  await review.key('`',{ctrl:true});
  await review.waitFor('document.querySelector(".pd-workbench [data-segment-key=terminal]")?.getAttribute("aria-current")==="page"');
  await review.assert('document.querySelector(".pd-terminal-pane").hidden===false','The shortcut switches a focused workbench from Files to Terminal');
  await review.key('`',{ctrl:true});
  await review.waitFor('!document.querySelector(".pd-workbench.is-open")');
  await review.click('.pd-settings-entry');
  await review.waitFor('Boolean(document.querySelector(".pd-settings-dialog"))');
  await review.key('`',{ctrl:true});
  await review.assert('!document.querySelector(".pd-workbench.is-open") && Boolean(document.querySelector(".pd-settings-dialog"))','Settings remains modal and blocks the terminal shortcut');
  await review.key('Escape');
  await review.waitFor('!document.querySelector(".pd-settings-dialog")');
  await review.evaluate(`(() => { const d=document.createElement('dialog'); d.id='shortcut-approval-modal'; d.setAttribute('role','alertdialog'); d.setAttribute('aria-modal','true'); d.innerHTML='<button>Approval fixture</button>'; document.body.append(d); d.showModal(); })()`);
  await review.key('`',{ctrl:true});
  await review.assert('document.querySelector("#shortcut-approval-modal").open && !document.querySelector(".pd-workbench.is-open")','A modal approval blocks the terminal shortcut');
  await review.evaluate('document.querySelector("#shortcut-approval-modal").close(); document.querySelector("#shortcut-approval-modal").remove()');
  await review.viewport(900,900);
  await review.key('`',{ctrl:true});
  await review.waitFor('document.querySelector(".pd-workbench.is-open")?.getAttribute("aria-modal")==="true"');
  await review.evaluate('document.querySelector(".pd-workbench .xterm-helper-textarea").focus()');
  await review.key('`',{ctrl:true});
  await review.waitFor('!document.querySelector(".pd-workbench.is-open")');
  await review.assert('window.__headerReview.terminalWrites.length===0','The shortcut also closes the focused terminal in narrow modal mode without writing shell input');
  await review.assert('document.documentElement.scrollWidth<=innerWidth','Narrow window has no horizontal page overflow');
  await review.assert(headerAligned, 'The restored header also aligns correctly in a narrow window');
  await review.screenshot('chat-header-narrow');
}
