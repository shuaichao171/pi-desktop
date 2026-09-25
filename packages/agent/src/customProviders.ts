import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { UiDiscoverProviderModelsRequest, UiProviderApi, UiProviderHeaders, UiSaveCustomProviderRequest, UiThinkingLevel } from '@pidesktop/shared';

type JsonObject = Record<string, unknown>;
export interface ProviderDocument { raw: string | null; data: JsonObject & { providers: Record<string, JsonObject> } }
export const CUSTOM_PROVIDER_APIS: readonly UiProviderApi[] = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
const record = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
const emptyCredentials = { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} };
let builtinIds: Promise<Set<string>> | undefined;

export function getBuiltinProviderIds(): Promise<Set<string>> {
	return builtinIds ??= ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, credentials: emptyCredentials })
		.then((runtime) => new Set(runtime.getProviders().map((provider) => provider.id)));
}

/** AuthStorage interprets templates too: UI secrets must remain literal values. */
export function literalApiKey(key: string): string {
	const escaped = key.replaceAll('$', () => '$$');
	return escaped.startsWith('!') ? `$${escaped}` : escaped;
}

/** JSONC comments are accepted by Pi; strings and their escapes remain intact. */
function withoutComments(input: string): string {
	let result = ''; let quoted = false; let escaped = false;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index]!;
		if (quoted) {
			result += char;
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') quoted = false;
		} else if (char === '"') { quoted = true; result += char; }
		else if (char === '/' && input[index + 1] === '/') {
			while (index < input.length && input[index] !== '\n') index += 1;
			result += '\n';
		} else if (char === '/' && input[index + 1] === '*') {
			index += 2;
			while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) index += 1;
			if (index >= input.length) throw new Error('Invalid comment');
			index += 1; result += ' ';
		} else result += char;
	}
	return result;
}

export async function readProviderDocument(path: string): Promise<ProviderDocument> {
	let raw: string;
	try { raw = await readFile(path, 'utf8'); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: null, data: { providers: {} } };
		throw new Error('无法读取 models.json，未修改供应商配置');
	}
	try {
		if (raw.length > 8_000_000) throw new Error('Too large');
		const data: unknown = JSON.parse(withoutComments(raw.replace(/^\uFEFF/, '')));
		if (!record(data) || !record(data.providers) || Object.values(data.providers).some((provider) => !record(provider)
			|| (provider.models !== undefined && (!Array.isArray(provider.models) || provider.models.some((model) => !record(model) || typeof model.id !== 'string' || !model.id.trim())))
			|| ['name', 'baseUrl', 'api', 'apiKey'].some((key) => provider[key] !== undefined && (typeof provider[key] !== 'string' || !provider[key])))) throw new Error('Invalid document');
		return { raw, data: data as ProviderDocument['data'] };
	} catch { throw new Error('models.json 格式无效，请先修复原配置；未覆盖文件'); }
}

export function safeProviderUrl(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 2048) return null;
	try {
		const url = new URL(value);
		return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? value : null;
	} catch { return null; }
}

export function isEditableProvider(config: JsonObject): boolean {
	return typeof config.api === 'string' && CUSTOM_PROVIDER_APIS.includes(config.api as UiProviderApi)
		&& safeProviderUrl(config.baseUrl) !== null && !config.oauth && !config.modelOverrides
		&& Array.isArray(config.models) && config.models.length > 0
		&& config.models.every((model) => record(model) && typeof model.id === 'string' && !own(model, 'api') && !own(model, 'baseUrl'));
}

