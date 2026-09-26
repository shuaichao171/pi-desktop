import type { UiToolActivity } from '@pidesktop/shared';
import type { Locale } from './i18n';

const ACTIONS: Record<string, readonly [string, string]> = {
  read: ['读取', 'Read'],
  edit: ['编辑', 'Edit'],
  write: ['写入', 'Write'],
  bash: ['执行', 'Run'],
  grep: ['搜索', 'Search'],
  find: ['查找', 'Find'],
  ls: ['列出', 'List'],
};

export function activityPresentation(activity: UiToolActivity, locale: Locale) {
  const prefix = `${activity.tool}(`;
  const title = activity.title.startsWith(prefix) && activity.title.endsWith(')')
    ? activity.title.slice(prefix.length, -1)
    : activity.title === activity.tool ? '' : activity.title;
  return {
    label: ACTIONS[activity.tool]?.[locale === 'zh-CN' ? 0 : 1] ?? activity.tool,
    summary: (activity.command || title || activity.files?.join(', ') || '').replace(/\s+/g, ' ').trim(),
  };
}

export function activityCopy(locale: Locale) {
  return locale === 'zh-CN'
    ? { command: '命令', copyCommand: '复制完整命令', wrapCommand: '切换命令自动换行' }
    : { command: 'Command', copyCommand: 'Copy full command', wrapCommand: 'Toggle command line wrapping' };
}
