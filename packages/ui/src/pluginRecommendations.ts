import type { UiPluginPackage } from '@pidesktop/shared';
import type { IconName } from './components/Icons';

/** 插件页「推荐」栏的精选清单：均为日常在用、验证过的社区扩展包。来源与安装对话框的输入格式一致。 */
export interface PluginRecommendation {
	source: string;
	name: string;
	author: string;
	icon: IconName;
	category: { 'zh-CN': string; 'en-US': string };
	description: { 'zh-CN': string; 'en-US': string };
}

export const PLUGIN_RECOMMENDATIONS: readonly PluginRecommendation[] = [
	{ source: 'npm:pi-subagents@0.75.0', name: 'pi-subagents', author: 'Nico Bailon', icon: 'plugins', category: { 'zh-CN': '多代理', 'en-US': 'Agents' }, description: { 'zh-CN': '把任务委派给子代理，或用脚本编排多代理协作流程。', 'en-US': 'Single-agent delegation and scripted multi-agent workflows.' } },
	{ source: 'npm:pi-mcp-adapter', name: 'pi-mcp-adapter', author: 'Nico Bailon', icon: 'plugins', category: { 'zh-CN': '集成', 'en-US': 'Integration' }, description: { 'zh-CN': '接入 MCP（Model Context Protocol）服务器，让 Pi 调用外部工具。', 'en-US': 'Model Context Protocol adapter: use MCP servers as Pi tools.' } },
	{ source: 'npm:pi-web-access', name: 'pi-web-access', author: 'Nico Bailon', icon: 'globe', category: { 'zh-CN': '联网', 'en-US': 'Web' }, description: { 'zh-CN': '网页搜索、抓取 URL、克隆 GitHub 仓库、解析 PDF 与视频，支持多家搜索服务。', 'en-US': 'Web search, URL fetching, GitHub cloning, PDF and video understanding across many providers.' } },
	{ source: 'npm:@ff-labs/pi-fff', name: '@ff-labs/pi-fff', author: 'ff-labs', icon: 'search', category: { 'zh-CN': '搜索', 'en-US': 'Search' }, description: { 'zh-CN': '基于 FFF 的模糊文件名与内容搜索，大仓库里也能快速定位。', 'en-US': 'FFF-powered fuzzy file and content search.' } },
	{ source: 'npm:pi-observational-memory', name: 'pi-observational-memory', author: 'elpapi42', icon: 'spark', category: { 'zh-CN': '记忆', 'en-US': 'Memory' }, description: { 'zh-CN': '观察式记忆：分层压缩上下文，保留观察与反思，对缓存友好。', 'en-US': 'Cache-friendly tiered compaction with observations and reflections.' } },
	{ source: 'npm:pi-goal-x', name: 'pi-goal-x', author: 'pi-goal-x contributors', icon: 'check', category: { 'zh-CN': '规划', 'en-US': 'Planning' }, description: { 'zh-CN': '新增 /goal：对话式目标规划、持久化进度，并由独立审计确认完成。', 'en-US': 'Adds /goal: conversational goal planning, persistent progress and an independent completion auditor.' } },
	{ source: 'npm:@99percentpeople/pi-todo', name: '@99percentpeople/pi-todo', author: '99percentpeople', icon: 'check', category: { 'zh-CN': '规划', 'en-US': 'Planning' }, description: { 'zh-CN': '轻量待办工具：支持依赖关系，压缩后状态不丢失，附只读面板。', 'en-US': 'Minimal atomic todo tool with dependencies, compaction-safe state and a read-only widget.' } },
	{ source: 'npm:@juicesharp/rpiv-ask-user-question', name: '@juicesharp/rpiv-ask-user-question', author: 'juicesharp', icon: 'message', category: { 'zh-CN': '交互', 'en-US': 'Interaction' }, description: { 'zh-CN': '模型拿不准时向你发起结构化提问，用选项作答而不是让它猜。', 'en-US': 'A structured questionnaire the model asks instead of guessing, with typed options.' } },
	{ source: 'npm:pi-tool-display', name: 'pi-tool-display', author: 'MasuRii', icon: 'settings', category: { 'zh-CN': '显示', 'en-US': 'Display' }, description: { 'zh-CN': '精简工具调用的渲染：折叠、截断冗长输出，并可视化 diff。', 'en-US': 'Compact tool call rendering, diff visualization and output truncation.' } },
];

/** npm 来源去掉前缀和版本后的包名，用于判断推荐项是否已安装（不区分版本）。 */
export function npmPackageName(source: string): string | null {
	if (!source.startsWith('npm:')) return null;
	return /^(@[^/@]+\/[^@]+|[^@]+)/.exec(source.slice(4))?.[1] ?? null;
}

export function installedRecommendation(packages: readonly UiPluginPackage[] | undefined, item: PluginRecommendation): UiPluginPackage | undefined {
	const name = npmPackageName(item.source);
	return packages?.find((entry) => entry.installed && npmPackageName(entry.source) === name);
}