function text(value: unknown, label: string, maximum: number): string {
	if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label}无效`);
	return value.trim();
}

export function validateProviderId(value: unknown): string {
	const id = text(value, '供应商 ID', 80);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) throw new Error('供应商 ID 仅支持字母、数字、点、下划线和短横线');
	return id;
}

export function validateProviderHeaders(value: unknown): UiProviderHeaders {
	if (!record(value) || Object.keys(value).length > 64) throw new Error('最多设置 64 个请求头');
	const result: UiProviderHeaders = {};
	const names = new Set<string>();
	let size = 0;
	for (const [name, header] of Object.entries(value)) {
		const lower = name.toLowerCase();
		if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(name) || name.length > 256 || names.has(lower)
			|| /^(?:host|connection|content-length|transfer-encoding|proxy-authorization|proxy-connection|upgrade|trailer|te)$/iu.test(name)) throw new Error('请求头名称无效、重复或不可自定义');
		if (header !== null && (typeof header !== 'string' || header.length > 16384 || /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(header))) throw new Error('请求头值无效');
		try { if (header !== null) new Headers({ [name]: header }); } catch { throw new Error('请求头值无效'); }
		size += name.length + (header?.length ?? 0);
		if (size > 32768) throw new Error('请求头总长度不能超过 32 KB');
		names.add(lower);
		Object.defineProperty(result, name, { value: header, enumerable: true, writable: true, configurable: true });
	}
	return result;
}

/** Keep stored expressions opaque; new values must never become Pi shell/env templates. */
export function mergeProviderHeaders(previous: unknown, headers: UiProviderHeaders): Record<string, string> {
	const stored = record(previous) ? previous : {};
	return Object.fromEntries(Object.entries(headers).map(([name, value]) => {
		if (value !== null) return [name, literalApiKey(value)];
		const key = Object.keys(stored).find((item) => item.toLowerCase() === name.toLowerCase());
		if (!key || typeof stored[key] !== 'string') throw new Error('要保留的请求头已不存在，请刷新后重试');
		return [name, stored[key]];
	}));
}

export function validateDiscoveryRequest(value: unknown): UiDiscoverProviderModelsRequest {
	if (!record(value) || Object.keys(value).some((key) => !['provider', 'baseUrl', 'api', 'apiKey', 'headers', 'useSystemProxy'].includes(key))) throw new Error('获取模型的参数无效');
	const provider = value.provider === undefined ? undefined : validateProviderId(value.provider);
	const baseUrl = value.baseUrl === undefined ? undefined : text(value.baseUrl, '供应商 URL', 2048);
	if ((!provider && !baseUrl) || (baseUrl && !safeProviderUrl(baseUrl))) throw new Error('请先配置有效的供应商 URL');
	if ((baseUrl && value.api === undefined) || (value.api !== undefined && !CUSTOM_PROVIDER_APIS.includes(value.api as UiProviderApi))) throw new Error('请选择支持的对话协议');
	if (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || !value.apiKey.trim() || value.apiKey.length > 16384 || /[\u0000-\u001f\u007f]/u.test(value.apiKey))) throw new Error('API Key 无效');
	if (value.useSystemProxy !== undefined && typeof value.useSystemProxy !== 'boolean') throw new Error('代理设置无效');
	return { ...(provider ? { provider } : {}), ...(baseUrl ? { baseUrl } : {}), ...(value.api ? { api: value.api as UiProviderApi } : {}),
		...(value.apiKey === undefined ? {} : { apiKey: (value.apiKey as string).trim() }),
		...(value.headers === undefined ? {} : { headers: validateProviderHeaders(value.headers) }),
		...(value.useSystemProxy === undefined ? {} : { useSystemProxy: value.useSystemProxy }) };
}

export function validateProviderRequest(value: unknown): UiSaveCustomProviderRequest {
	if (!record(value) || Object.keys(value).some((key) => !['provider', 'name', 'baseUrl', 'api', 'apiKey', 'models', 'mode', 'headers', 'useSystemProxy'].includes(key))) throw new Error('供应商参数无效');
	const provider = validateProviderId(value.provider);
	const baseUrl = text(value.baseUrl, '供应商 URL', 2048);
	if (!safeProviderUrl(baseUrl)) throw new Error('URL 只支持 HTTP/HTTPS，不能包含用户名、密码、查询参数或片段');
	if (!CUSTOM_PROVIDER_APIS.includes(value.api as UiProviderApi)) throw new Error('不支持此对话协议');
	if (value.mode !== undefined && value.mode !== 'create' && value.mode !== 'update') throw new Error('供应商保存模式无效');
	if (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || !value.apiKey.trim() || value.apiKey.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value.apiKey))) throw new Error('API Key 无效');
	if (value.useSystemProxy !== undefined && typeof value.useSystemProxy !== 'boolean') throw new Error('代理设置无效');
	const headers = value.headers === undefined ? undefined : validateProviderHeaders(value.headers);
	if (!Array.isArray(value.models) || value.models.length < 1 || value.models.length > 1000) throw new Error('请配置 1–1000 个模型');
	const ids = new Set<string>();
	const models = value.models.map((model) => {
		if (!record(model) || Object.keys(model).some((key) => !['id', 'name', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'thinkingLevelMap'].includes(key))) throw new Error('模型参数无效');
		const id = text(model.id, '模型 ID', 200);
		if (ids.has(id)) throw new Error('同一供应商不能包含重复模型 ID');
		ids.add(id);
		if (model.reasoning !== undefined && typeof model.reasoning !== 'boolean') throw new Error('模型思考能力参数无效');
		if (model.thinkingLevelMap !== undefined && (!record(model.thinkingLevelMap) || Object.entries(model.thinkingLevelMap).some(([key, mapped]) =>
			!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(key) || (mapped !== null && (typeof mapped !== 'string' || !mapped.trim() || mapped.length > 80 || /[\u0000-\u001f\u007f]/u.test(mapped)))))) throw new Error('模型思考强度映射无效');
		const input = model.input ?? ['text'];
		if (!Array.isArray(input) || !input.includes('text') || input.length > 2 || new Set(input).size !== input.length || input.some((item) => item !== 'text' && item !== 'image')) throw new Error('模型输入必须包含文本，可额外支持图片');
		const contextWindow = model.contextWindow ?? 128000;
		const maxTokens = model.maxTokens ?? Math.min(16384, Number(contextWindow));
		if (!Number.isSafeInteger(contextWindow) || Number(contextWindow) <= 0 || Number(contextWindow) > 100_000_000
			|| !Number.isSafeInteger(maxTokens) || Number(maxTokens) <= 0 || Number(maxTokens) > 100_000_000
			|| (value.api !== 'google-generative-ai' && Number(maxTokens) > Number(contextWindow))) throw new Error('模型 token 限额无效；非 Gemini 模型的输出限额不能超过上下文容量');
		return { id, name: model.name === undefined ? id : text(model.name, '模型名称', 200), reasoning: model.reasoning ?? false,
			input: input as ('text' | 'image')[], contextWindow: Number(contextWindow), maxTokens: Number(maxTokens),
			...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...model.thinkingLevelMap } as Partial<Record<UiThinkingLevel, string | null>> }) };
	});
	return { provider, name: value.name === undefined ? provider : text(value.name, '供应商名称', 200), baseUrl, api: value.api as UiProviderApi,
		models, ...(headers === undefined ? {} : { headers }), ...(value.useSystemProxy === undefined ? {} : { useSystemProxy: value.useSystemProxy }),
		...(value.apiKey === undefined ? {} : { apiKey: (value.apiKey as string).trim() }), ...(value.mode === undefined ? {} : { mode: value.mode }) };
}

export function mergeProvider(document: ProviderDocument, request: UiSaveCustomProviderRequest): ProviderDocument['data'] {
	const previous = own(document.data.providers, request.provider) ? document.data.providers[request.provider]! : {};
	const previousModels = new Map((Array.isArray(previous.models) ? previous.models : []).filter(record).map((model) => [model.id, model]));
	return { ...document.data, providers: { ...document.data.providers, [request.provider]: {
		...previous, name: request.name, baseUrl: request.baseUrl, api: request.api,
		...(request.headers === undefined ? {} : { headers: mergeProviderHeaders(previous.headers, request.headers) }),
		...(request.useSystemProxy === undefined ? {} : { desktopUseSystemProxy: request.useSystemProxy }),
		models: request.models.map((model) => ({ ...previousModels.get(model.id), ...model })),
	} } };
}

export async function validateProviderWithSdk(directory: string, provider: string, config: JsonObject): Promise<void> {
	await mkdir(directory, { recursive: true });
	const path = join(directory, `.models-validate-${randomUUID()}.json`);
	try {
		await writeFile(path, JSON.stringify({ providers: { [provider]: config } }), { flag: 'wx', mode: 0o600 });
		const runtime = await ModelRuntime.create({ modelsPath: path, refreshOnCreate: false, allowModelNetwork: false, credentials: emptyCredentials });
		if (runtime.getError() || !runtime.getProvider(provider) || runtime.getModels(provider).length === 0) throw new Error('供应商配置未通过 Pi 校验');
	} catch { throw new Error('供应商配置未通过 Pi 校验，请检查模型和协议参数'); }
	finally { await unlink(path).catch(() => {}); }
}

async function atomicWrite(path: string, raw: string): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try { await writeFile(temporary, raw, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
	finally { await unlink(temporary).catch(() => {}); }
}

export async function commitProviderDocument(path: string, previous: ProviderDocument, data: ProviderDocument['data']): Promise<() => Promise<void>> {
	await mkdir(dirname(path), { recursive: true });
	const current = await readProviderDocument(path);
	if (current.raw !== previous.raw) throw new Error('models.json 已被其他程序修改，请刷新后重试');
	const written = JSON.stringify(data, null, 2) + '\n';
	if (previous.raw !== null) await atomicWrite(`${path}.pi-desktop-backup`, previous.raw);
	await atomicWrite(path, written);
	return async () => {
		const latest = await readProviderDocument(path);
		if (latest.raw !== written) throw new Error('配置已被其他程序修改，未覆盖后续更改');
		if (previous.raw === null) await unlink(path);
		else await atomicWrite(path, previous.raw);
	};
}
