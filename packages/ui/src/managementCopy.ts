import type { Locale } from './i18n';

const en = {
	running: 'Running', waiting: 'Needs attention', 'waiting-input': 'Waiting for input', 'waiting-approval': 'Waiting for approval', failed: 'Failed', unread: 'Unread',
	refreshing: 'Refreshing…', loadFailed: 'Could not load conversations', retry: 'Retry',
	trashTitle: 'Move conversation to trash?', trashHint: 'The conversation will be moved to the app’s trash. Its project files will not be deleted.',
	trash: 'Move to trash', deleting: 'Moving…', deleted: 'Conversation moved to trash', cancel: 'Cancel',
	latestRun: 'Latest run', neverRun: 'No runs yet', resultFilter: 'Run result', allResults: 'All results',
	taskSection: 'What to do', projectSection: 'Where to run', timeSection: 'When to run', options: 'Model and reasoning options',
	plan: 'Schedule', invalidPlan: 'Complete the schedule fields to see a summary',
	path: 'File path', copyPath: 'Copy path', copied: 'Path copied', copyFailed: 'Could not copy path', errors: 'Errors', resources: 'Resources',
};
const zh: typeof en = {
	running: '运行中', waiting: '待处理', 'waiting-input': '等待输入', 'waiting-approval': '等待授权', failed: '失败', unread: '未读',
	refreshing: '正在刷新…', loadFailed: '无法加载会话', retry: '重试',
	trashTitle: '将会话移入回收站？', trashHint: '会话将移入应用回收站，不会删除项目文件。',
	trash: '移入回收站', deleting: '正在移动…', deleted: '会话已移入回收站', cancel: '取消',
	latestRun: '最近运行', neverRun: '尚未运行', resultFilter: '运行结果', allResults: '全部结果',
	taskSection: '做什么', projectSection: '在哪做', timeSection: '何时做', options: '模型与思考选项',
	plan: '执行计划', invalidPlan: '填写完整时间设置后显示计划摘要',
	path: '文件路径', copyPath: '复制路径', copied: '路径已复制', copyFailed: '复制路径失败', errors: '错误', resources: '资源',
};
export const managementCopy = (locale: Locale) => locale === 'zh-CN' ? zh : en;
