/**
 * desktop-cua — built-in Pi extension exposing computer-use tools.
 *
 * Architecture follows the Codex/Claude/zcode references:
 *   - one tool per primitive (screenshot / mouse / keyboard / clipboard /
 *     windows) grouped under the cua_ prefix,
 *   - first use requests consent for this conversation; /cua on|off can override it,
 *   - coordinates are always original-screen physical pixels; screenshots
 *     may be downscaled for transport but report their scale factor,
 *   - typing goes through the clipboard + Ctrl+V (layout-safe, Claude's
 *     approach), with best-effort clipboard restore,
 *   - failures are typed CuaErrors (`CUA <code> (actionSent=…)`), coordinate
 *     actions can pin the frame they were derived from (zcode semantics),
 *     injection is refused on locked screens, and held modifier keys are
 *     force-released when control ends.
 *   - v2 (zcode accessibility-first + window scope): cua_get_state reads a
 *     window's UIA tree into indexed element rows (koffi COM vtable calls,
 *     read-only), coordinate actions accept element indexes that resolve
 *     against the latest observation with window-move validation, and
 *     cua_screenshot can capture a single window (PrintWindow) with its
 *     rectangle pinned into the frame record.
 *
 * Windows implements everything through the Win32 backend (koffi). Other
 * platforms fail closed. Building the extension never loads native code: the
 * native bindings are resolved only after consent, so sessions start normally
 * even when koffi is unavailable.
 */

