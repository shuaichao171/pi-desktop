import type { UiThinkingLevel } from '@pidesktop/shared';

type Locale = 'zh' | 'en';

function detectLocale(): Locale {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

/** The phone's language at launch; the app follows the system setting and has no switch of its own. */
export const locale: Locale = detectLocale();

const MESSAGES = {
  // Shared
  'common.back': { zh: '返回', en: 'Back' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.done': { zh: '完成', en: 'Done' },
  'common.close': { zh: '关闭', en: 'Close' },
  'common.submit': { zh: '提交', en: 'Submit' },
  'common.stop': { zh: '停止', en: 'Stop' },
  'common.stopping': { zh: '正在停止…', en: 'Stopping…' },
  'common.dismiss': { zh: '知道了', en: 'Dismiss' },
  'common.error': { zh: '出错了', en: 'Error' },

  // Connection
  'conn.connecting': { zh: '正在连接…', en: 'Connecting…' },
  'conn.reconnecting': { zh: '正在重连（第 {n} 次）…', en: 'Reconnecting (attempt {n})…' },
  'conn.disconnected': { zh: '未连接', en: 'Not connected' },
  'conn.authError': { zh: '授权已失效，请重新配对', en: 'Access revoked. Pair again.' },
  'conn.manage': { zh: '管理电脑', en: 'Manage computers' },

  // Home (conversation list)
  'home.title': { zh: '对话', en: 'Chats' },
  'home.new': { zh: '新对话', en: 'New chat' },
  'home.search': { zh: '搜索对话', en: 'Search chats' },
  'home.unassigned': { zh: '无归属', en: 'Unassigned' },
  'home.emptyProject': { zh: '这个项目还没有对话', en: 'No chats in this project yet' },
  'home.emptyUnassigned': { zh: '还没有项目之外的对话', en: 'No chats outside projects yet' },
  'home.emptySearch': { zh: '没有匹配的对话', en: 'No matching chats' },
  'home.untitled': { zh: '新对话', en: 'New chat' },
  'home.messages': { zh: '{n} 条', en: '{n} msgs' },
  'home.current': { zh: '当前', en: 'Current' },
  'home.pending': { zh: '有 {n} 个请求等待你处理', en: '{n} request(s) waiting for you' },
  'home.notConnectedHint': { zh: '连接电脑后即可查看对话', en: 'Connect to a computer to see chats' },

  // Runtime phases
  'phase.running': { zh: '运行中', en: 'Running' },
  'phase.waiting-approval': { zh: '待审批', en: 'Needs approval' },
  'phase.waiting-input': { zh: '待回复', en: 'Needs input' },
  'phase.failed': { zh: '失败', en: 'Failed' },

  // Relative time
  'time.now': { zh: '刚刚', en: 'Just now' },
  'time.minutes': { zh: '{n} 分钟前', en: '{n}m ago' },
  'time.hours': { zh: '{n} 小时前', en: '{n}h ago' },
  'time.yesterday': { zh: '昨天', en: 'Yesterday' },
  'time.days': { zh: '{n} 天前', en: '{n}d ago' },

  // Chat
  'chat.files': { zh: '文件', en: 'Files' },
  'chat.empty': { zh: '发一条消息，让电脑上的 Pi 开始工作', en: 'Send a message to start working on your computer' },
  'chat.running': { zh: '运行中…', en: 'Running…' },
  'chat.notConnected': { zh: '还没连上电脑', en: 'Not connected to a computer' },
  'chat.placeholder': { zh: '给 Pi 发消息', en: 'Message Pi' },
  'chat.placeholderSteer': { zh: '插话，立即调整当前任务', en: 'Steer the running turn' },
  'chat.placeholderQueue': { zh: '排队，等这轮结束后发送', en: 'Queue a follow-up' },
  'chat.readOnly': { zh: '只读连接，不能发送消息', en: 'Read-only connection' },
  'chat.sendQueue': { zh: '排队发送', en: 'Queue' },
  'chat.sendSteer': { zh: '立即插话', en: 'Steer now' },
  'chat.interruptShell': { zh: '中断命令', en: 'Interrupt shell' },
  'chat.thinking': { zh: '思考过程', en: 'Thinking' },
  'chat.thinkingLive': { zh: '思考中…', en: 'Thinking…' },
  'chat.queued': { zh: '排队中 {n}', en: 'Queued {n}' },
  'chat.queueSteer': { zh: '插话', en: 'Steer' },
  'chat.queueRemove': { zh: '移除', en: 'Remove' },
  'chat.exit': { zh: '退出码 {n}', en: 'exit {n}' },
  'chat.toolRunning': { zh: '运行中', en: 'running' },
  'chat.toolFailed': { zh: '失败', en: 'failed' },
  'chat.toolInterrupted': { zh: '已中断', en: 'interrupted' },
  'chat.background': { zh: '后台任务 {n}', en: 'Background tasks {n}' },
  'chat.steerUnsupported': { zh: '这个 Agent 不支持插话，消息会排队', en: 'This agent queues messages; steering is unsupported' },

  // Model sheet
  'model.title': { zh: '模型与思考', en: 'Model & thinking' },
  'model.agent': { zh: 'Agent', en: 'Agent' },
  'model.builtin': { zh: 'Pi（内置）', en: 'Pi (built-in)' },
  'model.thinking': { zh: '思考强度', en: 'Thinking' },
  'model.model': { zh: '模型', en: 'Model' },
  'model.search': { zh: '搜索模型', en: 'Search models' },
  'model.default': { zh: '默认模型', en: 'Default model' },
  'model.agentLocked': { zh: '对话开始后不能切换 Agent，新建对话再切换。', en: 'Locked once the chat starts. Start a new chat to switch.' },
  'model.noAgentModels': { zh: '{name} 还没有报告可用模型', en: 'No models reported by {name} yet' },
  'model.noMatch': { zh: '没有匹配的模型', en: 'No matching models' },

  // Approval
  'approval.required': { zh: '需要你批准', en: 'Approval needed' },
  'approval.input': { zh: '需要你回复', en: 'Input needed' },
  'approval.approve': { zh: '批准', en: 'Approve' },
  'approval.deny': { zh: '拒绝', en: 'Deny' },
  'approval.placeholder': { zh: '输入回复', en: 'Type a reply' },
  'approval.readOnly': { zh: '只读连接：请在电脑或完全控制的设备上处理', en: 'Read-only: respond on the computer or a full-control device' },
  'approval.form': { zh: '需要你填写', en: 'Form' },
  'approval.decline': { zh: '拒绝填写', en: 'Decline' },
  'approval.scope.once': { zh: '仅这一次', en: 'Once' },
  'approval.scope.session': { zh: '本对话', en: 'This session' },
  'approval.scope.workspace': { zh: '本项目', en: 'This workspace' },
  'approval.source': { zh: '来源：{source}', en: 'Source: {source}' },
  'approval.moreFiles': { zh: '还有 {n} 个文件', en: '+{n} more file(s)' },
  'approval.diffTruncated': { zh: '…（diff 已截断）', en: '… (diff truncated)' },
  'approval.noChoices': { zh: '这个请求没有可选项。', en: 'No choices available for this prompt.' },
  'approval.formUnsupported': { zh: '这个表单有手机端不支持的字段，请在电脑上填写；这里只能拒绝或取消。', en: 'This form has fields that must be completed on the computer. You can decline or cancel it here.' },
  'approval.yes': { zh: '是', en: 'Yes' },
  'approval.no': { zh: '否', en: 'No' },
  'approval.enterNumber': { zh: '输入数字', en: 'Enter a number' },
  'approval.enterInteger': { zh: '输入整数', en: 'Enter an integer' },
  'approval.fieldRequired': { zh: '请填写「{field}」', en: 'Please enter a value for {field}.' },
  'approval.fieldInvalidNumber': { zh: '「{field}」必须是数字', en: '{field} must be a valid number.' },
  'approval.fieldInvalidInteger': { zh: '「{field}」必须是整数', en: '{field} must be a valid integer.' },

  // Files & Git
  'files.title': { zh: '文件', en: 'Files' },
  'files.tab.git': { zh: '改动', en: 'Changes' },
  'files.tab.thread': { zh: '本对话', en: 'This chat' },
  'files.tab.browse': { zh: '浏览', en: 'Browse' },
  'files.branch': { zh: '分支 {branch} · {n} 个文件有改动', en: 'Branch {branch} · {n} changed' },
  'files.clean': { zh: '工作区没有未提交的改动', en: 'No uncommitted changes' },
  'files.notRepo': { zh: '当前工作区不是 Git 仓库', en: 'This workspace is not a Git repository' },
  'files.noThreadChanges': { zh: '这个对话还没有改动文件', en: 'No file changes in this chat yet' },
  'files.emptyDir': { zh: '空文件夹', en: 'Empty folder' },
  'files.up': { zh: '上一级', en: 'Up one level' },
  'files.noDiff': { zh: '（没有 diff 输出）', en: '(No diff output)' },
  'files.diffUnavailable': { zh: '（无法显示 diff）', en: '(Diff unavailable)' },
  'files.truncated': {
    zh: '只显示前 {shown} 行，共 {total} 行。完整内容请在电脑上查看。',
    en: 'Showing the first {shown} of {total} lines. Open it on the computer to see the rest.',
  },

  // Hosts
  'hosts.title': { zh: '电脑', en: 'Computers' },
  'hosts.welcome': { zh: '连接你的电脑', en: 'Connect your computer' },
  'hosts.welcomeHint': {
    zh: '在电脑上打开 Pi Desktop →「手机远控」，开启服务后生成二维码，用这里扫码即可。',
    en: 'On your computer open Pi Desktop → Phone remote, turn it on and generate a QR code, then scan it here.',
  },
  'hosts.scan': { zh: '扫码配对', en: 'Scan QR code' },
  'hosts.pasteToggle': { zh: '改用配对链接', en: 'Use a pairing link instead' },
  'hosts.pastePlaceholder': { zh: '粘贴 pidesktop://pair?… 或电脑地址', en: 'Paste pidesktop://pair?… or an address' },
  'hosts.codePlaceholder': { zh: '一次性配对码', en: 'One-time pairing code' },
  'hosts.pair': { zh: '连接', en: 'Connect' },
  'hosts.pairing': { zh: '正在配对…', en: 'Pairing…' },
  'hosts.paired': { zh: '已配对的电脑', en: 'Paired computers' },
  'hosts.addAnother': { zh: '添加电脑', en: 'Add a computer' },
  'hosts.readOnly': { zh: '只读', en: 'Read-only' },
  'hosts.via': { zh: '通过{route}连接', en: 'via {route}' },
  'hosts.routes': { zh: '{n} 条线路', en: '{n} route(s)' },
  'hosts.inUse': { zh: '使用中', en: 'In use' },
  'hosts.auto': { zh: '自动', en: 'auto' },
  'hosts.connect': { zh: '连接', en: 'Connect' },
  'hosts.disconnect': { zh: '断开', en: 'Disconnect' },
  'hosts.forget': { zh: '移除这台电脑', en: 'Remove this computer' },
  'hosts.forgetTitle': { zh: '移除电脑？', en: 'Remove computer?' },
  'hosts.forgetBody': { zh: '这台手机将不再保存 {name} 的连接信息。', en: 'This phone will forget {name}.' },
  'hosts.addRoute': { zh: '添加线路', en: 'Add route' },
  'hosts.addRoutePlaceholder': { zh: '线路地址（局域网 / Tailscale / 隧道）', en: 'Route URL (LAN / Tailscale / tunnel)' },
  'hosts.addRouteHttpsPlaceholder': { zh: 'HTTPS 线路地址（https://…）', en: 'HTTPS route URL (https://…)' },
  'hosts.routesHint': {
    zh: '支持局域网、Tailscale HTTPS 和 Cloudflare 隧道，会自动优先使用更快的线路；通过 HTTPS 配对的电脑只在 HTTPS 线路之间切换。',
    en: 'LAN, Tailscale HTTPS and Cloudflare Tunnel are supported. Faster routes are preferred automatically; HTTPS-paired computers only switch between HTTPS routes.',
  },
  'hosts.full': { zh: '完全控制', en: 'Full control' },
  'hosts.cancelConnect': { zh: '取消连接', en: 'Cancel' },
  'hosts.cancelReconnect': { zh: '停止重连', en: 'Stop reconnecting' },
  'hosts.openChats': { zh: '查看对话', en: 'Open chats' },
  'hosts.invalidRoute': { zh: '线路无效', en: 'Invalid route' },
  'hosts.pairConfirmTitle': { zh: '连接这台电脑？', en: 'Pair with this computer?' },
  'hosts.pairConfirmBody': { zh: '将与 {name} 配对。', en: 'Connect to {name}?' },
  'hosts.pairConfirm': { zh: '配对', en: 'Pair' },
  'hosts.pairFailed': { zh: '配对失败', en: 'Pairing failed' },

  // QR scanner
  'qr.title': { zh: '扫描配对二维码', en: 'Scan pairing QR code' },
  'qr.permission': { zh: '需要相机权限才能扫描电脑上的配对二维码。', en: 'Camera access is needed to scan the pairing QR code.' },
  'qr.permissionDenied': {
    zh: '相机权限已被拒绝。请在系统设置中开启相机权限后再扫描二维码。',
    en: 'Camera access was denied. Enable Camera permission in system settings to scan QR codes.',
  },
  'qr.grant': { zh: '允许使用相机', en: 'Allow camera' },
  'qr.openSettings': { zh: '打开系统设置', en: 'Open Settings' },
  'qr.hint': { zh: '对准 Pi Desktop「手机远控」里的二维码', en: 'Point at the QR code in Pi Desktop → Phone remote' },
} as const satisfies Record<string, Record<Locale, string>>;

export type MessageKey = keyof typeof MESSAGES;

export function t(key: MessageKey, vars?: Readonly<Record<string, string | number>>): string {
  const text: string = MESSAGES[key][locale];
  return vars ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : text;
}

const THINKING_LABELS: Record<UiThinkingLevel, Record<Locale, string>> = {
  off: { zh: '关闭', en: 'Off' },
  minimal: { zh: '极简', en: 'Minimal' },
  low: { zh: '低', en: 'Low' },
  medium: { zh: '中', en: 'Medium' },
  high: { zh: '高', en: 'High' },
  xhigh: { zh: '极高', en: 'Extra high' },
  max: { zh: '最高', en: 'Max' },
};

export function thinkingLabel(level: UiThinkingLevel): string {
  return THINKING_LABELS[level]?.[locale] ?? level;
}

/** "Just now", "5 min ago", "Yesterday", then a short date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return t('time.now');
  if (minutes < 60) return t('time.minutes', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hours', { n: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t('time.yesterday');
  if (days < 7) return t('time.days', { n: days });
  const date = new Date(time);
  return locale === 'zh' ? `${date.getMonth() + 1}月${date.getDate()}日` : date.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}
