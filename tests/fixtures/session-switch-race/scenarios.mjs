// Build first, then run the isolated renderer against deferred in-memory IPC:
// node tests/fixtures/model-settings/run.mjs --run --scenario=../session-switch-race/scenarios.mjs
//
// zcode fast switching: a slow in-flight navigation never blocks the sidebar.
// Session rows stay clickable while another switch loads, every click issues its
// navigation (the agent queues latest-wins), and the last-clicked conversation wins.
import { readFile } from 'node:fs/promises';

const text = await readFile(new URL('../new-conversation/scenarios.mjs', import.meta.url), 'utf8');
const start = text.indexOf('function installNewConversationFixture() {');
const end = text.indexOf('\n}', start);
if (start < 0 || end < 0) throw new Error('Could not extract installNewConversationFixture');
const installer = text.slice(start, end + 2);

export default async function scenarios(review) {
  const state = 'window.__newConversationReview';
  const input = '.pd-composer-shell textarea';
  const editor = `document.querySelector(${JSON.stringify(input)})`;
  const oldPath = `${state}.oldPath`;
  const row = path => `.pd-session-item[data-session-path="${JSON.stringify(path).slice(1, -1)}"] .pd-session-row`;

  await review.waitFor('window.__modelReview?.ready === true');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installer})()`);
  await review.waitFor(`${editor}?.value === '旧对话尚未发送的草稿'`);

  async function createConversation() {
    await review.click('.pd-new-session');
    await review.waitFor(`Boolean(${state}.pending)`);
    await review.evaluate(`${state}.emitReset()`);
    await review.settle();
    await review.evaluate(`${state}.emitReady()`);
    await review.settle();
    await review.evaluate(`${state}.finish()`);
    await review.waitFor(`!${state}.pending`);
  }

  // Two extra conversations so a navigation race has somewhere to go.
  await createConversation();
  await createConversation();
  await review.waitFor(`document.querySelectorAll('.pd-session-item[data-session-path]').length === 3`);
  const latest = await review.evaluate(`${state}.creations.at(-1).sessionPath`);

  // Hold every switchSession RPC until the scenario releases it.
  await review.evaluate(`(() => {
    const bridge = window.piDesktop;
    const original = bridge.switchSession.bind(bridge);
    const race = { calls: [], release: () => {}, gate: Promise.resolve() };
    race.gate = new Promise(done => { race.release = done; });
    window.__switchRace = race;
    bridge.switchSession = async (path) => { race.calls.push(path); await race.gate; return original(path); };
  })()`);

  // First click: its navigation stays in flight (RPC held at the gate).
  await review.click(row(await review.evaluate(`${state}.creations[0].sessionPath`)));
  await review.waitFor(`window.__switchRace.calls.length === 1`);

  // zcode semantics: the sidebar keeps accepting clicks while a switch loads —
  // rows are not disabled and the current conversation row is no dead end either.
  await review.assert(`!document.querySelector(${JSON.stringify(row('$OLD'))}).disabled && !document.querySelector(${JSON.stringify(row('$LATEST'))}).disabled`
    .replace('$OLD', await review.evaluate(oldPath)).replace('$LATEST', latest), 'session rows stay enabled while a navigation is in flight');

  // Second click during the in-flight navigation still issues its navigation.
  await review.click(row(await review.evaluate(oldPath)));
  await review.waitFor(`window.__switchRace.calls.length === 2`);

  // Release: the held navigations apply in order and the last click wins.
  await review.evaluate(`window.__switchRace.release()`);
  await review.waitFor(`${editor}.value === '旧对话尚未发送的草稿' && !document.querySelector('.pd-send-button').disabled`);
  await review.assert(`window.__modelReview.snapshot.sessionPath === ${oldPath} && document.querySelector(${JSON.stringify(row(await review.evaluate(oldPath)))})?.getAttribute('aria-current') === 'page'`,
    'the last-clicked conversation becomes active after the queued navigations settle');
}