import { Type } from 'typebox';
import type { ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import {
	type CuaBackend,
	CuaSessionState,
	cuaNotEnabledMessage,
	encodeImage,
	getBackend,
	parseKeys,
	CuaError,
	UNSUPPORTED_PLATFORM_MESSAGE,
} from './core.ts';
import type { ObservedElement, RawCapture, Rect, UiaElementNode } from './types.ts';
import { CUA_PERMISSION_MESSAGE, CUA_PERMISSION_TITLE, type CuaPermissionStorage } from './permissions.ts';

const CUA_TOOL_PREFIX = 'cua_';
const READ_ONLY_ANNOTATIONS = { readOnlyHint: true } as const;
const ACTION_ANNOTATIONS = { destructiveHint: true, openWorldHint: true } as const;

const COORDINATE_CONVENTION =
	'坐标约定：所有坐标均为屏幕物理像素，原点在主显示器左上角（多显示器向右下延伸，可能为负值）；点击、拖拽、输入使用的坐标必须基于最近一次截图的原始分辨率，而不是编码后图片的像素。';

const FRAME_PARAM = Type.Optional(
	Type.Number({ description: '坐标所依据的截图帧号（cua_screenshot 返回的 frame）：提供时会校验屏幕布局未变化，已变化则拒绝执行；缺省不校验' }),
);

const ELEMENT_PARAM = Type.Optional(
	Type.Number({ description: '元素索引（最近一次 cua_get_state 返回的编号；与 x/y 互斥）：解析为该元素中心坐标并校验窗口未移动' }),
);

export interface CuaExtensionOptions {
	/** State holder shared between the extension and the desktop host. */
	state?: CuaSessionState;
	/** Host-local, conversation-scoped consent, never restored from model messages. */
	permissions?: CuaPermissionStorage;
	/** Optional platform adapter, also used for isolated tests without desktop input. */
	backend?: CuaBackend;
}

export function cuaExtension(options: CuaExtensionOptions = {}): ExtensionFactory {
	const state = options.state ?? new CuaSessionState();
	const backend = options.backend ?? getBackend();
	return (pi) => {
		let denied = false;
		let generation = 0;
		let permissionRequest: Promise<string | undefined> | null = null;
		const supported = backend.platform === 'win32';
		const declinedMessage = '本对话的电脑控制授权已被拒绝或关闭，未执行操作。请停止尝试 CUA；用户可发送 /cua on 重新开启。';
		const cancelledMessage = '电脑控制授权请求已取消，未执行操作。';
		const errorMessage = (error: unknown) => `computer-use 无法开启：${error instanceof Error ? error.message : String(error)}`;
		const enable = (remember: boolean) => {
			if (!supported) throw new Error(UNSUPPORTED_PLATFORM_MESSAGE);
			if (remember) options.permissions?.write(true);
			// Probe only after consent, before allowing the waiting desktop operation.
			backend.virtualScreen();
			denied = false;
			state.enabled = true;
		};
		const requireEnabled = (): CuaBackend => {
			if (!state.enabled) throw new CuaError('PERMISSION_DENIED', cuaNotEnabledMessage());
			if (!supported) throw new CuaError('UNSUPPORTED_PLATFORM', UNSUPPORTED_PLATFORM_MESSAGE);
			return backend;
		};
		const invalid = (detail: string): never => {
			throw new CuaError('INVALID_ARGUMENTS', detail);
		};
		/**
		 * Cheap staleness check for coordinate actions (zcode frame semantics,
		 * layout-only): the frame must be one of the recent screenshots and the
		 * virtual-screen geometry must not have changed since it was taken.
		 */
		const assertFrameFresh = (active: CuaBackend, frame: number | undefined): void => {
			if (frame === undefined) return;
			const record = state.frames.get(frame);
			if (!record) throw new CuaError('STALE_STATE', `未知的截图帧 frame=${frame}（仅保留最近几帧），请重新截屏后再执行坐标操作`);
			const current = active.virtualScreen();
			const prior = record.screen;
			if (prior.x !== current.x || prior.y !== current.y || prior.width !== current.width || prior.height !== current.height) {
				throw new CuaError(
					'STALE_STATE',
					`截图后屏幕布局已变化（截图时虚拟桌面 ${prior.width}×${prior.height} @ (${prior.x},${prior.y})，当前 ${current.width}×${current.height} @ (${current.x},${current.y})），坐标可能失效；请重新截屏`,
				);
			}
			if (record.windowHwnd !== undefined && record.windowRect) {
				const prior = record.windowRect;
				const current = active.windowRect?.(record.windowHwnd);
				if (current && (current.x !== prior.x || current.y !== prior.y || current.width !== prior.width || current.height !== prior.height)) {
					throw new CuaError(
						'STALE_STATE',
						`截图后窗口已移动或改变大小（截图时 [${prior.x},${prior.y} ${prior.width}x${prior.height}]，当前 [${current.x},${current.y} ${current.width}x${current.height}]），窗口内坐标可能失效；请重新截取`,
					);
				}
			}
		};
		/** Common prelude for every input-injecting tool: enabled, unlocked screen, fresh frame. */
		const requireInjectionReady = (frame?: number): CuaBackend => {
			const active = requireEnabled();
			if (active.inputDesktopAccessible && !active.inputDesktopAccessible()) {
					throw new CuaError('SCREEN_LOCKED', '屏幕已锁定或安全桌面（如 UAC 提示框）正在活动，未发送任何输入；请提醒用户解锁屏幕后重试');
			}
			assertFrameFresh(active, frame);
			return active;
		};
		/** Release every held modifier key when control ends (zcode cancelInputHoldsForSession). */
		const releaseModifiersBestEffort = (): void => {
			if (!state.enabled || !supported) return;
			try {
				backend.releaseModifiers?.();
			} catch {
				/* best-effort safety net */
			}
		};

		/** hwnd from an explicit handle, or a unique title match (get_state / activate_window). */
		const resolveWindowHandle = (active: CuaBackend, hwnd: number | undefined, title: string | undefined): number => {
			if (hwnd !== undefined) return hwnd;
			if (!title) throw new CuaError('INVALID_ARGUMENTS', '需要提供 hwnd 或 title');
			const { windows } = active.listWindows();
			const exact = windows.find((w) => w.title === title);
			const candidates = exact ? [exact] : windows.filter((w) => w.title.toLowerCase().includes(title.toLowerCase()));
			if (!candidates.length) throw new CuaError('TARGET_GONE', `没有标题匹配“${title}”的窗口（可能已关闭或改名）；请用 cua_list_windows 重新查看`);
			if (candidates.length > 1) throw new CuaError('AMBIGUOUS_TARGET', `标题匹配到 ${candidates.length} 个窗口（需要唯一匹配；请用 cua_list_windows 取 hwnd）`);
			return candidates[0].hwnd;
		};
		/** Resolve an element index from the latest cua_get_state observation to a click point. */
		const resolveElementPoint = (active: CuaBackend, element: number): { x: number; y: number; label: string } => {
			const observation = state.observation;
			if (!observation) throw new CuaError('STALE_STATE', '没有最近的 cua_get_state 观察结果，无法按元素索引寻址；请先调用 cua_get_state');
			if (!Number.isInteger(element) || element < 0 || element >= observation.flat.length) {
				throw new CuaError('ELEMENT_UNAVAILABLE', `元素索引 ${element} 不在最近观察中（该观察共 ${observation.flat.length} 个元素）；请重新 cua_get_state 后使用新索引`);
			}
			const target = observation.flat[element];
			const prior = observation.rect;
			const current = active.windowRect?.(observation.hwnd);
			if (!current) throw new CuaError('INTERNAL', '当前后端无法校验窗口位置');
			if (current.x !== prior.x || current.y !== prior.y || current.width !== prior.width || current.height !== prior.height) {
				throw new CuaError('STALE_STATE', `观察后窗口已移动或改变大小（观察时 [${prior.x},${prior.y} ${prior.width}x${prior.height}]，当前 [${current.x},${current.y} ${current.width}x${current.height}]）；请重新 cua_get_state`);
			}
			if (!target.rect) throw new CuaError('ELEMENT_UNAVAILABLE', `元素 [${element}]（${target.role}）没有可见矩形，无法定位；请用 cua_screenshot 以坐标方式操作`);
			if (target.offscreen) throw new CuaError('ELEMENT_UNAVAILABLE', `元素 [${element}]（${target.role}${target.name ? ` ${JSON.stringify(target.name)}` : ''}）在屏幕外；先滚动或调整窗口使其可见`);
			const x = Math.min(Math.max(Math.round(target.rect.x + target.rect.width / 2), prior.x), prior.x + prior.width - 1);
			const y = Math.min(Math.max(Math.round(target.rect.y + target.rect.height / 2), prior.y), prior.y + prior.height - 1);
			return { x, y, label: `[${element}] ${target.role}${target.name ? ` ${JSON.stringify(target.name)}` : ''}` };
		};

		async function authorize(ctx?: ExtensionContext): Promise<string | undefined> {
			if (!supported) return UNSUPPORTED_PLATFORM_MESSAGE;
			if (ctx?.signal?.aborted) return cancelledMessage;
			if (state.enabled) return;
			if (denied) return declinedMessage;
			if (permissionRequest) return permissionRequest;
			try {
				const saved = options.permissions?.read();
				if (saved === false) { denied = true; return declinedMessage; }
				if (saved === true) { enable(false); return; }
			} catch (error) { return errorMessage(error); }
			if (!ctx?.hasUI || !ctx.ui?.confirm) return cuaNotEnabledMessage();
			const revision = generation;
			const request = (async () => {
				try {
					const approved = await ctx.ui.confirm(CUA_PERMISSION_TITLE, CUA_PERMISSION_MESSAGE, { signal: ctx.signal });
					if (revision !== generation || ctx.signal?.aborted) return cancelledMessage;
					if (approved !== true) {
						denied = true;
						options.permissions?.write(false);
						return declinedMessage;
					}
					enable(true);
					return undefined;
				} catch (error) {
					return revision !== generation || ctx.signal?.aborted ? cancelledMessage : errorMessage(error);
				}
			})();
			permissionRequest = request;
			try { return await request; }
			finally { if (permissionRequest === request) permissionRequest = null; }
		}

		// Pause the first model call at the existing human-confirmation boundary.
		pi.on('tool_call', async (event, ctx) => {
			if (!event.toolName.startsWith(CUA_TOOL_PREFIX)) return;
			const reason = await authorize(ctx);
			return reason || ctx?.signal?.aborted ? { block: true, reason: reason ?? cancelledMessage } : undefined;
		});
		pi.on('session_shutdown', () => {
			generation += 1;
			permissionRequest = null;
			releaseModifiersBestEffort();
			state.enabled = false;
			state.lastScreenshot = null;
			state.resetFrames();
			state.resetObservation();
		});

		pi.registerCommand('cua', {
			description: 'computer-use 授权（首次使用自动询问；/cua on|off 开启或撤销，不带参数查看状态）',
			getArgumentCompletions: (prefix) =>
				['on', 'off'].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
			handler: async (args, ctx) => {
				const action = args.trim().toLowerCase();
				if (action === 'off') {
					generation += 1;
					permissionRequest = null;
					denied = true;
					releaseModifiersBestEffort();
					state.enabled = false;
					state.lastScreenshot = null;
					state.resetFrames();
					state.resetObservation();
					try {
						options.permissions?.write(false);
						ctx.ui.notify('computer-use 已关闭，本对话的授权已撤销', 'info');
					} catch (error) { ctx.ui.notify(`computer-use 本次已关闭，但撤销记录无法保存：${error instanceof Error ? error.message : String(error)}`, 'error'); }
					return;
				}
				if (action === 'on') {
					generation += 1;
					permissionRequest = null;
					if (!supported) {
						state.enabled = false;
						ctx.ui.notify(UNSUPPORTED_PLATFORM_MESSAGE, 'warning');
						return;
					}
					try {
						enable(true);
					} catch (error) {
						state.enabled = false;
						ctx.ui.notify(errorMessage(error), 'error');
						return;
					}
					ctx.ui.notify('computer-use 已开启并授权本对话：点击/输入等操作将直接作用于桌面，可用 /cua off 撤销', 'warning');
					return;
				}
				try {
					const saved = options.permissions?.read();
					const status = state.enabled ? '已开启' : denied || saved === false ? '已关闭' : saved === true ? '本对话已授权（调用时启用）' : '未开启，首次使用时将请求授权';
					ctx.ui.notify(`computer-use：${status}（/cua on 开启，/cua off 撤销）${supported ? '' : `；${UNSUPPORTED_PLATFORM_MESSAGE}`}`, 'info');
				} catch (error) { ctx.ui.notify(errorMessage(error), 'error'); }
			},
		});

		// -------------------------------------------------------------------
		// Screenshot
		// -------------------------------------------------------------------

		pi.registerTool({
			name: 'cua_screenshot',
			label: '截屏',
			description: `截取屏幕（默认整个虚拟桌面，可指定区域，或用 window 只截取单个窗口）。返回图片、分辨率与 frame 帧号；多显示器时坐标可能为负。${COORDINATE_CONVENTION}`,
			promptSnippet: '截屏并查看屏幕内容',
			promptGuidelines: [
				'需要操作电脑时可直接调用 cua_* 工具，首次调用会暂停并向用户请求本对话授权，无需先让用户手动运行 /cua on；用户拒绝或关闭后应停止尝试电脑控制。',
				'执行点击/输入等操作后，先重新截屏确认结果再决定下一步；连续执行多个确定性动作后统一截屏一次即可，界面没有变化时不要立即重复截屏。',
				'目标结果在截图中已经可见时应停止探索并直接回答；后续坐标操作可携带截图返回的 frame 号，屏幕布局变化时会拒绝执行。',
				'需要定位窗口内可交互元素时优先用 cua_get_state（无障碍树），只在需要视觉信息或元素不在树中时截图。'
			],
			parameters: Type.Object({
				x: Type.Optional(Type.Number({ description: '区域左上角 X（物理像素，缺省=整桌面）' })),
				y: Type.Optional(Type.Number({ description: '区域左上角 Y' })),
				width: Type.Optional(Type.Number({ description: '区域宽度' })),
				height: Type.Optional(Type.Number({ description: '区域高度' })),
				maxWidth: Type.Optional(Type.Number({ description: '编码图片最大宽度（默认 1600，超出会双线性缩小，坐标仍按原始分辨率）' })),
				window: Type.Optional(Type.Number({ description: '窗口句柄（cua_list_windows 的 hwnd）：只截取该窗口（被遮挡也能截到，不含桌面其他内容），与区域参数互斥' })),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params) => {
				const backend = requireEnabled();
				if (backend.inputDesktopAccessible && !backend.inputDesktopAccessible()) {
					throw new CuaError('SCREEN_LOCKED', '屏幕已锁定或安全桌面正在活动，截图结果不可用；请提醒用户解锁屏幕后重试');
				}
				const hasRegion = params.x !== undefined || params.y !== undefined || params.width !== undefined || params.height !== undefined;
				if (hasRegion && (params.x === undefined || params.y === undefined || params.width === undefined || params.height === undefined)) {
					invalid('指定截屏区域时 x/y/width/height 必须同时提供');
				}
				if (params.window !== undefined && hasRegion) invalid('window 与区域参数（x/y/width/height）互斥');
				const region = hasRegion
					? { x: Math.round(params.x!), y: Math.round(params.y!), width: Math.round(params.width!), height: Math.round(params.height!) }
					: undefined;
				let capture: RawCapture;
				let windowScope: { hwnd: number; rect: Rect } | undefined;
				if (params.window !== undefined) {
					if (!backend.captureWindow || !backend.windowRect) throw new CuaError('INTERNAL', '当前后端不支持窗口作用域截屏');
					windowScope = { hwnd: params.window, rect: backend.windowRect(params.window) };
					capture = backend.captureWindow(params.window);
				} else {
					capture = backend.capture(region);
				}
				const image = encodeImage(capture.bgra, capture.width, capture.height, {
					maxWidth: typeof params.maxWidth === 'number' ? params.maxWidth : undefined,
				});
				state.lastScreenshot = { width: capture.width, height: capture.height, scale: image.scale };
				const frame = state.recordFrame(backend.virtualScreen(), region ?? null, windowScope);
				const cursor = safeCursor(backend);
				const scopeText = windowScope ? `窗口作用域 hwnd=${windowScope.hwnd}，窗口位于 [${windowScope.rect.x},${windowScope.rect.y} ${windowScope.rect.width}x${windowScope.rect.height}]（窗口内坐标即屏幕坐标，被遮挡部分也已截入）。` : '';
				const text =
					`截图成功（${windowScope ? '窗口' : '桌面'}）：frame=${frame}，原始分辨率 ${capture.width}×${capture.height}，编码 ${image.format.toUpperCase()} ${image.width}×${image.height}` +
					`(scale=${image.scale.toFixed(2)})；光标 (${cursor?.x ?? '?'},${cursor?.y ?? '?'})。坐标动作可带 frame=${frame} 校验屏幕布局未变。${scopeText}${COORDINATE_CONVENTION}`;
				return {
					content: [
						{ type: 'image', data: image.data, mimeType: image.mimeType } satisfies ImageContent,
						{ type: 'text', text } satisfies TextContent,
					],
				details: { frame, width: capture.width, height: capture.height, window: windowScope?.hwnd, encoded: { width: image.width, height: image.height, scale: image.scale, format: image.format } },
				};
			},
		});

		// -------------------------------------------------------------------
		// Accessibility tree (UIA get_state)
		// -------------------------------------------------------------------

		pi.registerTool({
			name: 'cua_get_state',
			label: '读取窗口无障碍树',
			description: '读取目标窗口的 UIA 无障碍树：紧凑元素行带索引编号（角色/名称/矩形/值/状态），后续可用 cua_left_click 等工具的 element 参数按索引寻址，无需从截图推算坐标。仅读取该窗口，不含桌面其他内容；被遮挡窗口也可读。',
			promptSnippet: '读取窗口无障碍树定位元素',
			promptGuidelines: [
				'定位可交互元素（按钮/输入框/菜单项等）时优先使用 cua_get_state，比截图更省且不受窗口遮挡影响；需要视觉信息（布局、图像、图表）或元素不在树中时再用 cua_screenshot。',
				'element 索引仅在最近一次观察内有效：窗口移动或元素失效会拒绝执行并提示重新观察；同一观察上可连续执行多个确定性动作。',
			],
			parameters: Type.Object({
				hwnd: Type.Optional(Type.Number({ description: '窗口句柄（cua_list_windows）；缺省=前台窗口' })),
				title: Type.Optional(Type.String({ description: '窗口标题（精确优先，其次唯一子串匹配）' })),
				maxNodes: Type.Optional(Type.Number({ description: '元素数量上限（默认 400，最大 1000）' })),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params) => {
				const backend = requireEnabled();
				if (!backend.uiaTree || !backend.windowRect) throw new CuaError('INTERNAL', '当前后端不支持无障碍树');
				if (backend.inputDesktopAccessible && !backend.inputDesktopAccessible()) {
					throw new CuaError('SCREEN_LOCKED', '屏幕已锁定或安全桌面正在活动；请提醒用户解锁屏幕后重试');
				}
				let hwnd = params.hwnd;
				if (hwnd === undefined && params.title !== undefined) hwnd = resolveWindowHandle(backend, undefined, params.title);
				if (hwnd === undefined) {
					const { windows } = backend.listWindows();
					const foreground = windows.find((w) => w.foreground);
					if (!foreground) throw new CuaError('TARGET_GONE', '没有前台窗口可观察；请用 hwnd 或 title 指定目标窗口');
					hwnd = foreground.hwnd;
				}
				const tree = backend.uiaTree(hwnd, { maxNodes: params.maxNodes });
				const rect = backend.windowRect(hwnd);
				const flat: ObservedElement[] = [];
				const lines: string[] = [];
				const walk = (node: UiaElementNode, depth: number): void => {
					const index = flat.length;
					flat.push({ role: node.role, name: node.name, rect: node.rect, offscreen: node.offscreen, enabled: node.enabled });
					if (lines.length < 2000) {
						const rectText = node.rect ? `[${node.rect.x},${node.rect.y} ${node.rect.width}x${node.rect.height}]` : '';
						const flags = `${node.enabled ? '' : ' 已禁用'}${node.offscreen ? ' 屏幕外' : ''}${node.focused ? ' *焦点*' : ''}${node.password ? ' 密码框' : ''}`;
						const valueText = node.value !== undefined ? ` 值=${JSON.stringify(node.value)}` : '';
						const idText = node.automationId ? ` id=${node.automationId}` : '';
						const nameText = node.name ? ` ${JSON.stringify(node.name)}` : '';
						lines.push(`${'  '.repeat(depth)}[${index}] ${node.role}${nameText}${idText} ${rectText}${valueText}${flags}`.trimEnd());
					}
					for (const child of node.children) walk(child, depth + 1);
				};
				walk(tree.root, 0);
				state.observation = { hwnd, title: tree.root.name || '', rect, flat, time: Date.now() };
				const titleText = tree.root.name ? `“${tree.root.name}”` : '';
				const header = `窗口 hwnd=${hwnd} ${titleText} [${rect.x},${rect.y} ${rect.width}x${rect.height}]，元素 ${flat.length} 个${tree.truncated ? '（已达上限被截断；可用 maxNodes 提高或改用 cua_screenshot）' : ''}`;
				const footer = '元素索引可用于 cua_left_click/cua_double_click/cua_right_click/cua_scroll 的 element 参数（与坐标互斥）；窗口移动或元素失效时会拒绝并要求重新观察。';
				return textResult(`${header}\n${lines.join('\n')}\n${footer}`, { hwnd, count: flat.length, truncated: tree.truncated, rect });
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
				frame: FRAME_PARAM,
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params) => {
				const backend = requireInjectionReady(params.frame);
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
					element: ELEMENT_PARAM,
					frame: FRAME_PARAM,
				}),
				annotations: ACTION_ANNOTATIONS,
				executionMode: 'sequential',
			execute: async (_id, params) => {
				const backend = requireInjectionReady(params.frame);
				let x: number | undefined;
				let y: number | undefined;
				let at: string;
				if (params.element !== undefined) {
					if (params.x !== undefined || params.y !== undefined) invalid('element 与 x/y 互斥（都不传则点击当前位置）');
					const point = resolveElementPoint(backend, params.element);
					x = point.x;
					y = point.y;
					at = `元素 ${point.label} @ (${x}, ${y})`;
				} else {
					if ((params.x === undefined) !== (params.y === undefined)) invalid('x 与 y 需要同时提供（都不传则点击当前位置）');
					x = params.x === undefined ? undefined : Math.round(params.x);
					y = params.y === undefined ? undefined : Math.round(params.y);
					at = x === undefined || y === undefined ? '当前位置' : `(${x}, ${y})`;
				}
				backend.mouseClick(button, x, y, doubleClick);
				return textResult(`${label}完成：${at}`, { button, x, y, doubleClick });
			},
			});
		};

		clickTool('cua_left_click', '左键单击', '在指定位置、指定元素（cua_get_state 的 element 索引）或当前鼠标位置执行左键单击。', 'left');
		clickTool('cua_double_click', '左键双击', '在指定位置、指定元素（cua_get_state 的 element 索引）或当前鼠标位置执行左键双击。', 'left', true);
		clickTool('cua_right_click', '右键单击', '在指定位置、指定元素（cua_get_state 的 element 索引）或当前鼠标位置执行右键单击（打开上下文菜单）。', 'right');

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
				frame: FRAME_PARAM,
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params, signal) => {
				const backend = requireInjectionReady(params.frame);
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
			description: '滚动滚轮：缺省在当前鼠标位置；提供 element 时先把鼠标移到该元素中心再滚动。amount 为格数：正数向下/右，负数向上/左。',
			parameters: Type.Object({
				amount: Type.Number({ description: '滚动格数（正=向下，负=向上；水平时正=向右）' }),
				horizontal: Type.Optional(Type.Boolean({ description: 'true=水平滚轮（默认 false）' })),
				element: ELEMENT_PARAM,
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params) => {
				const backend = requireInjectionReady();
				let at = '当前鼠标位置';
				if (params.element !== undefined) {
					const point = resolveElementPoint(backend, params.element);
					backend.mouseMove(point.x, point.y);
					at = `元素 ${point.label} @ (${point.x}, ${point.y})`;
				}
				backend.mouseScroll(params.amount, params.horizontal === true);
				return textResult(`滚动 ${params.amount > 0 ? '+' : ''}${params.amount} 格${params.horizontal === true ? '（水平）' : ''} @ ${at}`, {
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
				const backend = requireInjectionReady();
				if (!params.text.length) invalid('text 不能为空');
				if (params.text.length > 20000) invalid('text 过长（上限 20000 字符，请分段输入）');
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
				const backend = requireInjectionReady();
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
				if (params.text.length > 100000) invalid('text 过长（上限 100000 字符）');
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
			description: '列出当前可见的顶层窗口（标题、进程名与 PID、位置、是否最小化/前台）。用于定位目标后再 cua_activate_window 或直接点击。',
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
						`hwnd=${w.hwnd} pid=${w.pid}${w.processName ? ` name=${w.processName}` : ''} [${w.x},${w.y} ${w.width}x${w.height}]${w.minimized ? ' (最小化)' : ''}${w.foreground ? ' *前台*' : ''} ${JSON.stringify(w.title)}`,
				);
				const note = truncated ? '\n（窗口过多，仅列出前面一部分；可用 titleContains 过滤）' : '';
				return textResult(lines.length ? `共 ${filtered.length} 个窗口：\n${lines.join('\n')}${note}` : `没有匹配的窗口${note}`, {
					count: filtered.length,
					truncated,
					windows: filtered.map((w) => ({ hwnd: w.hwnd, pid: w.pid, ...(w.processName ? { processName: w.processName } : {}), title: w.title })),
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
				const backend = requireInjectionReady();
				let handle = params.hwnd;
				let matchedTitle: string | null = null;
				if (handle === undefined) {
					const title = params.title;
					if (!title) throw new CuaError('INVALID_ARGUMENTS', '需要提供 hwnd 或 title');
					const { windows } = backend.listWindows();
					const exact = windows.find((w) => w.title === title);
					const candidates = exact ? [exact] : windows.filter((w) => w.title.toLowerCase().includes(title.toLowerCase()));
					if (!candidates.length) {
						throw new CuaError('TARGET_GONE', `没有标题匹配“${title}”的窗口（可能已关闭或改名）；请用 cua_list_windows 重新查看`);
					}
					if (candidates.length > 1) {
						throw new CuaError('AMBIGUOUS_TARGET', `标题匹配到 ${candidates.length} 个窗口（需要唯一匹配；请用 cua_list_windows 取 hwnd）`);
					}
					handle = candidates[0].hwnd;
					matchedTitle = candidates[0].title;
				}
				const ok = await backend.activateWindow(handle);
				if (!ok) throw new CuaError('FOREGROUND_FAILED', '激活窗口失败（系统限制后台进程抢焦点；可改为直接点击目标窗口或任务栏按钮）');
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
			reject(new CuaError('ABORTED', '已中止'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new CuaError('ABORTED', '已中止'));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
