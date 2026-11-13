/**
 * desktop-cua — built-in Pi extension exposing computer-use tools.
 *
 * Architecture follows the Codex/Claude/zcode references:
 *   - one tool per primitive (screenshot / mouse / keyboard / clipboard /
 *     windows) grouped under the cua_ prefix,
 *   - a session-level switch (/cua on|off) gates every tool at runtime,
 *   - coordinates are always original-screen physical pixels; screenshots
 *     may be downscaled for transport but report their scale factor,
 *   - typing goes through the clipboard + Ctrl+V (layout-safe, Claude's
 *     approach), with best-effort clipboard restore.
 *
 * Windows implements everything through the Win32 backend (koffi). Other
 * platforms fail closed. Building the extension never loads native code: the
 * backend is resolved inside each tool call, so sessions start normally even
 * when koffi is unavailable.
 */

import { Type } from 'typebox';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import {
	type CuaBackend,
	CuaSessionState,
	cuaNotEnabledMessage,
	encodeImage,
	getBackend,
	isCuaSupported,
	parseKeys,
	UNSUPPORTED_PLATFORM_MESSAGE,
} from './core.ts';

const CUA_TOOL_PREFIX = 'cua_';
const READ_ONLY_ANNOTATIONS = { readOnlyHint: true } as const;
const ACTION_ANNOTATIONS = { destructiveHint: true, openWorldHint: true } as const;

const COORDINATE_CONVENTION =
	'坐标约定：所有坐标均为屏幕物理像素，原点在主显示器左上角（多显示器向右下延伸，可能为负值）；点击、拖拽、输入使用的坐标必须基于最近一次截图的原始分辨率，而不是编码后图片的像素。';

export interface CuaExtensionOptions {
	/** State holder shared between the extension and the desktop host. */
	state?: CuaSessionState;
}

