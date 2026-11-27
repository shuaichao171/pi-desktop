import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
	UiAgentConfig,
	UiAgentModel,
	UiAgentOrchestratorConfig,
	UiAgentOrchestratorModel,
	UiAgentOrchestratorVariant,
} from '@pidesktop/shared';

export interface AntigravityOrchestratorSettings {
	planner?: string;
	executor?: string;
}

const EFFORT_PATTERN = /^(.+?)\s+\((Low|Medium|High|XHigh|Max)\)$/i;
const EFFORT_ORDER: Record<string, number> = { '': 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
const EFFORT_DISPLAY: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' };

const PRESET_TO_BASE_MODEL: Record<string, string[]> = {
	'gemini-pro-orchestrator-neon': ['Gemini 4 Neon', 'Gemini 4 Carbon', 'Gemini 4 Argon'],
	'gemini-pro-orchestrator': ['Gemini 4 Carbon', 'Gemini 4 Neon', 'Gemini 4 Argon'],
	'gemini-pro-orchestrator-argon': ['Gemini 4 Argon', 'Gemini 4 Carbon', 'Gemini 4 Neon'],
};

/** Whether an Antigravity ACP model ID selects Orchestrator mode. */
export function isAntigravityOrchestratorModel(modelId: string | null | undefined): boolean {
	return typeof modelId === 'string' && /^gemini-pro-orchestrator(?:-|$)/.test(modelId);
}

function flagValue(args: readonly string[], names: readonly string[]): string | null {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? '';
		for (const name of names) {
			if (arg === name && index + 1 < args.length) return args[index + 1] ?? null;
			if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
		}
	}
	return null;
}

function safeSubpath(value: string | null, fallback: string): string {
	if (!value) return fallback;
	const trimmed = value.trim();
	if (!trimmed || trimmed.includes('\0') || isAbsolute(trimmed) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(trimmed)) return fallback;
	return trimmed;
}

