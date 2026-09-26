// Run only through the isolated renderer runner; never attaches a user browser.
export default async function conversationScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true');
  await review.reducedMotion(true);
  await review.evaluate(`(() => {
    const fixture = window.__modelReview, bridge = window.piDesktop;
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400;
    const context = canvas.getContext('2d');
    context.fillStyle = '#20344b'; context.fillRect(0, 0, 600, 400);
    context.fillStyle = '#22b8a8'; context.fillRect(30, 30, 255, 250);
    context.fillStyle = '#f4bf5a'; context.fillRect(315, 30, 255, 250);
    context.fillStyle = '#ffffff'; context.font = 'bold 32px sans-serif'; context.fillText('600 × 400 px', 190, 342);
    const png = canvas.toDataURL('image/png').split(',')[1];
    const messages = Array.from({ length: 30 }, (_, i) => [
      { id: 'u' + i, order: i * 2, role: 'user', text: 'Question ' + i, status: 'done', ...(i === 0 ? { attachments: [{ kind: 'image', name: 'preview.png', mimeType: 'image/png', data: png }], attachmentsOmitted: 1, attachmentReferences: [{ index: 1, kind: 'image', name: 'on-demand.png', mimeType: 'image/png', size: 9000000 }] } : {}) },
      { id: 'a' + i, order: i * 2 + 1, role: 'assistant', text: i === 0 ? '**needle** in prose.\\n\\nAnother needle here.\\n\\n' + '\x60\x60\x60js\\n' + 'const x = 1;\\n'.repeat(34) + '// needle\\n' + '\x60\x60\x60' : ('Answer ' + i + '\\n\\n').repeat(5), status: i === 29 ? 'error' : 'done', ...(i === 29 ? { errorMessage: 'Model output interrupted' } : {}) }
    ]).flat();
    messages.find(message => message.id === 'a1').text = ['~~old~~ new', '', '| Name | State |', '| --- | --- |', '| alpha | ready |', '', '- [x] done', '- [ ] waiting', '', 'www.example.com'].join('\\n');
    messages.find(message => message.id === 'a2').text = '\x60\x60\x60\\nfoo\\n\x60\x60\x60\\n\\nbar';
    const state = window.__conversationReview = { messages, attachmentCalls: [], switches: [], edits: [], pages: 0, copied: '', path: fixture.snapshot.sessionPath, cwd: fixture.snapshot.cwd };
    state.ready = (path = state.path, items = messages, total = items.length) => {
      Object.assign(fixture.snapshot, { sessionPath: path, sessionId: path, messages: items, activities: [], historyTotal: total, error: null });
      fixture.emitAgent({ ...fixture.snapshot, type: 'ready' }); fixture.emitAgent({ type: 'status', status: 'idle' });
    };
    state.ready();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { state.copied = text; } } });
    bridge.getMessageAttachment = async (...args) => { state.attachmentCalls.push(args); if (state.failImage) throw new Error('Image temporarily unavailable'); return { kind: 'image', name: 'on-demand.png', mimeType: 'image/png', data: png }; };
    bridge.editMessage = async (...args) => { state.edits.push(args); };
    bridge.forkAssistantMessage = async () => {};
    bridge.getHistoryPage = async (offset, limit) => { state.pages++; if (state.deferPage) return new Promise(resolve => { state.releasePage = resolve; }); return { offset, limit, total: state.history?.length ?? messages.length, messages: (state.history ?? messages).slice(offset, offset + limit), activities: [] }; };
    bridge.searchSessions = async () => ({ sessions: [{ cwd: state.cwd, path: state.path, id: state.path, name: 'Older result', firstMessage: 'Older result', messageCount: 460, modified: new Date().toISOString(), messageId: 'old-target', snippet: 'Ancient result' }], truncated: false });
    bridge.searchWorkspaceFiles = async () => ({ entries: [], truncated: false });
    bridge.searchSessionsPage = async () => ({ ...(await bridge.searchSessions()), total: 1, nextCursor: null });
    bridge.searchProjectFiles = async () => ({ ...(await bridge.searchWorkspaceFiles()), total: 0, nextCursor: null, skipReasons: { binary: 0, large: 0, unreadable: 0 } });
    bridge.cancelDataSearch = async () => {};
    bridge.switchSession = async path => { state.ready(path, state.searchLatest ?? messages, state.history?.length ?? messages.length); };
    let leaf = { id: 'tree20', label: 'Current answer', kind: 'assistant', active: true, childCount: 0, children: [], timestamp: new Date().toISOString() };
    for (let i = 19; i >= 0; i--) leaf = { id: 'tree' + i, label: 'Path node ' + i, kind: 'user', active: true, childCount: 1, children: [leaf] };
    state.tree = [leaf, { id: 'other', label: 'Other branch summary', kind: 'assistant', active: false, childCount: 0, children: [] }];
    bridge.getSessionTree = async () => structuredClone(state.tree);
    bridge.switchSessionBranch = async id => { state.switches.push(id); if (state.failTreeSwitch) { state.failTreeSwitch = false; throw new Error('Branch temporarily unavailable'); } const visit = nodes => nodes.forEach(node => { node.active = node.id === id; visit(node.children); }); visit(state.tree); };
  })()`);
  await review.waitFor('document.querySelector("[data-message-id=a29]") !== null');

  // Same rendered answer has three occurrences, including code beyond its fold.
  await review.key('f', { ctrl: true });
  for (const query of ['~~', '|', '---', '[x]', '[ ]', 'foobar']) {
    await review.fill('.pd-transcript-find-input', query);
    await review.assert('document.querySelector(".pd-transcript-find-count").classList.contains("is-empty") && CSS.highlights.get("pd-find-all").size === 0', 'GFM markers and artificial block joins are not visible matches: ' + query);
  }
  for (const query of ['old', 'alpha', 'done', 'www.example.com', 'foo']) {
    await review.fill('.pd-transcript-find-input', query);
    await review.assert('document.querySelector(".pd-transcript-find-count").textContent.includes("1") && CSS.highlights.get("pd-find-all").size === 1 && CSS.highlights.get("pd-find-current").size === 1', 'GFM visible content has matching index and DOM highlight: ' + query);
  }
  await review.fill('.pd-transcript-find-input', 'needle');
  await review.waitFor('document.querySelector(".pd-transcript-find-count").textContent.includes("3")');
  await review.assert('CSS.highlights.get("pd-find-all").size === 3 && CSS.highlights.get("pd-find-current").size === 1', 'Three exact rendered occurrences are highlighted');
  await review.evaluate('window.__conversationReview.firstRange = [...CSS.highlights.get("pd-find-current")][0].startOffset');
  await review.key('Enter');
  await review.assert('document.querySelector(".pd-transcript-find-count").textContent.includes("2")', 'Enter advances to the second occurrence');
  await review.key('Enter');
  await review.assert('[...CSS.highlights.get("pd-find-current")][0].startContainer.parentElement.closest("code") !== null', 'Third occurrence is visible inside the expanded code block');
  await review.assert('(() => {const range=[...CSS.highlights.get("pd-find-current")][0]; const rect=range.getBoundingClientRect(); const box=range.startContainer.parentElement.closest(".pd-code-block-body").getBoundingClientRect(); return rect.top>=box.top-1 && rect.bottom<=box.bottom+1;})()', 'The exact hit is revealed inside the code block scroll viewport');
  await review.key('Enter', { shift: true });
  await review.screenshot('conversation-find-occurrences');
  await review.key('Escape');

  // Selection quoting appends to the current draft and can be removed separately.
  await review.fill('.pd-composer-shell textarea', 'existing draft');
  await review.evaluate(`(() => { const body=document.querySelector('[data-message-id=a0] [data-message-body]'); const p=body.querySelector('p'); const range=document.createRange(); range.selectNodeContents(p); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range); body.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})); })()`);
  await review.click('[data-quote-for=a0]');
  await review.assert('document.querySelector(".pd-composer-shell textarea").value.includes("existing draft") && document.querySelector(".pd-composer-shell textarea").value.includes("> needle in prose.")', 'Quoted text preserves the existing draft and selected content');
  await review.evaluate('window.__conversationReview.ready("other-session", [{id:"other-u",order:0,role:"user",text:"Other task",status:"done"}])');
  await review.assert('document.querySelector(".pd-composer-shell textarea").value === ""', 'Other sessions receive an isolated draft');
  await review.evaluate('window.__conversationReview.ready()');
  await review.waitFor('document.querySelector(".pd-composer-shell textarea").value.includes("existing draft")');
  await review.click('.pd-quote-chip');
  await review.assert('document.querySelector(".pd-composer-shell textarea").value.trim() === "existing draft"', 'Removing a quote leaves the original draft');

  // Partial failures remain copyable and regeneration is bound to the original turn.
  await review.evaluate('document.querySelector("[data-message-id=a29]").scrollIntoView({block:"center"})');
  await review.click('[data-message-id=a29] .pd-message-action[aria-label="复制"]');
  await review.assert('window.__conversationReview.copied.startsWith("Answer 29")', 'Partial failed output can still be copied');
  await review.click('[data-message-id=a29] .pd-message-action[aria-label^="重新生成"]');
  await review.assert('window.__conversationReview.edits[0][0] === "u29"', 'Regeneration targets the original user entry');

  // Native modal, keyboard return focus, fit and 100%, same-message image switching.
  await review.click('[data-message-id=u0] .pd-message-image button');
  await review.waitFor('document.querySelector(".pd-image-preview[open] img")?.complete === true');
  await review.clickText('.pd-image-preview-toolbar button', '100%');
  await review.assert('(() => { const image=document.querySelector(".pd-image-preview img"); const box=image.getBoundingClientRect(); return document.querySelector(".pd-image-preview-toolbar output").textContent === "100%" && image.naturalWidth === 600 && image.naturalHeight === 400 && Math.abs(box.width-600)<1 && Math.abs(box.height-400)<1; })()', 'Preview switches to the actual 600 × 400 natural size');
  await review.click('.pd-image-preview-toolbar button[aria-label="放大"]');
  await review.assert('(() => { const box=document.querySelector(".pd-image-preview img").getBoundingClientRect(); return document.querySelector(".pd-image-preview-toolbar output").textContent === "125%" && Math.abs(box.width-750)<1 && Math.abs(box.height-500)<1; })()', 'Zoom changes rendered image dimensions to 750 × 500');
  await review.evaluate('window.__conversationReview.failImage = true');
  await review.key('ArrowRight');
  await review.waitFor('document.querySelector(".pd-image-preview [role=alert]") !== null');
  await review.evaluate('window.__conversationReview.failImage = false');
  await review.clickText('.pd-image-preview [role=alert] button', '重试');
  await review.waitFor('document.querySelector(".pd-image-preview img")?.complete === true');
  await review.assert('window.__conversationReview.attachmentCalls.length === 2 && window.__conversationReview.attachmentCalls[0][2] === 1', 'Omitted attachment is fetched by stable message/index and is retryable');
  await review.clickText('.pd-image-preview-toolbar button', '100%');
  await review.screenshot('conversation-image-preview');
  await review.key('Escape');
  await review.assert('document.activeElement === document.querySelector("[data-message-id=u0] .pd-message-image button")', 'Escape returns focus to the original thumbnail');

  // Reading memory restores the anchor across sessions.
  await review.evaluate(`(() => { const node=document.querySelector('.pd-transcript'); document.querySelector('[data-message-id=u15]').scrollIntoView({block:'start'}); node.dispatchEvent(new Event('scroll')); window.__conversationReview.readOffset=document.querySelector('[data-message-id=u15]').getBoundingClientRect().top-node.getBoundingClientRect().top; })()`);
  await review.settle();
  await review.evaluate(`(() => { const s=window.__conversationReview; const message={id:'live-u30',order:60,role:'user',text:'Background continuation',status:'done'}; s.messages.push(message); window.__modelReview.emitAgent({type:'user-message',id:message.id,order:message.order,text:message.text}); })()`);
  await review.settle();
  await review.evaluate('window.__conversationReview.ready("other-session", [{id:"other-u",order:0,role:"user",text:"Other task",status:"done"}])');
  await review.settle();
  await review.evaluate('window.__conversationReview.ready()');
  await review.waitFor('Math.abs(document.querySelector("[data-message-id=u15]").getBoundingClientRect().top-document.querySelector(".pd-transcript").getBoundingClientRect().top-window.__conversationReview.readOffset)<6');
  await review.record('reading-memory-after-live-append', '({offset:document.querySelector("[data-message-id=u15]").getBoundingClientRect().top-document.querySelector(".pd-transcript").getBoundingClientRect().top,expected:window.__conversationReview.readOffset})');
  await review.screenshot('conversation-reading-restored');

  // Tree selection and keyboard navigation never switch until explicit confirmation.
  await review.click('.pd-chat-header-more');
  await review.clickText('[role=menuitem]', '会话树');
  await review.waitFor('document.querySelector("[data-tree-id=tree20]") !== null');
  await review.click('.pd-tree-locate');
  await review.key('Home'); await review.key('ArrowLeft');
  await review.assert('document.activeElement.dataset.treeId === "tree0" && document.activeElement.getAttribute("aria-expanded") === "false"', 'Home and Left collapse the current path with correct ARIA');
  await review.key('End');
  await review.assert('document.querySelector(".pd-tree-inspector").textContent.includes("Other branch summary") && window.__conversationReview.switches.length === 0', 'Selecting another branch only previews its summary');
  await review.key('Tab');
  await review.assert('document.activeElement === document.querySelector(".pd-tree-inspector button")', 'Tree has a single roving Tab entry followed by confirmation');
  await review.evaluate('window.__conversationReview.failTreeSwitch = true');
  await review.key('Enter');
  await review.waitFor('document.querySelector(".pd-session-tree [role=alert]") !== null');
  await review.assert('document.querySelector("[data-tree-id=other]").getAttribute("aria-selected") === "true" && document.querySelector(".pd-tree-inspector strong").textContent === "助手回答"', 'Failed branch switch preserves the selected target and uses a readable node type');
  await review.clickText('.pd-session-tree [role=alert] button', '重试');
  await review.waitFor('document.querySelector("[data-tree-id=other]").getAttribute("aria-current") === "true"');
  await review.assert('window.__conversationReview.switches.length === 2 && window.__conversationReview.switches.every(id => id === "other") && document.querySelector(".pd-session-tree [role=alert]") === null', 'Retry repeats the failed branch target and succeeds');
  await review.screenshot('conversation-tree-confirmed');
  await review.key('Escape');

  // Global search locates beyond the latest 400 entries through existing pages.
  await review.evaluate(`(() => { const s=window.__conversationReview; s.history=Array.from({length:460},(_,i)=>({id:i===0?'old-target':'long-'+i,order:i,role:i%2?'assistant':'user',text:i===0?'Ancient result':'History row '+i,status:'done'})); s.searchLatest=s.history.slice(-400); })()`);
  await review.key('k', { ctrl: true }); await review.fill('.pd-search-input', '# Ancient result');
  await review.waitFor('document.querySelector(".pd-search-result") !== null');
  await review.key('Enter');
  await review.waitFor('document.querySelector("[data-message-id=old-target].is-search-match") !== null');
  await review.assert('window.__conversationReview.pages > 0', 'Global search automatically fetched older history');
  await review.screenshot('conversation-search-older-page');

  // Cancel a deferred page by changing session; its late result must not pull back.
  await review.evaluate('window.__conversationReview.deferPage = true');
  await review.key('k', { ctrl: true }); await review.fill('.pd-search-input', '# Ancient result');
  await review.waitFor('document.querySelector(".pd-search-result") !== null'); await review.key('Enter');
  await review.waitFor('Boolean(window.__conversationReview.releasePage)');
  await review.evaluate('window.__conversationReview.ready("cancel-destination", [{id:"destination",order:0,role:"user",text:"Keep this session",status:"done"}]); window.__conversationReview.releasePage({offset:0,limit:60,total:460,messages:window.__conversationReview.history.slice(0,60),activities:[]})');
  await review.settle();
  await review.assert('document.querySelector("[data-message-id=destination]") !== null && document.querySelector("[data-message-id=old-target]") === null', 'Late older-page response cannot change the new session');
}
