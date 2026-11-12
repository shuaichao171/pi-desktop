/**
 * Pi agent host bootstrap entry (utility process).
 *
 * Stays dependency-free on purpose: when a custom engine is configured the
 * module redirect for `@earendil-works/pi-coding-agent` must be installed
 * before anything imports the SDK, so the real implementation is loaded via a
 * dynamic import from `agentHostImpl`. Load failures are reported to the main
 * process as a `fatal` message and exit the process so the crash path stays
 * observable.
 */
import { applyCaHygiene } from './caHygiene';
import { installEngineRedirect, missingSdkExports } from './piEngine';

const parent = process.parentPort;
if (!parent) throw new Error('Pi agent host requires an Electron parent port');

function fatal(message: string): void {
	parent.postMessage({ kind: 'fatal', message });
	// Give the parent port a moment to flush before exiting.
	setTimeout(() => process.exit(1), 100);
}

async function bootstrap(): Promise<void> {
	// TLS hygiene runs before any SDK import so every outbound connection in
	// this utility process sees the pruned default CA set from the start.
	applyCaHygiene();
	const engineDir = process.env.PI_DESKTOP_ENGINE_DIR?.trim();
	if (engineDir) {
		const redirect = installEngineRedirect(engineDir);
		if (!redirect.ok) {
			throw new Error(`自定义 Pi 引擎不可用：${redirect.problems.join('；')}`);
		}
		const sdk: object = await import('@earendil-works/pi-coding-agent');
		const missing = missingSdkExports(sdk);
		if (missing.length > 0) {
			throw new Error(`自定义 Pi 引擎（${redirect.version ?? '未知版本'}）缺少必需导出：${missing.join('、')}`);
		}
	}
	await import('./agentHostImpl.js');
}

bootstrap().catch((error: unknown) => {
	const detail = error instanceof Error ? error.message : String(error);
	fatal(process.env.PI_DESKTOP_ENGINE_DIR ? `自定义 Pi 引擎加载失败：${detail}` : `Pi 引擎初始化失败：${detail}`);
});