/** Resolve `~/.gemini/antigravity-cli/settings.json` (respecting `--gemini-dir`, `--app-data-dir`, `--cli_dir_name`). */
export function antigravitySettingsPath(config: Pick<UiAgentConfig, 'args'>, home = homedir()): string {
	const rawGemini = flagValue(config.args, ['--gemini-dir', '--gemini_dir']);
	// agy acp ignores relative --gemini-dir and falls back to ~/.gemini.
	const geminiDir = rawGemini && isAbsolute(rawGemini) ? resolve(rawGemini) : join(home, '.gemini');
	const appDataDir = safeSubpath(flagValue(config.args, ['--app-data-dir', '--app_data_dir']), 'antigravity-cli');
	const cliDirName = flagValue(config.args, ['--cli_dir_name']);
	const safeCliDir = cliDirName ? safeSubpath(cliDirName, '') : '';
	return join(geminiDir, appDataDir, ...(safeCliDir ? [safeCliDir] : []), 'settings.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Read Antigravity's saved `orchestrator` planner/executor labels from `settings.json`. */
export function readAntigravityOrchestratorSettings(file: string): AntigravityOrchestratorSettings {
	try {
		if (!existsSync(file)) return {};
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
		if (!isPlainObject(parsed) || !isPlainObject(parsed.orchestrator)) return {};
		const planner = typeof parsed.orchestrator.planner === 'string' ? parsed.orchestrator.planner.trim() : '';
		const executor = typeof parsed.orchestrator.executor === 'string' ? parsed.orchestrator.executor.trim() : '';
		return {
			...(planner ? { planner } : {}),
			...(executor ? { executor } : {}),
		};
	} catch {
		return {};
	}
}

/** Atomically update `orchestrator` inside Antigravity's `settings.json` without dropping any other keys. */
export function writeAntigravityOrchestratorSettings(file: string, patch: AntigravityOrchestratorSettings): void {
	let root: Record<string, unknown> = {};
	if (existsSync(file)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
		} catch {
			throw new Error('Antigravity settings.json 格式无效，无法保存 Orchestrator 配置');
		}
		if (!isPlainObject(parsed)) throw new Error('Antigravity settings.json 格式无效，无法保存 Orchestrator 配置');
		root = { ...parsed };
	}
	const prev = isPlainObject(root.orchestrator) ? { ...root.orchestrator } : {};
	if (patch.planner !== undefined) {
		if (patch.planner) prev.planner = patch.planner;
		else delete prev.planner;
	}
	if (patch.executor !== undefined) {
		if (patch.executor) prev.executor = patch.executor;
		else delete prev.executor;
	}
	if (Object.keys(prev).length > 0) root.orchestrator = prev;
	else delete root.orchestrator;

	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(root, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	renameSync(temp, file);
}

/** Group concrete `Model (Effort)` entries reported by `agy acp` into base models + effort variants. */
export function parseAntigravityOrchestratorModels(variantModels: readonly UiAgentModel[]): UiAgentOrchestratorModel[] {
	const byName = new Map<string, UiAgentOrchestratorVariant[]>();
	for (const item of variantModels) {
		if (isAntigravityOrchestratorModel(item.id) || /^Orchestrator\b/i.test(item.name)) continue;
		const full = item.name.trim();
		if (!full) continue;
		const match = EFFORT_PATTERN.exec(full);
		const baseName = match ? match[1]!.trim() : full;
		const effort = match ? match[2]!.toLowerCase() : '';
		const effortName = effort ? (EFFORT_DISPLAY[effort] ?? match![2]!) : '';
		const list = byName.get(baseName) ?? [];
		if (!list.some((existing) => existing.value === full)) {
			list.push({ value: full, effort, effortName });
			byName.set(baseName, list);
		}
	}
	const result: UiAgentOrchestratorModel[] = [];
	for (const [name, variants] of byName.entries()) {
		variants.sort((a, b) => (EFFORT_ORDER[a.effort] ?? 99) - (EFFORT_ORDER[b.effort] ?? 99));
		result.push({ name, variants });
	}
	return result;
}

function pickDefaultVariant(models: readonly UiAgentOrchestratorModel[], preferredNames: readonly string[], preferredEffort = 'high'): string {
	for (const target of preferredNames) {
		const model = models.find((item) => item.name.toLowerCase() === target.toLowerCase());
		if (model && model.variants.length) {
			return (
				model.variants.find((variant) => variant.effort === preferredEffort)
				?? model.variants.find((variant) => variant.effort === 'high')
				?? model.variants.find((variant) => variant.effort === 'medium')
				?? model.variants.at(-1)!
			).value;
		}
	}
	const fallback = models.find((item) => item.variants.length > 0);
	if (!fallback) return '';
	return (fallback.variants.find((variant) => variant.effort === preferredEffort) ?? fallback.variants.at(-1)!).value;
}

function hasVariant(models: readonly UiAgentOrchestratorModel[], value: string | undefined): value is string {
	if (!value) return false;
	return models.some((model) => model.variants.some((variant) => variant.value === value));
}

/** Build the descriptor payload exposed to the UI when Antigravity is running in Orchestrator mode. */
export function buildAntigravityOrchestratorConfig(input: {
	modelId: string | null | undefined;
	variantModels: readonly UiAgentModel[];
	settings: AntigravityOrchestratorSettings;
}): UiAgentOrchestratorConfig | null {
	if (!isAntigravityOrchestratorModel(input.modelId)) return null;
	const models = parseAntigravityOrchestratorModels(input.variantModels);
	if (!models.length) return null;
	const plannerPrefs = PRESET_TO_BASE_MODEL[input.modelId ?? ''] ?? PRESET_TO_BASE_MODEL['gemini-pro-orchestrator-neon']!;
	const defaultPlanner = pickDefaultVariant(models, plannerPrefs, 'high');
	const defaultExecutor = pickDefaultVariant(models, ['Gemini 4 Hydrogen', 'Gemini 3.8 Flash'], 'high');
	return {
		planner: {
			currentValue: hasVariant(models, input.settings.planner) ? input.settings.planner : defaultPlanner,
			defaultValue: defaultPlanner,
		},
		executor: {
			currentValue: hasVariant(models, input.settings.executor) ? input.settings.executor : defaultExecutor,
			defaultValue: defaultExecutor,
		},
		models,
	};
}

/** Map a chosen planner label back to the matching ACP Orchestrator preset ID when one exists. */
export function orchestratorPresetForPlanner(plannerValue: string, availablePresetIds: readonly string[]): string | null {
	const check = (prefix: RegExp, presetId: string) =>
		prefix.test(plannerValue) && availablePresetIds.includes(presetId) ? presetId : null;
	return (
		check(/^Gemini 4 Neon\b/i, 'gemini-pro-orchestrator-neon')
		?? check(/^Gemini 4 Carbon\b/i, 'gemini-pro-orchestrator')
		?? check(/^Gemini 4 Argon\b/i, 'gemini-pro-orchestrator-argon')
	);
}

/** Pick the matching planner variant when switching between Orchestrator (Neon/Carbon/Argon) presets. */
export function plannerForOrchestratorPreset(
	presetId: string,
	currentPlanner: string | undefined,
	models: readonly UiAgentOrchestratorModel[],
): string | null {
	const targetBase = PRESET_TO_BASE_MODEL[presetId]?.[0];
	if (!targetBase) return null;
	const targetModel = models.find((item) => item.name.toLowerCase() === targetBase.toLowerCase());
	if (!targetModel || !targetModel.variants.length) return null;
	const currentEffort = currentPlanner ? (EFFORT_PATTERN.exec(currentPlanner)?.[2]?.toLowerCase() ?? 'high') : 'high';
	const chosen =
		targetModel.variants.find((variant) => variant.effort === currentEffort)
		?? targetModel.variants.find((variant) => variant.effort === 'high')
		?? targetModel.variants.at(-1)!;
	return chosen.value;
}
