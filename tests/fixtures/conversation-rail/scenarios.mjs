// Run with the isolated built-renderer driver, using its owned headless browser.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../conversation-rail/scenarios.mjs
export default async function conversationRailScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true');
  await review.viewport(1440, 1000);
  await review.reducedMotion(false);
  await review.evaluate(`(() => {
    const fixture = window.__modelReview;
    const state = window.__railReview = { jumps: [], pointerEntries: [], previews: [] };
    const messages = Array.from({ length: 30 }, (_, index) => [
      { id: 'rail-user-' + index, order: index * 2, role: 'user', text: '历史问题 ' + String(index + 1).padStart(2, '0') + '：检查交互的实时反馈', status: 'done' },
      { id: 'rail-answer-' + index, order: index * 2 + 1, role: 'assistant', text: '回答 ' + String(index + 1).padStart(2, '0') + '：预览应持续跟随当前指针位置。\\n\\n' + '保持历史导航、键盘访问和拖动跳转稳定。 '.repeat(8), status: 'done' },
    ]).flat();
    Object.assign(fixture.snapshot, { messages, activities: [], runs: [], historyTotal: messages.length, error: null, status: 'idle' });
    window.piDesktop.listSessions = async () => [{ path: fixture.snapshot.sessionPath, id: fixture.snapshot.sessionId, firstMessage: messages[0].text, modified: new Date().toISOString(), messageCount: messages.length }];
    fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
    fixture.emitAgent({ type: 'status', status: 'idle' });
    state.title = index => messages[index * 2].text;
    state.preview = () => document.querySelector('.pd-conv-rail-preview-title')?.textContent ?? null;
    // Jumps scroll only the transcript (no scrollIntoView), so record which user
    // message sits nearest the transcript centre after each scroll write.
    const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get() { return scrollTop.get.call(this); }, set(value) {
      scrollTop.set.call(this, value);
      if (!this.classList.contains('pd-transcript')) return;
      const bounds = this.getBoundingClientRect(), centre = bounds.top + bounds.height / 2;
      const rows = [...this.querySelectorAll('[data-message-id^="rail-user-"]')];
      const nearest = rows.sort((a, b) => Math.abs(a.getBoundingClientRect().top + a.getBoundingClientRect().height / 2 - centre) - Math.abs(b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2 - centre))[0];
      if (nearest) state.jumps.push({ id: nearest.dataset.messageId, at: performance.now() });
    } });
    document.addEventListener('pointerenter', event => {
      const marker = event.target instanceof Element && event.target.matches('[data-rail-id]') ? event.target : null;
      if (marker) state.pointerEntries.push({ id: marker.dataset.railId, at: performance.now(), trusted: event.isTrusted });
    }, true);
    document.addEventListener('pointerdown', event => {
      const marker = event.target instanceof Element ? event.target.closest('[data-rail-id]') : null;
      if (marker) state.pointerDown = { id: marker.dataset.railId, pointerId: event.pointerId };
    }, true);
    new MutationObserver(() => {
      const title = state.preview();
      if (title !== state.previews.at(-1)?.title) state.previews.push({ title, at: performance.now() });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  })()`);
  await review.waitFor('document.querySelectorAll(".pd-conv-rail-item").length === 30 && document.querySelector(".pd-conv-rail").getBoundingClientRect().width > 0');
  await review.assert('matchMedia("(prefers-reduced-motion: reduce)").matches === false', 'Rail interaction is tested with normal motion enabled');
  const point = index => review.evaluate(`(() => {
    const marker = document.querySelector('[data-rail-id="rail-user-${index}"]');
    const rect = marker.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    if (!rect.width || !rect.height || !marker.contains(document.elementFromPoint(x, y))) throw new Error('Rail marker is not a usable mouse target');
    return { x, y };
  })()`);
  const matches = index => `window.__railReview.preview() === window.__railReview.title(${index})`;
  const hover = async index => { const p = await point(index); await review.mouseMove(p.x, p.y); };
  const outside = await review.evaluate('(() => { const rect = document.querySelector(".pd-conv-rail").getBoundingClientRect(); return { x: rect.right + 100, y: rect.top }; })()');

  await hover(3);
  await review.waitFor(matches(3));
  await review.screenshot('rail-normal-motion-initial-preview');
  for (const index of [4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 3, 4, 5]) {
    await hover(index);
    await review.record('rail-hover-frame-' + index, `({ expected: window.__railReview.title(${index}), actual: window.__railReview.preview(), entered: window.__railReview.pointerEntries.at(-1), preview: window.__railReview.previews.at(-1), now: performance.now() })`);
    await review.assert(matches(index), 'Rapid marker traversal shows item ' + (index + 1) + ' after two rendering frames without waiting 140 ms');
  }
  await review.assert('window.__railReview.pointerEntries.length >= 15 && window.__railReview.pointerEntries.every(event => event.trusted)', 'Dense forward and backward traversal uses real trusted pointer events');
  await review.screenshot('rail-normal-motion-rapid-preview');
  await review.mouseMove(outside.x, outside.y);
  await review.assert('window.__railReview.preview() === null', 'Moving outside the history rail dismisses its preview');
  await review.evaluate('new Promise(resolve => setTimeout(resolve, 220))');
  await review.assert('window.__railReview.preview() === null', 'No delayed hover timer or animation frame restores a dismissed preview');
  await hover(12);
  await review.mouseMove(outside.x, outside.y);
  await review.evaluate('new Promise(resolve => setTimeout(resolve, 220))');
  await review.assert('window.__railReview.preview() === null', 'Leaving during a fresh hover also clears pending preview work');

  await review.evaluate('document.querySelector("[data-rail-id=rail-user-9]").focus()');
  await review.settle();
  await review.assert(matches(9), 'Keyboard focus opens the matching preview immediately');
  await review.key('Tab');
  await review.assert('document.activeElement?.dataset.railId === "rail-user-10" && ' + matches(10), 'Tab advances focus and preview to the next dense marker');
  await review.key('Tab', { shift: true });
  await review.assert('document.activeElement?.dataset.railId === "rail-user-9" && ' + matches(9), 'Shift+Tab reverses focus and preview without a stale item');
  await review.key('Enter');
  await review.settle();
  await review.assert('window.__railReview.jumps.at(-1)?.id === "rail-user-9"', 'Keyboard activation navigates to the focused user message');
  await review.evaluate('document.activeElement.blur()');
  await review.settle();
  await review.assert('window.__railReview.preview() === null', 'Blurring the marker clears the keyboard preview');

  let p = await point(7);
  await review.mouseDown(p.x, p.y); await review.mouseUp();
  await review.settle();
  await review.assert('window.__railReview.jumps.at(-1)?.id === "rail-user-7"', 'A normal mouse click navigates to its marker');
  p = await point(8);
  await review.mouseDown(p.x, p.y);
  for (const index of [9, 10, 11, 12, 11, 10, 14]) {
    await hover(index);
    await review.assert(matches(index), 'Held-pointer scrubbing previews the latest marker ' + (index + 1));
    await review.assert(`document.querySelectorAll('.pd-conv-rail-item[data-previewed="true"]').length === 1 && document.querySelector('.pd-conv-rail-item[data-previewed="true"]').dataset.railId === 'rail-user-${index}'`, 'The visually expanded marker follows the dragged target ' + (index + 1));
  }
  await review.mouseUp();
  await review.settle();
  await review.assert('window.__railReview.jumps.at(-1)?.id === "rail-user-14"', 'Releasing a scrub does not click or jump back to the pressed marker');
  await review.evaluate('window.__railReview.afterDrag = { jumps: window.__railReview.jumps.length, scrollTop: document.querySelector(".pd-transcript").scrollTop }');
  await review.evaluate('new Promise(resolve => setTimeout(resolve, 220))');
  await review.assert('window.__railReview.jumps.length === window.__railReview.afterDrag.jumps && Math.abs(document.querySelector(".pd-transcript").scrollTop - window.__railReview.afterDrag.scrollTop) < 1', 'No stale jump or scroll correction rolls the transcript back after releasing the pointer');
  await review.screenshot('rail-normal-motion-drag-final-target');
  await review.mouseMove(outside.x, outside.y);

  p = await point(10);
  await review.mouseDown(p.x, p.y);
  await hover(13);
  await review.evaluate(`(() => {
    const press = window.__railReview.pointerDown;
    const marker = document.querySelector('[data-rail-id="' + press.id + '"]');
    marker.dispatchEvent(new PointerEvent('pointercancel', { pointerId: press.pointerId, pointerType: 'mouse', bubbles: true, buttons: 0 }));
    if (marker.hasPointerCapture(press.pointerId)) marker.releasePointerCapture(press.pointerId);
  })()`);
  await review.mouseMove(outside.x, outside.y);
  await review.mouseUp();
  await review.assert('window.__railReview.preview() === null && !document.querySelector(".pd-conv-rail-item[data-previewed=true]")', 'Cancelled scrubbing clears the preview and its expanded marker');
  await review.evaluate('document.querySelector("[data-rail-id=rail-user-12]").focus()');
  await review.key('Enter');
  await review.settle();
  await review.assert('window.__railReview.jumps.at(-1)?.id === "rail-user-12"', 'Keyboard activation remains available immediately after a cancelled drag');
  p = await point(16);
  await review.mouseDown(p.x, p.y); await review.mouseUp();
  await review.settle();
  await review.assert('window.__railReview.jumps.at(-1)?.id === "rail-user-16"', 'The next ordinary mouse click is not swallowed after a cancelled drag');
  await review.mouseMove(outside.x, outside.y);

  await review.evaluate(`(() => {
    const fixture = window.__modelReview;
    const messages = Array.from({ length: 100 }, (_, index) => [
      { id: 'rail-user-' + index, order: index * 2, role: 'user', text: '长对话问题 ' + String(index + 1).padStart(3, '0') + '：逐项导航', status: 'done' },
      { id: 'rail-answer-' + index, order: index * 2 + 1, role: 'assistant', text: '回答 ' + (index + 1) + '：超过 64 条历史仍保留可用的鼠标目标和滚动空间。', status: 'done' },
    ]).flat();
    window.__railReview.title = index => messages[index * 2].text;
    Object.assign(fixture.snapshot, { messages, historyTotal: messages.length });
    fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
  })()`);
  await review.waitFor('document.querySelectorAll(".pd-conv-rail-item").length === 100');
  await review.assert('Array.from(document.querySelectorAll(".pd-conv-rail-item")).every(marker => marker.getBoundingClientRect().height >= 9.9)', 'One hundred history markers retain a 10 px target height instead of shrinking into the list');
  await review.assert('(() => { const list = document.querySelector(".pd-conv-rail-list"); return list.scrollHeight - list.clientHeight >= 350; })()', 'History beyond 64 markers has actual vertical scrolling overflow');
  await review.evaluate('document.querySelector("[data-rail-id=rail-user-62]").focus()');
  for (let index = 63; index < 100; index++) await review.key('Tab');
  await review.assert('document.activeElement?.dataset.railId === "rail-user-99" && ' + matches(99), 'Native keyboard traversal reaches and previews the final item beyond the first 64 markers');
  await review.assert('(() => { const list = document.querySelector(".pd-conv-rail-list"), last = document.querySelector("[data-rail-id=rail-user-99]"); const bounds = list.getBoundingClientRect(), item = last.getBoundingClientRect(); return list.scrollTop > 300 && item.top >= bounds.top && item.bottom <= bounds.bottom + 1; })()', 'The rail scrolls its last marker fully into view as keyboard focus advances');
  await hover(98);
  await review.assert(matches(98), 'Real pointer hover still tracks correctly after scrolling a long rail');
  await review.screenshot('rail-normal-motion-scrollable-long-history');
  await review.mouseMove(outside.x, outside.y);
  await review.evaluate(`(() => {
    document.activeElement?.blur();
    const fixture = window.__modelReview;
    Object.assign(fixture.snapshot, { sessionId: 'rail-active-long-session', sessionPath: fixture.snapshot.sessionPath.replace('.jsonl', '-active-long.jsonl') });
    document.querySelector('.pd-conv-rail-list').scrollTop = 0;
    fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
  })()`);
  await review.waitFor('Number(document.querySelector(".pd-conv-rail-item[aria-current=true]")?.dataset.railId.split("-").at(-1)) > 64');
  await review.assert('(() => { const list = document.querySelector(".pd-conv-rail-list"), current = list.querySelector("[aria-current=true]"); const bounds = list.getBoundingClientRect(), item = current.getBoundingClientRect(); return list.scrollTop > 0 && item.top >= bounds.top - 1 && item.bottom <= bounds.bottom + 1; })()', 'Loading a long conversation keeps its current reading marker visible when the rail is not being hovered or focused');
  await review.assert('!document.querySelector(".pd-conv-rail").contains(document.activeElement) && window.__railReview.preview() === null', 'Keeping the active marker visible neither steals focus nor opens an unsolicited preview');
  await review.screenshot('rail-normal-motion-long-history-active-marker');
}
