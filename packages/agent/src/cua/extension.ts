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
 *     rectangle pinned into the frame record. Window-bound inputs check
 *     the foreground window and pointer hit target before sending input.
 *
 * Windows implements everything through the Win32 backend (koffi). Other
 * platforms fail closed. Building the extension never loads native code: the
 * native bindings are resolved only after consent, so sessions start normally
 * even when koffi is unavailable.
 */

import { Type, type TSchema } from 'typebox';
import type { ExtensionContext, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import {
	type CuaBackend,
	CuaSessionState,
	cuaNotEnabledMessage,
	encodeImage,
	getBackend,
	parseKeys,
	withCuaDesktop,
	CuaError,
	UNSUPPORTED_PLATFORM_MESSAGE,
} from './core.ts';
import type { ElementObservation, ObservedElement, RawCapture, Rect, UiaElementNode, WindowOwner } from './types.ts';
import { CUA_PERMISSION_MESSAGE, CUA_PERMISSION_TITLE, type CuaPermissionStorage, type CuaScopeStorage } from './permissions.ts';

const CUA_TOOL_PREFIX = 'cua_';
const READ_ONLY_ANNOTATIONS = { readOnlyHint: true } as const;
const ACTION_ANNOTATIONS = { destructiveHint: true, openWorldHint: true } as const;

const COORDINATE_CONVENTION =
	'坐标约定：所有坐标均为屏幕物理像素，原点在主显示器左上角（多显示器向右下延伸，可能为负值）；点击、拖拽、输入使用的坐标必须基于最近一次截图的原始分辨率，而不是编码后图片的像素。';

const FRAME_PARAM = Type.Optional(
	Type.Number({ description: 'cua_screenshot 返回的帧号。提供时校验桌面布局；单窗口帧还会绑定输入目标并校验窗口位置。' }),
);

const ELEMENT_PARAM = Type.Optional(
	Type.Number({ description: '与 observationId 配对的元素索引，与 x/y 互斥。' }),
);
const OBSERVATION_PARAM = Type.Number({ description: 'cua_get_state 返回的 observationId。' });
const COORDINATE_SPACE_PARAM = Type.Optional(Type.Union([Type.Literal('screen'), Type.Literal('image')], {
	description: '缺省 screen 使用屏幕物理像素；image 使用指定 frame 返回的图片像素，由程序换算。',
}));

const WINDOW_PARAM = Type.Optional(
	Type.Number({ description: '目标窗口句柄（来自 cua_list_windows 或 cua_get_state）。输入前激活并校验该窗口；需与 element 或窗口 frame 一致。' }),
);

type Point = { x: number; y: number };
type ScopeInput = {
	hwnd?: number; window?: number; title?: string; frame?: number; element?: number; observationId?: number;
};
type AccessScope = { key: string; label: string; window?: { hwnd: number; pid: number } };

export interface CuaExtensionOptions {
	/** State holder shared between the extension and the desktop host. */
	state?: CuaSessionState;
	/** Host-local, conversation-scoped consent, never restored from model messages. */
	permissions?: CuaPermissionStorage;
	scopes?: CuaScopeStorage;
	/**
	 * Application key of the host itself (the Pi desktop executable). Granting
	 * control of the host would let the model drive its own permission prompts
	 * and settings, so such scopes are always refused. Defaults to the current
	 * executable; null disables the guard (isolated tests only).
	 */
	hostApplicationKey?: string | null;
	/** Optional platform adapter, also used for isolated tests without desktop input. */
	backend?: CuaBackend;
}

export const CUA_SCOPE_CHOICES = {
	conversation: '本对话内允许',
	once: '仅本次允许',
	always: '始终允许（所有对话）',
	deny: '拒绝',
} as const;

export function cuaExtension(options: CuaExtensionOptions = {}): ExtensionFactory {
	const state = options.state ?? new CuaSessionState();
	const backend = options.backend ?? getBackend();
	return (pi) => {
		let denied = false;
		let generation = 0;
		let permissionRequest: Promise<string | undefined> | null = null;
		let activeScope: { scope: AccessScope; check: () => void } | undefined;
		const deniedScopes = new Set<string>();
		/** Grants that last for this conversation runtime only (never persisted). */
		const conversationScopes = new Set<string>();
		const supported = backend.platform === 'win32';
		const hostApplicationKey = options.hostApplicationKey === undefined
			? (supported ? `exe:${process.execPath.toLowerCase()}` : null)
			: options.hostApplicationKey;
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
		const assertWindowUnchanged = (active: CuaBackend, hwnd: number, prior: Rect, source: string): void => {
			const current = active.windowRect?.(hwnd);
			if (!current) throw new CuaError('INTERNAL', '当前后端无法校验窗口位置');
			if (current.x !== prior.x || current.y !== prior.y || current.width !== prior.width || current.height !== prior.height) {
				throw new CuaError('STALE_STATE', `${source}后窗口已移动或改变大小，请重新观察窗口`);
			}
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
				assertWindowUnchanged(active, record.windowHwnd, record.windowRect, '截图');
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

		const observedWindow = (params: ScopeInput): ElementObservation | undefined => {
			if (params.element === undefined) return;
			if (!state.observation || params.observationId !== state.observation.id) {
				throw new CuaError('STALE_STATE', '没有匹配的 cua_get_state 观察结果，请使用最新 observationId 和 element');
			}
			return state.observation;
		};

		const targetWindow = (params: ScopeInput, observation?: ElementObservation): number | undefined => {
			const frameWindow = params.frame === undefined ? undefined : state.frames.get(params.frame)?.windowHwnd;
			const hwnd = params.window ?? observation?.hwnd ?? frameWindow;
			if (hwnd !== undefined && (!Number.isSafeInteger(hwnd) || hwnd <= 0)) invalid('window 必须是有效的窗口句柄');
			if ((observation && observation.hwnd !== hwnd) || (frameWindow !== undefined && frameWindow !== hwnd)) {
				invalid('window、element 和窗口 frame 必须指向同一个窗口');
			}
			return hwnd;
		};

		const prepareWindowInput = async (
			active: CuaBackend,
			params: ScopeInput,
			signal?: AbortSignal,
			observation?: ElementObservation,
		) => {
			const expected = activeScope?.scope.window?.hwnd;
			const hwnd = targetWindow(params, observation) ?? expected;
			if (expected !== undefined && hwnd !== expected) throw new CuaError('TARGET_MISMATCH', '输入窗口与授权窗口不一致');

			const revision = generation;
			const checkReady = () => {
				if (revision !== generation || signal?.aborted) throw new CuaError('ABORTED', '电脑控制已中止');
				activeScope?.check();
				requireInjectionReady(params.frame);
				if (observation) assertWindowUnchanged(active, observation.hwnd, observation.rect, '观察');
				if (hwnd !== undefined && !active.windowEnabled(hwnd)) throw new CuaError('TARGET_MISMATCH', '目标窗口已禁用或被模态窗口阻塞，请重新观察');
			};
			/**
			 * The target itself, or a same-process popup it owns (context menu,
			 * dropdown list, Chromium select popup). Modal dialogs are not covered:
			 * they disable the owner, which checkReady refuses.
			 */
			const belongsToTarget = (candidate: number): boolean =>
				candidate === hwnd || (hwnd !== undefined && candidate !== 0 && active.windowOwnedBy?.(candidate, hwnd) === true);
			checkReady();
			if (hwnd !== undefined && !belongsToTarget(active.foregroundWindow())) {
				const activated = await active.activateWindow(hwnd, false);
				checkReady();
				if (!activated) throw new CuaError('FOREGROUND_FAILED', `无法激活目标窗口 hwnd=${hwnd}，请重新观察前台窗口`);
			}

			// Check again after activation and at delivery, including delayed paste or drag.
			const check = (point?: Point) => {
				checkReady();
				if (hwnd === undefined) return;
				if (!belongsToTarget(active.foregroundWindow())) {
					throw new CuaError('TARGET_MISMATCH', `目标窗口 hwnd=${hwnd} 当前不在前台，请重新观察`);
				}
				if (point) {
					const screen = active.virtualScreen();
					const onScreen = point.x >= screen.x && point.x < screen.x + screen.width && point.y >= screen.y && point.y < screen.y + screen.height;
					if (!onScreen || !belongsToTarget(active.windowAtPoint(point.x, point.y))) {
						throw new CuaError('TARGET_MISMATCH', `坐标 (${point.x}, ${point.y}) 未命中目标窗口 hwnd=${hwnd}，请重新观察窗口或弹窗`);
					}
				}
			};
			const checkKeyboard = () => {
				check();
				if (hwnd !== undefined && active.keyboardWindow() !== hwnd) {
					throw new CuaError('TARGET_MISMATCH', '键盘焦点不在目标窗口，请重新观察');
				}
			};
			return { hwnd, check, checkKeyboard };
		};
		/** Release every held modifier key when control ends (zcode cancelInputHoldsForSession). */
		const stopDesktopControl = async (): Promise<void> => {
			const release = state.enabled && supported && backend.releaseModifiers;
			generation += 1;
			permissionRequest = null;
			state.enabled = false;
			state.lastScreenshot = null;
			state.resetFrames();
			state.resetObservation();
			conversationScopes.clear();
			if (release) {
				try { await withCuaDesktop(backend, undefined, async () => { release(); }); }
				catch { /* best-effort safety net */ }
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
		const resolveElementPoint = (element: number, observation: ElementObservation): Point & { label: string; observation: ElementObservation } => {
			if (!Number.isInteger(element) || element < 0 || element >= observation.flat.length) {
				throw new CuaError('ELEMENT_UNAVAILABLE', `元素索引 ${element} 不在最近观察中（该观察共 ${observation.flat.length} 个元素）；请重新 cua_get_state 后使用新索引`);
			}
			const target = observation.flat[element];
			const prior = observation.rect;
			if (!target.rect) throw new CuaError('ELEMENT_UNAVAILABLE', `元素 [${element}]（${target.role}）没有可见矩形，无法定位；请用 cua_screenshot 以坐标方式操作`);
			if (target.offscreen) throw new CuaError('ELEMENT_UNAVAILABLE', `元素 [${element}]（${target.role}${target.name ? ` ${JSON.stringify(target.name)}` : ''}）在屏幕外；先滚动或调整窗口使其可见`);
			const x = Math.min(Math.max(Math.round(target.rect.x + target.rect.width / 2), prior.x), prior.x + prior.width - 1);
			const y = Math.min(Math.max(Math.round(target.rect.y + target.rect.height / 2), prior.y), prior.y + prior.height - 1);
			return { x, y, observation, label: `[${element}] ${target.role}${target.name ? ` ${JSON.stringify(target.name)}` : ''}` };
		};

		const resolvePointerTarget = (
			params: ScopeInput & { x?: number; y?: number; coordinateSpace?: 'image' | 'screen' },
		): (Point & { label?: string; observation?: ElementObservation }) | undefined => {
			const { x, y, element } = params;
			if (element !== undefined) {
				if (x !== undefined || y !== undefined || params.coordinateSpace !== undefined) invalid('element 与坐标参数互斥');
				return resolveElementPoint(element, observedWindow(params)!);
			}
			if ((x === undefined) !== (y === undefined)) invalid('x 与 y 需要同时提供');
			if (x !== undefined && y !== undefined) return screenPoint(x, y, params);
			if (params.coordinateSpace === 'image') invalid('图片坐标需要 x/y');
		};

		const screenPoint = (x: number, y: number, params: { frame?: number; coordinateSpace?: 'screen' | 'image' }): Point => {
			if (params.coordinateSpace !== 'image') return { x: Math.round(x), y: Math.round(y) };
			if (params.frame === undefined) throw new CuaError('INVALID_ARGUMENTS', '使用图片坐标时必须提供 frame');
			const image = state.frames.get(params.frame)?.image;
			if (!image) throw new CuaError('STALE_STATE', '截图帧已失效，请重新截图');
			if (!(x >= 0 && x < image.width && y >= 0 && y < image.height)) invalid('坐标在截图图片范围外');
			return {
				x: image.bounds.x + Math.floor(x * image.bounds.width / image.width),
				y: image.bounds.y + Math.floor(y * image.bounds.height / image.height),
			};
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

		const scopeForTool = (name: string, params: ScopeInput): AccessScope => {
			switch (name) {
				case 'cua_list_windows': return { key: 'desktop:windows', label: '读取窗口列表（标题、应用名称和位置）' };
				case 'cua_read_clipboard': return { key: 'desktop:clipboard-read', label: '读取系统剪贴板' };
				case 'cua_write_clipboard': return { key: 'desktop:clipboard-write', label: '写入系统剪贴板' };
				case 'cua_screenshot':
					if (params.window === undefined) return { key: 'desktop:screen', label: '截取桌面整屏或指定区域' };
					break;
			}
			assertFrameFresh(backend, params.frame);
			const observation = observedWindow(params);
			let hwnd = name === 'cua_get_state' || name === 'cua_activate_window'
				? params.hwnd ?? (params.title === undefined ? undefined : resolveWindowHandle(backend, undefined, params.title))
				: targetWindow(params, observation);
			hwnd ??= name === 'cua_activate_window' ? undefined : backend.foregroundWindow();
			if (!hwnd || !Number.isSafeInteger(hwnd)) throw new CuaError('TARGET_GONE', '无法识别目标窗口，请指定有效的窗口句柄');
			const app = backend.windowApplication?.(hwnd);
			if (!app) throw new CuaError('PERMISSION_DENIED', '无法验证目标应用身份');
			if (hostApplicationKey && app.key === hostApplicationKey) {
				throw new CuaError(
					'PERMISSION_DENIED',
					`目标窗口 hwnd=${hwnd} 属于 Pi Desktop 自身，不能授权电脑控制操作它。请先用 cua_list_windows 找到要操作的应用窗口，再通过 window/hwnd 参数指定目标。`,
				);
			}
			const frameOwner = params.frame === undefined ? undefined : state.frames.get(params.frame)?.windowOwner;
			for (const owner of [observation?.windowOwner, frameOwner]) {
				if (owner && (owner.appKey !== app.key || owner.pid !== app.pid)) {
					throw new CuaError('STALE_STATE', '原来的窗口已换成另一个应用或进程，请重新观察');
				}
			}
			return { key: app.key, label: '观察并控制应用 ' + app.label, window: { hwnd, pid: app.pid } };
		};

		const observedOwner = (): WindowOwner | undefined => {
			const scope = activeScope?.scope;
			if (scope?.window) return { appKey: scope.key, pid: scope.window.pid };
		};

		const ensureAvailable = (revision: number, signal?: AbortSignal): void => {
			if (!supported) throw new CuaError('UNSUPPORTED_PLATFORM', UNSUPPORTED_PLATFORM_MESSAGE);
			if (signal?.aborted || revision !== generation) throw new CuaError('ABORTED', cancelledMessage);
			if (denied || options.permissions?.read() === false) throw new CuaError('PERMISSION_DENIED', declinedMessage);
		};

		const requestScope = async (name: string, params: ScopeInput, ctx: ExtensionContext, signal?: AbortSignal) => {
			const scopes = options.scopes!;
			const revision = generation;
			ensureAvailable(revision, signal);
			const scope = scopeForTool(name, params);
			if (deniedScopes.has(scope.key)) throw new CuaError('PERMISSION_DENIED', '本对话已拒绝此权限，可用 /cua on 允许重新询问');
			let remembered = scopes.isAllowed(scope.key);
			let conversation = !remembered && conversationScopes.has(scope.key);
			if (!remembered && !conversation) {
				if (!ctx?.hasUI || !ctx.ui?.select) throw new CuaError('PERMISSION_DENIED', '当前没有可用的电脑控制授权界面');
				const { conversation: thisConversation, once, always, deny } = CUA_SCOPE_CHOICES;
				const choice = await ctx.ui.select('电脑控制权限 · ' + scope.label, [thisConversation, once, always, deny], { signal });
				ensureAvailable(revision, signal);
				if (choice !== thisConversation && choice !== once && choice !== always) {
					if (choice === deny) deniedScopes.add(scope.key);
					throw new CuaError('PERMISSION_DENIED', '用户未批准此权限');
				}
				remembered = choice === always;
				conversation = choice === thisConversation;
				if (remembered) scopes.allow(scope.key);
				if (conversation) conversationScopes.add(scope.key);
			}
			return { scope, check: () => {
				ensureAvailable(revision, signal);
				if (remembered && !scopes.isAllowed(scope.key)) throw new CuaError('PERMISSION_DENIED', '已保存的电脑控制授权已撤销');
				if (conversation && !conversationScopes.has(scope.key)) throw new CuaError('PERMISSION_DENIED', '本对话的电脑控制授权已撤销');
				if (scope.window) {
					const app = backend.windowApplication?.(scope.window.hwnd);
					if (app?.key !== scope.key || app.pid !== scope.window.pid) throw new CuaError('TARGET_MISMATCH', '授权后目标窗口的应用身份已变化');
				}
			} };
		};

		const registerTool = <T extends TSchema, D>(tool: ToolDefinition<T, D>) => {
			pi.registerTool({
				...tool,
				execute: async (id, params, signal, update, ctx) => {
					if (tool.name === 'cua_wait') return tool.execute(id, params, signal, update, ctx);
					const grant = options.scopes ? await requestScope(tool.name, params as ScopeInput, ctx, signal) : undefined;
					if (!grant) requireEnabled();
					return withCuaDesktop(backend, signal, async () => {
						grant?.check();
						if (grant && !state.enabled) enable(false);
						activeScope = grant;
						try { return await tool.execute(id, params, signal, update, ctx); }
						finally { activeScope = undefined; }
					});
				},
			});
		};

		// The legacy session-level hook is retained for hosts that do not supply a scope store.
		pi.on('tool_call', async (event, ctx) => {
			if (options.scopes || !event.toolName.startsWith(CUA_TOOL_PREFIX)) return;
			const reason = await authorize(ctx);
			return reason || ctx?.signal?.aborted ? { block: true, reason: reason ?? cancelledMessage } : undefined;
		});
		pi.on('session_shutdown', stopDesktopControl);

		pi.registerCommand('cua', {
			description: '电脑控制授权（/cua on|off 开启或撤销，/cua reset 清除记住的权限）',
			getArgumentCompletions: (prefix) =>
				(options.scopes ? ['on', 'off', 'reset'] : ['on', 'off']).filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
			handler: async (args, ctx) => {
				const action = args.trim().toLowerCase();
				if (action === 'reset' && options.scopes) {
					try {
						generation += 1;
						deniedScopes.clear();
						conversationScopes.clear();
						options.scopes.clear();
						ctx.ui.notify('已清除记住的电脑控制权限', 'info');
					} catch (error) { ctx.ui.notify(errorMessage(error), 'error'); }
					return;
				}
				if (action === 'off') {
					denied = true;
					const stopped = stopDesktopControl();
					try {
						options.permissions?.write(false);
						ctx.ui.notify('computer-use 已关闭，本对话的授权已撤销', 'info');
					} catch (error) { ctx.ui.notify(`computer-use 本次已关闭，但撤销记录无法保存：${error instanceof Error ? error.message : String(error)}`, 'error'); }
					await stopped;
					return;
				}
				if (action === 'on') {
					generation += 1;
					deniedScopes.clear();
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
					ctx.ui.notify(options.scopes ? '电脑控制已开启，访问应用、屏幕或剪贴板时会核验对应权限，可用 /cua off 禁用' : 'computer-use 已开启并授权本对话：点击/输入等操作将直接作用于桌面，可用 /cua off 撤销', 'warning');
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

		registerTool({
			name: 'cua_screenshot',
			label: '截屏',
			description: `截取屏幕（默认整个虚拟桌面，可指定区域，或用 window 只截取单个窗口）。返回图片、分辨率与 frame 帧号；多显示器时坐标可能为负。${COORDINATE_CONVENTION}`,
			promptSnippet: '截屏并查看屏幕内容',
			promptGuidelines: [
				'应用、整屏截图与剪贴板分别授权。可直接调用 cua_*，用户拒绝后停止尝试该权限。',
				'执行点击/输入等操作后，先重新截屏确认结果再决定下一步；连续执行多个确定性动作后统一截屏一次即可，界面没有变化时不要立即重复截屏。',
				'对指定应用优先用窗口截图或 UIA。按图片像素点击时传 coordinateSpace=image 和 frame；目标校验失败后先重新观察。',
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
				let windowScope: { hwnd: number; rect: Rect; owner?: WindowOwner } | undefined;
				if (params.window !== undefined) {
					if (!backend.captureWindow || !backend.windowRect) throw new CuaError('INTERNAL', '当前后端不支持窗口作用域截屏');
					windowScope = { hwnd: params.window, rect: backend.windowRect(params.window), owner: observedOwner() };
					capture = backend.captureWindow(params.window);
				} else {
					capture = backend.capture(region);
				}
				const image = encodeImage(capture.bgra, capture.width, capture.height, {
					maxWidth: typeof params.maxWidth === 'number' ? params.maxWidth : undefined,
				});
				state.lastScreenshot = { width: capture.width, height: capture.height, scale: image.scale };
				const screen = backend.virtualScreen();
				const origin = capture.origin ?? windowScope?.rect ?? region ?? screen;
				const bounds = { x: origin.x, y: origin.y, width: capture.width, height: capture.height };
				if (windowScope) assertWindowUnchanged(backend, windowScope.hwnd, bounds, '截图');
				activeScope?.check();
				const frame = state.recordFrame(screen, region ?? null, { bounds, width: image.width, height: image.height }, windowScope);
				const cursor = safeCursor(backend);
				const scopeText = windowScope ? `窗口作用域 hwnd=${windowScope.hwnd}。` : '';
				const text =
					`截图成功（${windowScope ? '窗口' : '桌面'}）：frame=${frame}，原始分辨率 ${capture.width}×${capture.height}，编码 ${image.format.toUpperCase()} ${image.width}×${image.height}` +
					`(scale=${image.scale.toFixed(2)})；屏幕原点 (${bounds.x}, ${bounds.y})。光标 (${cursor?.x ?? '?'}, ${cursor?.y ?? '?'})。${scopeText}直接使用图片坐标时传 coordinateSpace=image 和 frame=${frame}。`;
				return {
					content: [
						{ type: 'image', data: image.data, mimeType: image.mimeType } satisfies ImageContent,
						{ type: 'text', text } satisfies TextContent,
					],
					details: { frame, bounds, width: capture.width, height: capture.height, window: windowScope?.hwnd, encoded: { width: image.width, height: image.height, scale: image.scale, format: image.format } },
				};
			},
		});

		// -------------------------------------------------------------------
		// Accessibility tree (UIA get_state)
		// -------------------------------------------------------------------

		registerTool({
			name: 'cua_get_state',
			label: '读取窗口无障碍树',
			description: '读取目标窗口的 UIA 无障碍树：紧凑元素行带索引编号（角色/名称/矩形/值/状态），后续可用 cua_left_click 等工具的 element 参数按索引寻址，无需从截图推算坐标。仅读取该窗口，不含桌面其他内容；被遮挡窗口也可读。',
			promptSnippet: '读取窗口无障碍树定位元素',
			promptGuidelines: [
				'定位可交互元素（按钮/输入框/菜单项等）时优先使用 cua_get_state，比截图更省且不受窗口遮挡影响；需要视觉信息（布局、图像、图表）或元素不在树中时再用 cua_screenshot。',
				'使用 observationId 和 element 绑定观察。标记 Invoke 或 SetValue 的控件可直接用 cua_invoke 或 cua_set_value。',
			],
			parameters: Type.Object({
				hwnd: Type.Optional(Type.Number({ description: '窗口句柄（cua_list_windows）；缺省=前台窗口' })),
				title: Type.Optional(Type.String({ description: '窗口标题（精确优先，其次唯一子串匹配）' })),
				maxNodes: Type.Optional(Type.Number({ description: '元素数量上限（默认 400，最大 1000）' })),
				view: Type.Optional(Type.Union([Type.Literal('control'), Type.Literal('raw')], { description: '默认 control。控制视图缺少目标时尝试 raw。' })),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params) => {
				const backend = requireEnabled();
				if (!backend.uiaTree || !backend.windowRect) throw new CuaError('INTERNAL', '当前后端不支持无障碍树');
				if (backend.inputDesktopAccessible && !backend.inputDesktopAccessible()) {
					throw new CuaError('SCREEN_LOCKED', '屏幕已锁定或安全桌面正在活动；请提醒用户解锁屏幕后重试');
				}
				let hwnd = activeScope?.scope.window?.hwnd ?? params.hwnd;
				if (hwnd === undefined && params.title !== undefined) hwnd = resolveWindowHandle(backend, undefined, params.title);
				if (hwnd === undefined) {
					const { windows } = backend.listWindows();
					const foreground = windows.find((w) => w.foreground);
					if (!foreground) throw new CuaError('TARGET_GONE', '没有前台窗口可观察；请用 hwnd 或 title 指定目标窗口');
					hwnd = foreground.hwnd;
				}
				const tree = backend.uiaTree(hwnd, { maxNodes: params.maxNodes, view: params.view });
				activeScope?.check();
				const rect = backend.windowRect(hwnd);
				const flat: ObservedElement[] = [];
				const lines: string[] = [];
				const approvedPid = activeScope?.scope.window?.pid;
				if (approvedPid !== undefined && tree.root.processId !== approvedPid) throw new CuaError('TARGET_MISMATCH', '无障碍树与授权窗口不属于同一进程');
				const walk = (node: UiaElementNode, depth: number, path: number[], anchorHwnd?: number): void => {
					if (approvedPid !== undefined && node.processId !== approvedPid) return;
					const elementPath = node.anchorHwnd === undefined ? path : [];
					const anchor = node.anchorHwnd ?? anchorHwnd;
					const index = flat.length;
					flat.push({
						role: node.role, name: node.name, rect: node.rect, offscreen: node.offscreen, enabled: node.enabled, path: elementPath,
						...(anchor === undefined ? {} : { anchorHwnd: anchor }),
						...(node.runtimeId ? { runtimeId: node.runtimeId } : {}),
					});
					if (lines.length < 2000) {
						const rectText = node.rect ? `[${node.rect.x},${node.rect.y} ${node.rect.width}x${node.rect.height}]` : '';
						const flags = `${node.enabled ? '' : ' 已禁用'}${node.offscreen ? ' 屏幕外' : ''}${node.focused ? ' *焦点*' : ''}${node.password ? ' 密码框' : ''}${node.canInvoke ? ' Invoke' : ''}${node.canSetValue ? ' SetValue' : ''}`;
						const valueText = node.value !== undefined ? ` 值=${JSON.stringify(node.value)}` : '';
						const idText = node.automationId ? ` id=${node.automationId}` : '';
						const nameText = node.name ? ` ${JSON.stringify(node.name)}` : '';
						lines.push(`${'  '.repeat(depth)}[${index}] ${node.role}${nameText}${idText} ${rectText}${valueText}${flags}`.trimEnd());
					}
					node.children.forEach((child, childIndex) => walk(child, depth + 1, [...elementPath, childIndex], anchor));
				};
				walk(tree.root, 0, []);
				const observation = state.recordObservation({ hwnd, windowOwner: observedOwner(), view: params.view ?? 'control', title: tree.root.name || '', rect, flat, time: Date.now() });
				const titleText = tree.root.name ? `“${tree.root.name}”` : '';
				const header = `窗口 hwnd=${hwnd} ${titleText} [${rect.x},${rect.y} ${rect.width}x${rect.height}]，元素 ${flat.length} 个${tree.truncated ? '（已达上限被截断；可用 maxNodes 提高或改用 cua_screenshot）' : ''}`;
				const footer = '使用元素时传 observationId 和 element。';
				return textResult(`${header}\nobservationId=${observation.id}\n${lines.join('\n')}\n${footer}`, { hwnd, observationId: observation.id, count: flat.length, truncated: tree.truncated, rect });
			},
		});

		const applyUia = async (
			params: { observationId: number; element: number },
			action: Parameters<NonNullable<CuaBackend['uiaAction']>>[2],
			signal?: AbortSignal,
		) => {
			const backend = requireInjectionReady();
			const observation = observedWindow(params)!;
			const element = observation.flat[params.element];
			if (!Number.isInteger(params.element) || !element?.runtimeId || !element.enabled || element.offscreen) {
				throw new CuaError('ELEMENT_UNAVAILABLE', '元素不支持语义动作，请重新观察或改用坐标');
			}
			if (!backend.uiaAction) throw new CuaError('INTERNAL', '当前后端不支持 UIA 语义动作');
			const target = await prepareWindowInput(backend, params, signal, observation);
			target.check();
			const outcome = await backend.uiaAction(observation.hwnd, {
				path: element.path, runtimeId: element.runtimeId, view: observation.view,
				...(element.anchorHwnd === undefined ? {} : { anchorHwnd: element.anchorHwnd }),
			}, action, target.check);
			state.resetObservation();
			const completed = outcome?.completed !== false;
			return textResult(
				completed
					? 'UIA 操作已送达，请重新观察结果'
					: 'UIA 操作已送达，但目标应用 5 秒内没有返回（可能打开了模态窗口或仍在处理）；请重新观察，在该操作返回前无法发起新的 UIA 操作',
				{ hwnd: observation.hwnd, element: params.element, completed },
			);
		};

		registerTool({
			name: 'cua_invoke',
			label: '触发控件',
			description: '触发最新观察中标记 Invoke 的控件。使用 UIA 调用按钮等元素，操作后重新观察。',
			parameters: Type.Object({ observationId: OBSERVATION_PARAM, element: Type.Number() }),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params, signal) => applyUia(params, { kind: 'invoke' }, signal),
		});

		registerTool({
			name: 'cua_set_value',
			label: '设置控件值',
			description: '替换最新观察中标记 SetValue 的可编辑控件文本。操作后重新观察。',
			parameters: Type.Object({ observationId: OBSERVATION_PARAM, element: Type.Number(), value: Type.String({ maxLength: 20000 }) }),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params, signal) => {
				if (params.value.includes('\0')) invalid('文本不能包含 NUL');
				return applyUia(params, { kind: 'setValue', value: params.value }, signal);
			},
		});

		// -------------------------------------------------------------------
		// Mouse
		// -------------------------------------------------------------------

		registerTool({
			name: 'cua_mouse_move',
			label: '移动鼠标',
			description: '将鼠标移动到屏幕物理像素坐标 (x, y)。',
			parameters: Type.Object({
				x: Type.Number({ description: '目标 X（物理像素）' }),
				y: Type.Number({ description: '目标 Y（物理像素）' }),
				frame: FRAME_PARAM,
				coordinateSpace: COORDINATE_SPACE_PARAM,
				window: WINDOW_PARAM,
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params, signal) => {
				const backend = requireInjectionReady(params.frame);
				const point = screenPoint(params.x, params.y, params);
				const target = await prepareWindowInput(backend, params, signal);
				target.check(point);
				backend.mouseMove(point.x, point.y);
				return textResult(`鼠标已移动到 (${point.x}, ${point.y})`, { x: params.x, y: params.y });
			},
		});

		const clickTool = (
			name: string,
			label: string,
			description: string,
			button: 'left' | 'right' | 'middle',
			doubleClick = false,
		): void => {
			registerTool({
				name,
				label,
				description,
				parameters: Type.Object({
					x: Type.Optional(Type.Number({ description: '点击 X（缺省=当前位置）' })),
					y: Type.Optional(Type.Number({ description: '点击 Y（缺省=当前位置）' })),
					element: ELEMENT_PARAM,
					observationId: Type.Optional(OBSERVATION_PARAM),
					frame: FRAME_PARAM,
					coordinateSpace: COORDINATE_SPACE_PARAM,
					window: WINDOW_PARAM,
				}),
				annotations: ACTION_ANNOTATIONS,
				executionMode: 'sequential',
				execute: async (_id, params, signal) => {
				const backend = requireInjectionReady(params.frame);
					const directed = resolvePointerTarget(params);
					const target = await prepareWindowInput(backend, params, signal, directed?.observation);
					const point = directed ?? (target.hwnd === undefined ? undefined : backend.cursorPosition());
					target.check(point);
					const { x, y } = point ?? {};
					const at = directed?.label ? `元素 ${directed.label} @ (${x}, ${y})` : point ? `(${x}, ${y})` : '当前位置';
				backend.mouseClick(button, x, y, doubleClick);
				return textResult(`${label}完成：${at}`, { button, x, y, doubleClick });
			},
			});
		};

		clickTool('cua_left_click', '左键单击', '在指定位置、指定元素（cua_get_state 的 element 索引）或当前鼠标位置执行左键单击。', 'left');
		clickTool('cua_double_click', '左键双击', '在指定位置、指定元素（cua_get_state 的 element 索引）或当前鼠标位置执行左键双击。', 'left', true);
		clickTool('cua_right_click', '右键单击', '在指定位置、指定元素（cua_get_state 的 element 索引）或当前鼠标位置执行右键单击（打开上下文菜单）。', 'right');

		registerTool({
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
				coordinateSpace: COORDINATE_SPACE_PARAM,
				window: WINDOW_PARAM,
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params, signal) => {
				const backend = requireInjectionReady(params.frame);
				const from = screenPoint(params.fromX, params.fromY, params);
				const to = screenPoint(params.toX, params.toY, params);
				const target = await prepareWindowInput(backend, params, signal);
				target.check(from);
				if (activeScope) target.check(to);
				await backend.mouseDrag(
					from.x,
					from.y,
					to.x,
					to.y,
					params.durationMs ?? 350,
					signal,
					target.hwnd === undefined ? undefined : () => target.check(from),
					activeScope ? target.check : undefined,
				);
				return textResult(`拖拽完成：(${params.fromX}, ${params.fromY}) → (${params.toX}, ${params.toY})`, {
					from: { x: params.fromX, y: params.fromY },
					to: { x: params.toX, y: params.toY },
				});
			},
		});

		registerTool({
			name: 'cua_scroll',
			label: '滚轮',
			description: '在坐标、元素中心或当前鼠标位置滚动。amount 为格数：正数向下/右，负数向上/左。',
			parameters: Type.Object({
				amount: Type.Number({ description: '滚动格数（正=向下，负=向上；水平时正=向右）' }),
				horizontal: Type.Optional(Type.Boolean({ description: 'true=水平滚轮（默认 false）' })),
				x: Type.Optional(Type.Number({ description: '滚动位置 X（物理像素）' })),
				y: Type.Optional(Type.Number({ description: '滚动位置 Y（物理像素）' })),
				element: ELEMENT_PARAM,
				observationId: Type.Optional(OBSERVATION_PARAM),
				frame: FRAME_PARAM,
				coordinateSpace: COORDINATE_SPACE_PARAM,
				window: WINDOW_PARAM,
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params, signal) => {
				const backend = requireInjectionReady(params.frame);
				const directed = resolvePointerTarget(params);
				const target = await prepareWindowInput(backend, params, signal, directed?.observation);
				const point = directed ?? (target.hwnd === undefined ? undefined : backend.cursorPosition());
				target.check(point);
				const at = point ? `${directed?.label ? `元素 ${directed.label} @ ` : ''}(${point.x}, ${point.y})` : '当前鼠标位置';
				backend.mouseScroll(params.amount, params.horizontal === true, point && { x: point.x, y: point.y });
				return textResult(`滚动 ${params.amount > 0 ? '+' : ''}${params.amount} 格${params.horizontal === true ? '（水平）' : ''} @ ${at}`, {
					amount: params.amount,
					horizontal: params.horizontal === true,
				});
			},
		});

		// -------------------------------------------------------------------
		// Keyboard
		// -------------------------------------------------------------------

		registerTool({
			name: 'cua_type',
			label: '输入文本',
			description: '向目标窗口输入文本。短的单行文本默认用 Unicode 键入；长文本或含换行的文本默认用剪贴板粘贴。剪贴板含富文本、图片或文件时不会覆盖它：单行文本自动改用 Unicode 键入，多行文本需显式传 method="unicode"（换行和 Tab 会作为真实的回车、Tab 键发送，可能触发提交或切换焦点）。',
			promptGuidelines: ['需要输入较长或非英文文本时使用 cua_type；单个按键或组合键用 cua_key。'],
			parameters: Type.Object({
				text: Type.String({ description: '要输入的文本' }),
				method: Type.Optional(Type.Union([Type.Literal('unicode'), Type.Literal('clipboard')], {
					description: 'unicode：逐字符键入，上限 1000 字符，换行/Tab 按真实按键发送；clipboard：剪贴板粘贴，换行原样粘贴。缺省自动选择。',
				})),
				window: WINDOW_PARAM,
				frame: FRAME_PARAM,
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params, signal) => {
				const backend = requireInjectionReady(params.frame);
				if (!params.text.length) invalid('text 不能为空');
				if (params.text.length > 20000) invalid('text 过长（上限 20000 字符，请分段输入）');
				if (params.text.includes('\0')) invalid('文本不能包含 NUL');
				// Unicode typing turns \t \r \n into real key presses; other control characters are refused.
				const unicodeSafe = !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(params.text);
				const singleLine = unicodeSafe && !/[\t\r\n]/.test(params.text);
				const unicodeFits = unicodeSafe && params.text.length <= 1000;
				let method = params.method ?? (singleLine && params.text.length <= 64 ? 'unicode' : 'clipboard');
				if (method === 'unicode' && !unicodeFits) invalid('Unicode 键入每次限 1000 字符，且只支持可见字符、Tab 与换行；可改用 clipboard 或分段输入');
				const target = await prepareWindowInput(backend, params, signal);
				target.checkKeyboard();
				try {
					await backend.typeText(params.text, signal, target.checkKeyboard, method);
				} catch (error) {
					// Rich clipboard content cannot be restored, so the paste was refused before any input.
					// A single line types the same either way; multi-line text would press Enter, so it stays the caller's choice.
					const fallBack = params.method === undefined && error instanceof CuaError && error.code === 'CLIPBOARD_FORMATS'
						&& !error.actionSent && singleLine && unicodeFits;
					if (!fallBack) throw error;
					method = 'unicode';
					await backend.typeText(params.text, signal, target.checkKeyboard, method);
				}
				return textResult(`已输入 ${params.text.length} 字符（${method === 'unicode' ? 'Unicode 键入' : '剪贴板粘贴'}）`, { length: params.text.length, method });
			},
		});

		registerTool({
			name: 'cua_key',
			label: '按键',
			description: '按下按键或组合键，例如 "enter"、"ctrl+a"、"ctrl+shift+t"、"alt+f4"、"win"。组合键用 + 连接且只能有一个主键，修饰键自动按下和释放；+ 键本身写作 "plus"。',
			parameters: Type.Object({
				keys: Type.String({ description: '按键序列，如 "enter" 或 "ctrl+shift+t"' }),
				window: WINDOW_PARAM,
				frame: FRAME_PARAM,
			}),
			annotations: ACTION_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params, signal) => {
				const backend = requireInjectionReady(params.frame);
				const parsed = parseKeys(params.keys);
				const target = await prepareWindowInput(backend, params, signal);
				target.checkKeyboard();
				backend.tapChord(parsed.modifiers, parsed.key);
				return textResult(`已按下：${params.keys}`, { keys: params.keys, modifiers: parsed.modifiers, key: parsed.key });
			},
		});

		// -------------------------------------------------------------------
		// Clipboard
		// -------------------------------------------------------------------

		registerTool({
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

		registerTool({
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

		registerTool({
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

		registerTool({
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
				let handle = activeScope?.scope.window?.hwnd ?? params.hwnd;
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
				if (!backend.windowEnabled(handle)) throw new CuaError('TARGET_MISMATCH', '目标窗口已禁用或被模态窗口阻塞');
				const ok = await backend.activateWindow(handle, !activeScope);
				activeScope?.check();
				if (!ok) throw new CuaError('FOREGROUND_FAILED', '激活窗口失败（系统限制后台进程抢焦点；可改为直接点击目标窗口或任务栏按钮）');
				return textResult(`已激活窗口 hwnd=${handle}${matchedTitle ? `（${matchedTitle}）` : ''}`, { hwnd: handle });
			},
		});

		// -------------------------------------------------------------------
		// Wait
		// -------------------------------------------------------------------

		registerTool({
			name: 'cua_wait',
			label: '等待',
			description: '等待指定毫秒（等待动画、加载、消抖），上限 30000ms。',
			parameters: Type.Object({
				ms: Type.Number({ description: '等待毫秒数（50–30000）' }),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
			executionMode: 'sequential',
			execute: async (_id, params, signal) => {
				if (options.scopes) ensureAvailable(generation, signal);
				else requireEnabled();
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
