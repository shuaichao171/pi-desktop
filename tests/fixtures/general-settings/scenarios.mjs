// Settings → 常规 / 对话 / 通知与声音 / 外观 / 自定义指令.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../general-settings/scenarios.mjs
function installPersonalizationFixture() {
  const bridge = window.piDesktop, clone = value => structuredClone(value);
  const state = window.__personalizationReview = {
    saves: [],
    documents: [
      { id: 'user', path: 'C:/Users/review/AGENTS.md', exists: true, revision: 'r1', content: '# 回复偏好\n- 使用简体中文回复\n- 代码注释保持英文\n' },
      { id: 'pi', path: 'C:/Users/review/.pi/agent/AGENTS.md', exists: false, revision: null, content: '' },
    ],
  };
  bridge.getPersonalization = async () => clone(state.documents);
  bridge.saveInstruction = async request => {
    state.saves.push(clone(request));
    const document = { ...state.documents.find(item => item.id === request.id), content: request.content, exists: true, revision: `r${state.saves.length + 1}` };
    state.documents = state.documents.map(item => item.id === request.id ? document : item);
    return { status: 'saved', document: clone(document) };
  };
}

const scrollContent = position => `(() => { const content = document.querySelector('.pd-settings-content'); content.scrollTop = ${position === 'end' ? 'content.scrollHeight' : position}; })()`;
const pages = [['常规', 'general'], ['对话', 'conversation'], ['通知与声音', 'notifications'], ['外观', 'appearance'], ['自定义指令', 'instructions']];

async function capturePages(review, theme) {
  for (const [page, name] of pages) {
    await review.clickText('.pd-settings-nav button', page);
    await review.settle();
    await review.evaluate(scrollContent(0));
    await review.screenshot(`${name}-${theme}-01-top`);
    await review.evaluate(scrollContent('end'));
    await review.screenshot(`${name}-${theme}-02-end`);
    await review.evaluate(scrollContent(0));
  }
}

export default async function generalSettingsScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-activity-bar"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.evaluate(`(${installPersonalizationFixture.toString()})()`);
  await review.click('.pd-settings-entry');

  await review.waitFor("document.querySelectorAll('.pd-settings-content .pd-settings-group').length === 2");
  await review.assert("!document.querySelector('[data-setting=show-reasoning], [data-setting=notifications], [data-setting=extension-notices]')", 'General keeps basic and system settings while chat and notifications have their own pages');
  await review.assert("document.querySelector('[data-setting=conversation-storage] input').getBoundingClientRect().width > 300", 'The storage path field fills its row');
  await review.assert("!document.querySelector('[data-action=save-conversation-storage]')", 'Storage save appears only after the path changes');
  await review.assert("(() => { const groups = [...document.querySelectorAll('.pd-settings-nav-group')]; return groups.at(-1).getAttribute('aria-label') === '高级' && [...groups.at(-1).querySelectorAll('button')].map(button => button.textContent.trim()).join(',') === '远程访问,引擎,AI 调试接口' && groups.find(group => group.getAttribute('aria-label') === 'AI 配置').textContent.includes('自定义指令'); })()", 'Remote access, engine and debug tools form the last navigation group; custom instructions sit with AI configuration');

  await review.clickText('.pd-settings-nav button', '对话');
  await review.assert("Boolean(document.querySelector('[data-setting=busy-input-behavior]')) && Boolean(document.querySelector('.pd-metrics-settings')) && !document.querySelector('[data-setting=notifications], [data-setting=extension-notices]')", 'Chat settings contain input and conversation controls');
  await review.assert("document.querySelector('[data-setting=\"show-reasoning\"]').getAttribute('role') === 'switch'", 'On/off settings render as switches');
  const before = await review.evaluate("document.querySelector('[data-setting=\"show-reasoning\"]').getAttribute('aria-checked')");
  await review.click('[data-setting="show-reasoning"]');
  await review.waitFor(`document.querySelector('[data-setting="show-reasoning"]').getAttribute('aria-checked') !== ${JSON.stringify(before)}`);
  await review.click('[data-setting="show-reasoning"]');
  await review.waitFor(`document.querySelector('[data-setting="show-reasoning"]').getAttribute('aria-checked') === ${JSON.stringify(before)}`);
  await review.clickText('.pd-settings-nav button', '通知与声音');
  await review.assert("['notifications', 'notification-sound', 'extension-notices', 'operation-notice-timeout'].every(setting => document.querySelector('[data-setting=' + setting + ']')) && !document.querySelector('[data-setting=show-reasoning]')", 'Notification controls and plugin notices share one page');
  await review.click('[data-setting=notifications]');
  await review.waitFor('window.__modelReview.desktopSettings.notificationsEnabled === true');
  await review.clickText('.pd-settings-nav button', '常规');
  await review.clickText('.pd-settings-nav button', '通知与声音');
  await review.assert("document.querySelector('[data-setting=notifications]').getAttribute('aria-checked') === 'true'", 'Notification preferences survive page navigation');

  await review.clickText('.pd-settings-nav button', '自定义指令');
  await review.waitFor("document.querySelectorAll('.pd-instruction-card').length === 2");
  await review.assert("!document.querySelector('.pd-personalization').textContent.includes('正在读取指令文件')", 'The loading notice clears once the instruction files arrive');
  await review.fill('#pd-instruction-pi', '先阅读相关代码再修改');
  await review.clickText('.pd-settings-nav button', '对话');
  await review.waitFor('Boolean(document.querySelector(".pd-settings-discard"))');
  await review.clickText('.pd-settings-discard button', '继续编辑');
  await review.assert('document.querySelector("#pd-instruction-pi").value === "先阅读相关代码再修改" && document.activeElement.id === "pd-instruction-pi"', 'Renamed instructions keep the draft and restore focus after cancelling navigation');
  await review.waitFor("Boolean(document.querySelector('[data-instruction-id=\"pi\"] .pd-instruction-save:not(:disabled)'))");
  await review.click('[data-instruction-id="pi"] .pd-instruction-save');
  await review.waitFor("window.__personalizationReview.saves.length === 1 && document.querySelector('[data-instruction-id=\"pi\"]').textContent.includes('已保存到文件')");

  await capturePages(review, 'dark');
  await review.clickText('.pd-settings-nav button', '外观');
  await review.clickText('.pd-appearance-choice', '浅色');
  await capturePages(review, 'light');
  await review.viewport(680, 900);
  for (const [page, name] of pages) {
    await review.clickText('.pd-settings-nav button', page);
    await review.settle();
    await review.assert('document.documentElement.scrollWidth <= innerWidth', `${page} has no horizontal overflow at narrow width`);
    await review.screenshot(`${name}-narrow`);
  }
}
