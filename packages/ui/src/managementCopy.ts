import type { Locale } from './i18n';

const en = {
	running: 'Running', waiting: 'Needs attention', 'waiting-input': 'Waiting for input', 'waiting-approval': 'Waiting for approval', failed: 'Failed', unread: 'Unread',
	loadFailed: 'Could not load conversations', retry: 'Retry',
	deleteTitle: 'Delete this conversation permanently?', deleteHint: 'The conversation file will be deleted immediately, matching the native pi CLI. This cannot be undone; project files are not touched.',
	remove: 'Delete permanently', deleting: 'Deleting…', deleted: 'Conversation deleted', cancel: 'Cancel',
	latestRun: 'Latest run', neverRun: 'No runs yet', resultFilter: 'Run result', allResults: 'All results',
	taskSection: 'What to do', projectSection: 'Where to run', timeSection: 'When to run', options: 'Model and reasoning options',
	plan: 'Schedule', invalidPlan: 'Complete the schedule fields to see a summary',
	path: 'File path', copyPath: 'Copy path', copied: 'Path copied', copyFailed: 'Could not copy path', errors: 'Errors', resources: 'Resources',
};
const zh: typeof en = {
	running: '运行中', waiting: '待处理', 'waiting-input': '等待输入', 'waiting-approval': '等待授权', failed: '失败', unread: '未读',
	loadFailed: '无法加载会话', retry: '重试',
	deleteTitle: '永久删除这个会话？', deleteHint: '与原生 pi CLI 一致，会话文件将被直接删除，无法撤销；不影响项目文件。',
	remove: '永久删除', deleting: '正在删除…', deleted: '会话已删除', cancel: '取消',
	latestRun: '最近运行', neverRun: '尚未运行', resultFilter: '运行结果', allResults: '全部结果',
	taskSection: '做什么', projectSection: '在哪做', timeSection: '何时做', options: '模型与思考选项',
	plan: '执行计划', invalidPlan: '填写完整时间设置后显示计划摘要',
	path: '文件路径', copyPath: '复制路径', copied: '路径已复制', copyFailed: '复制路径失败', errors: '错误', resources: '资源',
};
export const managementCopy = (locale: Locale) => locale === 'zh-CN' ? zh : en;