export function cuaExtension(options: CuaExtensionOptions = {}): ExtensionFactory {
	const state = options.state ?? new CuaSessionState();
	return (pi) => {
		const requireEnabled = (): CuaBackend => {
			if (!state.enabled) throw new Error(cuaNotEnabledMessage());
			if (!isCuaSupported()) throw new Error(UNSUPPORTED_PLATFORM_MESSAGE);
			return getBackend();
		};

		// Runtime gate: every cua_* call checks the session switch. Runs after
		// argument validation like the other inline extensions.
		pi.on('tool_call', async (event) => {
			if (!event.toolName.startsWith(CUA_TOOL_PREFIX)) return;
			if (!state.enabled) {
				return { block: true, reason: cuaNotEnabledMessage() };
			}
			return undefined;
		});

		pi.registerCommand('cua', {
			description: 'computer-use 开关（/cua on|off，不带参数查看状态）',
			getArgumentCompletions: (prefix) =>
				['on', 'off'].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
			handler: async (args, ctx) => {
				const action = args.trim().toLowerCase();
				if (action === 'off') {
					state.enabled = false;
					ctx.ui.notify('computer-use 已关闭', 'info');
					return;
				}
				if (action === 'on') {
					if (!isCuaSupported()) {
						state.enabled = false;
						ctx.ui.notify(UNSUPPORTED_PLATFORM_MESSAGE, 'warning');
						return;
					}
					// Probe the native layer up front so a broken install fails here, not mid-task.
					try {
						getBackend().virtualScreen();
					} catch (error) {
						state.enabled = false;
						ctx.ui.notify(`computer-use 无法开启：${error instanceof Error ? error.message : String(error)}`, 'error');
						return;
					}
					state.enabled = true;
					ctx.ui.notify('computer-use 已开启：点击/输入等操作将直接作用于桌面，请留意模型行为', 'warning');
					return;
				}
				ctx.ui.notify(
					`computer-use：${state.enabled ? '已开启' : '未开启'}（/cua on 开启，/cua off 关闭）${
						isCuaSupported() ? '' : `；${UNSUPPORTED_PLATFORM_MESSAGE}`
					}`,
					'info',
				);
			},
		});

		// -------------------------------------------------------------------
		// Screenshot
		// -------------------------------------------------------------------

		pi.registerTool({
			name: 'cua_screenshot',
			label: '截屏',
			description: `截取屏幕（默认整个虚拟桌面，可指定区域）。返回图片与分辨率信息；多显示器时坐标可能为负。${COORDINATE_CONVENTION}`,
			promptSnippet: '截屏并查看屏幕内容',
			parameters: Type.Object({
				x: Type.Optional(Type.Number({ description: '区域左上角 X（物理像素，缺省=整桌面）' })),
				y: Type.Optional(Type.Number({ description: '区域左上角 Y' })),
				width: Type.Optional(Type.Number({ description: '区域宽度' })),
				height: Type.Optional(Type.Number({ description: '区域高度' })),
				maxWidth: Type.Optional(Type.Number({ description: '编码图片最大宽度（默认 1600，超出会双线性缩小，坐标仍按原始分辨率）' })),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params) => {
				const backend = requireEnabled();
				const hasRegion = params.x !== undefined || params.y !== undefined || params.width !== undefined || params.height !== undefined;
				if (hasRegion && (params.x === undefined || params.y === undefined || params.width === undefined || params.height === undefined)) {
					throw new Error('指定截屏区域时 x/y/width/height 必须同时提供');
				}
				const capture = backend.capture(
					hasRegion
						? { x: Math.round(params.x!), y: Math.round(params.y!), width: Math.round(params.width!), height: Math.round(params.height!) }
						: undefined,
				);
				const image = encodeImage(capture.bgra, capture.width, capture.height, {
					maxWidth: typeof params.maxWidth === 'number' ? params.maxWidth : undefined,
				});
				state.lastScreenshot = { width: capture.width, height: capture.height, scale: image.scale };
				const cursor = safeCursor(backend);
				const text =
					`截图成功：原始分辨率 ${capture.width}×${capture.height}，编码 ${image.format.toUpperCase()} ${image.width}×${image.height}` +
					`(scale=${image.scale.toFixed(2)})；光标 (${cursor?.x ?? '?'},${cursor?.y ?? '?'})。${COORDINATE_CONVENTION}`;
				return {
					content: [
						{ type: 'image', data: image.data, mimeType: image.mimeType } satisfies ImageContent,
						{ type: 'text', text } satisfies TextContent,
					],
					details: { width: capture.width, height: capture.height, encoded: { width: image.width, height: image.height, scale: image.scale, format: image.format } },
				};
			},
		});

		// -------------------------------------------------------------------
		// Mouse
		// -------------------------------------------------------------------

		pi.registerTool({
			name: 'cua_mouse_move',
			label: '移动鼠标',
			description: '将鼠标移动到屏幕物理像素坐标 (x, y)。',
			parameters: Type.Object({
				x: Type.Number({ description: '目标 X（物理像素）' }),
				y: Type.Number({ description: '目标 Y（物理像素）' }),
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params) => {
				const backend = requireEnabled();
				backend.mouseMove(Math.round(params.x), Math.round(params.y));
				return textResult(`鼠标已移动到 (${Math.round(params.x)}, ${Math.round(params.y)})`, { x: params.x, y: params.y });
			},
		});

		const clickTool = (
			name: string,
			label: string,
			description: string,
			button: 'left' | 'right' | 'middle',
			doubleClick = false,
		): void => {
			pi.registerTool({
				name,
				label,
				description,
				parameters: Type.Object({
					x: Type.Optional(Type.Number({ description: '点击 X（缺省=当前位置）' })),
					y: Type.Optional(Type.Number({ description: '点击 Y（缺省=当前位置）' })),
				}),
				annotations: ACTION_ANNOTATIONS,
				executionMode: 'sequential',
				execute: async (_id, params) => {
					const backend = requireEnabled();
					if ((params.x === undefined) !== (params.y === undefined)) throw new Error('x 与 y 需要同时提供（都不传则点击当前位置）');
					const x = params.x === undefined ? undefined : Math.round(params.x);
					const y = params.y === undefined ? undefined : Math.round(params.y);
					backend.mouseClick(button, x, y, doubleClick);
					const at = x === undefined || y === undefined ? '当前位置' : `(${x}, ${y})`;
					return textResult(`${label}完成：${at}`, { button, x, y, doubleClick });
				},
			});
		};

		clickTool('cua_left_click', '左键单击', '在指定位置（或当前鼠标位置）执行左键单击。', 'left');
		clickTool('cua_double_click', '左键双击', '在指定位置（或当前鼠标位置）执行左键双击。', 'left', true);
		clickTool('cua_right_click', '右键单击', '在指定位置（或当前鼠标位置）执行右键单击（打开上下文菜单）。', 'right');

		pi.registerTool({
			name: 'cua_drag',
			label: '拖拽',
			description: '按住左键从 (fromX, fromY) 拖拽到 (toX, toY)，用于移动窗口、滑块或选区。',
			parameters: Type.Object({
				fromX: Type.Number({ description: '起点 X（物理像素）' }),
				fromY: Type.Number({ description: '起点 Y' }),
				toX: Type.Number({ description: '终点 X' }),
				toY: Type.Number({ description: '终点 Y' }),
				durationMs: Type.Optional(Type.Number({ description: '拖拽时长毫秒（默认 350，范围 50–5000）' })),
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params, signal) => {
				const backend = requireEnabled();
				await backend.mouseDrag(
					Math.round(params.fromX),
					Math.round(params.fromY),
					Math.round(params.toX),
					Math.round(params.toY),
					params.durationMs ?? 350,
					signal,
				);
				return textResult(`拖拽完成：(${params.fromX}, ${params.fromY}) → (${params.toX}, ${params.toY})`, {
					from: { x: params.fromX, y: params.fromY },
					to: { x: params.toX, y: params.toY },
				});
			},
		});

		pi.registerTool({
			name: 'cua_scroll',
			label: '滚轮',
			description: '在当前鼠标位置滚动滚轮（需要时先 cua_mouse_move 到目标区域）。amount 为格数：正数向下/右，负数向上/左。',
			parameters: Type.Object({
				amount: Type.Number({ description: '滚动格数（正=向下，负=向上；水平时正=向右）' }),
				horizontal: Type.Optional(Type.Boolean({ description: 'true=水平滚轮（默认 false）' })),
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params) => {
				const backend = requireEnabled();
				backend.mouseScroll(params.amount, params.horizontal === true);
				return textResult(`滚动 ${params.amount > 0 ? '+' : ''}${params.amount} 格${params.horizontal === true ? '（水平）' : ''}`, {
					amount: params.amount,
					horizontal: params.horizontal === true,
				});
			},
		});

		// -------------------------------------------------------------------
		// Keyboard
		// -------------------------------------------------------------------

		pi.registerTool({
			name: 'cua_type',
			label: '输入文本',
			description: '向当前焦点窗口输入文本（通过剪贴板+Ctrl+V 粘贴，支持任意语言与特殊字符；输入前会尽量保存并事后恢复文本剪贴板）。适合表单、地址栏、编辑器。',
			promptGuidelines: ['需要输入较长或非英文文本时使用 cua_type；单个按键或组合键用 cua_key。'],
			parameters: Type.Object({
				text: Type.String({ description: '要输入的文本' }),
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params, signal) => {
				const backend = requireEnabled();
				if (!params.text.length) throw new Error('text 不能为空');
				if (params.text.length > 20000) throw new Error('text 过长（上限 20000 字符，请分段输入）');
				await backend.typeText(params.text, signal);
				return textResult(`已输入 ${params.text.length} 字符（剪贴板粘贴式）`, { length: params.text.length });
			},
		});

		pi.registerTool({
			name: 'cua_key',
			label: '按键',
			description: '按下按键或组合键，例如 "enter"、"ctrl+a"、"ctrl+shift+t"、"alt+f4"、"win"。组合键用 + 连接且只能有一个主键，修饰键自动按下和释放；+ 键本身写作 "plus"。',
			parameters: Type.Object({
				keys: Type.String({ description: '按键序列，如 "enter" 或 "ctrl+shift+t"' }),
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params) => {
				const backend = requireEnabled();
				const parsed = parseKeys(params.keys);
				backend.tapChord(parsed.modifiers, parsed.key);
				return textResult(`已按下：${params.keys}`, { keys: params.keys, modifiers: parsed.modifiers, key: parsed.key });
			},
		});

		// -------------------------------------------------------------------
		// Clipboard
		// -------------------------------------------------------------------

		pi.registerTool({
			name: 'cua_read_clipboard',
			label: '读剪贴板',
			description: '读取系统剪贴板文本（无文本时返回空）。',
			parameters: Type.Object({}),
			annotations: READ_ONLY_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async () => {
				const backend = requireEnabled();
				const text = await backend.readClipboard();
				return textResult(text === null ? '剪贴板没有文本内容' : truncate(text, 8000), { length: text?.length ?? 0 });
			},
		});

		pi.registerTool({
			name: 'cua_write_clipboard',
			label: '写剪贴板',
			description: '把文本写入系统剪贴板。',
			parameters: Type.Object({
				text: Type.String({ description: '要写入的文本' }),
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params) => {
				const backend = requireEnabled();
				if (params.text.length > 100000) throw new Error('text 过长（上限 100000 字符）');
				await backend.writeClipboard(params.text);
				return textResult(`已写入剪贴板 ${params.text.length} 字符`, { length: params.text.length });
			},
		});

		// -------------------------------------------------------------------
		// Windows
		// -------------------------------------------------------------------

		pi.registerTool({
			name: 'cua_list_windows',
			label: '枚举窗口',
			description: '列出当前可见的顶层窗口（标题、进程 PID、位置、是否最小化/前台）。用于定位目标后再 cua_activate_window 或直接点击。',
			parameters: Type.Object({
				titleContains: Type.Optional(Type.String({ description: '按标题子串过滤' })),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params) => {
				const backend = requireEnabled();
				const { windows, truncated } = backend.listWindows();
				const needle = params.titleContains?.toLowerCase();
				const filtered = needle ? windows.filter((w) => w.title.toLowerCase().includes(needle)) : windows;
				const lines = filtered.map(
					(w) =>
						`hwnd=${w.hwnd} pid=${w.pid} [${w.x},${w.y} ${w.width}x${w.height}]${w.minimized ? ' (最小化)' : ''}${w.foreground ? ' *前台*' : ''} ${JSON.stringify(w.title)}`,
				);
				const note = truncated ? '\n（窗口过多，仅列出前面一部分；可用 titleContains 过滤）' : '';
				return textResult(lines.length ? `共 ${filtered.length} 个窗口：\n${lines.join('\n')}${note}` : `没有匹配的窗口${note}`, {
					count: filtered.length,
					truncated,
					windows: filtered.map((w) => ({ hwnd: w.hwnd, pid: w.pid, title: w.title })),
				});
			},
		});

		pi.registerTool({
			name: 'cua_activate_window',
			label: '激活窗口',
			description: '把窗口带到前台（必要时先还原最小化）。hwnd 来自 cua_list_windows，也可传标题精确/唯一匹配。',
			parameters: Type.Object({
				hwnd: Type.Optional(Type.Number({ description: '窗口句柄（来自 cua_list_windows）' })),
				title: Type.Optional(Type.String({ description: '窗口标题（精确优先，其次唯一子串匹配）' })),
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params) => {
				const backend = requireEnabled();
				let handle = params.hwnd;
				let matchedTitle: string | null = null;
				if (handle === undefined) {
					const title = params.title;
					if (!title) throw new Error('需要提供 hwnd 或 title');
					const { windows } = backend.listWindows();
					const exact = windows.find((w) => w.title === title);
					const candidates = exact ? [exact] : windows.filter((w) => w.title.toLowerCase().includes(title.toLowerCase()));
					if (candidates.length !== 1) {
						throw new Error(`标题匹配到 ${candidates.length} 个窗口（需要唯一匹配；请用 cua_list_windows 取 hwnd）`);
					}
					handle = candidates[0].hwnd;
					matchedTitle = candidates[0].title;
				}
				const ok = await backend.activateWindow(handle);
				if (!ok) throw new Error('SetForegroundWindow 失败（系统限制后台进程抢焦点；可改为直接点击目标窗口或任务栏按钮）');
				return textResult(`已激活窗口 hwnd=${handle}${matchedTitle ? `（${matchedTitle}）` : ''}`, { hwnd: handle });
			},
		});

		// -------------------------------------------------------------------
		// Wait
		// -------------------------------------------------------------------

		pi.registerTool({
			name: 'cua_wait',
			label: '等待',
			description: '等待指定毫秒（等待动画、加载、消抖），上限 30000ms。',
			parameters: Type.Object({
				ms: Type.Number({ description: '等待毫秒数（50–30000）' }),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params, signal) => {
				requireEnabled();
				const ms = Math.min(Math.max(Math.round(params.ms), 50), 30000);
				await abortableDelay(ms, signal);
				return textResult(`已等待 ${ms}ms`, { ms });
			},
		});
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string, details: unknown) {
	return { content: [{ type: 'text', text } as TextContent], details };
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，原长 ${text.length} 字符）`;
}

function safeCursor(backend: CuaBackend): { x: number; y: number } | null {
	try {
		return backend.cursorPosition();
	} catch {
		return null;
	}
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('已中止'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('已中止'));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
