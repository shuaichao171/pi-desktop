import type { UiDiscoveredProviderModel, UiProviderApi, UiProviderModelDiscovery, UiThinkingLevel } from '@pidesktop/shared';

export interface DiscoverProviderModelsOptions {
	baseUrl: string;
	api: UiProviderApi;
	apiKey?: string;
	headers?: Record<string, string>;
}

export type DiscoveredProviderModel = UiDiscoveredProviderModel;

type DiscoveryErrorCode = 'invalid_request' | 'network' | 'timeout' | 'http' | 'redirect' | 'invalid_response' | 'response_too_large';
export class ProviderDiscoveryError extends Error {
	readonly code: DiscoveryErrorCode;
	readonly status?: number;
	constructor(code: DiscoveryErrorCode, message: string, status?: number) {
		super(message);
		this.name = 'ProviderDiscoveryError';
		this.code = code;
		this.status = status;
	}
}

type JsonObject = Record<string, unknown>;
const APIS: readonly string[] = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
const LEVELS: UiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MAX_PAGES = 10;
const MAX_MODELS = 1000;
const MAX_PAGE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 8_000_000;
const TIMEOUT_MS = 15_000;
const record = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value: unknown, maximum = 200): string | undefined => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : undefined;
const positiveInteger = (...values: unknown[]): number | undefined => values.find((value) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 100_000_000) as number | undefined;
const boolean = (...values: unknown[]): boolean | undefined => values.find((value) => typeof value === 'boolean') as boolean | undefined;
const object = (value: unknown): JsonObject => record(value) ? value : {};

function endpoint(options: DiscoverProviderModelsOptions): URL {
	if (!options || !APIS.includes(options.api) || typeof options.baseUrl !== 'string' || options.baseUrl.length > 2048) {
		throw new ProviderDiscoveryError('invalid_request', '模型发现参数无效');
	}
	let url: URL;
	try { url = new URL(options.baseUrl); } catch { throw new ProviderDiscoveryError('invalid_request', '供应商 URL 无效'); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new ProviderDiscoveryError('invalid_request', '供应商 URL 只支持 HTTP/HTTPS，不能包含凭据、查询参数或片段');
	}
	let path = url.pathname.replace(/\/+$/u, '');
	if (/\/models$/u.test(path)) { url.pathname = path; return url; }
	// Accept either an API root or a pasted endpoint without duplicating its version.
	path = path.replace(/\/(?:chat\/completions|responses|messages)$/u, '');
	if (options.api === 'google-generative-ai' && !/\/v\d+(?:beta\d*|alpha\d*)?$/u.test(path)) path += '/v1beta';
	else if (options.api === 'anthropic-messages' && !/\/v\d+(?:beta\d*|alpha\d*)?$/u.test(path)) path += '/v1';
	else if (!path) path = '/v1';
	url.pathname = `${path}/models`;
	return url;
}

function requestHeaders(options: DiscoverProviderModelsOptions): Headers {
	try {
		const headers = new Headers({ Accept: 'application/json' });
		const custom = options.headers ?? {};
		if (!record(custom) || Object.keys(custom).length > 64) throw new Error();
		let totalSize = 0;
		for (const [name, value] of Object.entries(custom)) {
			if (typeof value !== 'string' || /[\r\n\u0000]/u.test(value) || /^(?:host|connection|content-length|transfer-encoding|proxy-authorization|proxy-connection|upgrade|trailer|te)$/iu.test(name)) throw new Error();
			totalSize += name.length + value.length;
			if (totalSize > 32_768) throw new Error();
			headers.set(name, value);
		}
		if (options.apiKey !== undefined) {
			if (typeof options.apiKey !== 'string' || !options.apiKey.trim() || options.apiKey.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(options.apiKey)) throw new Error();
			const key = options.apiKey.trim();
			const name = options.api === 'anthropic-messages' ? 'x-api-key' : options.api === 'google-generative-ai' ? 'x-goog-api-key' : 'authorization';
			if (!headers.has(name)) headers.set(name, name === 'authorization' ? `Bearer ${key}` : key);
		}
		if (options.api === 'anthropic-messages' && !headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
		return headers;
	} catch { throw new ProviderDiscoveryError('invalid_request', '模型发现请求头或 API Key 无效'); }
}

function thinkingLevels(value: JsonObject): UiThinkingLevel[] | undefined {
	const capabilities = object(value.capabilities);
	const effort = object(capabilities.effort);
	const thinking = object(capabilities.thinking);
	const candidates = [value.thinkingLevels, value.thinking_levels, value.supportedThinkingLevels, value.reasoning_efforts,
		value.supported_reasoning_efforts, effort.levels, effort.supported_levels, thinking.levels];
	const advertised = candidates.find(Array.isArray) as unknown[] | undefined;
	const result = new Set<UiThinkingLevel>();
	for (const item of advertised ?? []) {
		if (item === 'none') result.add('off');
		else if (LEVELS.includes(item as UiThinkingLevel)) result.add(item as UiThinkingLevel);
	}
	// Anthropic advertises supported effort levels as booleans on capabilities.effort.
	if (effort.supported !== false) for (const level of LEVELS) if (effort[level] === true) result.add(level);
	return result.size ? LEVELS.filter((level) => result.has(level)) : undefined;
}

function parseModel(value: unknown, api: UiProviderApi): DiscoveredProviderModel | null {
	if (!record(value)) return null;
	const google = api === 'google-generative-ai';
	const id = safeText(google ? (typeof value.name === 'string' ? value.name.replace(/^models\//u, '') : value.id) : value.id);
	if (!id) return null;
	// Gemini includes embedding-only models, which cannot serve generateContent requests.
	if (google && Array.isArray(value.supportedGenerationMethods) && !value.supportedGenerationMethods.some((method) => method === 'generateContent' || method === 'streamGenerateContent')) return null;
	const result: DiscoveredProviderModel = { id };
	const name = safeText(value.display_name ?? value.displayName ?? (google ? undefined : value.name));
	if (name) result.name = name;
	const topProvider = object(value.top_provider);
	const context = positiveInteger(value.contextWindow, value.context_window, value.context_length, value.max_context_length, value.max_input_tokens, value.inputTokenLimit, topProvider.context_length);
	const output = positiveInteger(value.maxTokens, value.max_tokens, value.max_output_tokens, value.outputTokenLimit, topProvider.max_completion_tokens);
	if (context !== undefined) result.contextWindow = context;
	// Some APIs (notably Gemini) report independent input and output limits.
	// Preserve both advertised numbers; configuration validation owns their use.
	if (output !== undefined) result.maxTokens = output;
	const capabilities = object(value.capabilities);
	const reasoning = boolean(value.reasoning, value.supports_reasoning, value.supportsThinking, value.thinking, capabilities.reasoning, object(capabilities.reasoning).supported, capabilities.thinking, object(capabilities.thinking).supported);
	const levels = thinkingLevels(value);
	if (levels) result.thinkingLevels = levels;
	if (reasoning !== undefined) result.reasoning = reasoning;
	else if (levels?.some((level) => level !== 'off') || (Array.isArray(value.supported_parameters) && value.supported_parameters.some((parameter) => parameter === 'reasoning' || parameter === 'reasoning_effort'))) result.reasoning = true;
	const modalities = [value.input, value.input_modalities, object(value.architecture).input_modalities].find(Array.isArray) as unknown[] | undefined;
	if (modalities?.includes('text')) result.input = modalities.includes('image') ? ['text', 'image'] : ['text'];
	return result;
}

async function readJson(response: Response, budget: { bytes: number }): Promise<JsonObject> {
	const length = response.headers.get('content-length');
	if (length !== null && Number(length) > MAX_PAGE_BYTES) {
		await response.body?.cancel();
		throw new ProviderDiscoveryError('response_too_large', '模型列表响应过大，请缩小供应商返回的列表后重试');
	}
	if (!response.body) throw new ProviderDiscoveryError('invalid_response', '供应商未返回有效模型列表');
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			budget.bytes += chunk.value.byteLength;
			if (bytes > MAX_PAGE_BYTES || budget.bytes > MAX_TOTAL_BYTES) {
				await reader.cancel();
				throw new ProviderDiscoveryError('response_too_large', '模型列表响应过大，请缩小供应商返回的列表后重试');
			}
			chunks.push(chunk.value);
		}
	} finally { reader.releaseLock(); }
	const buffer = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(buffer));
		if (!record(value)) throw new Error();
		return value;
	} catch { throw new ProviderDiscoveryError('invalid_response', '供应商返回的模型列表格式无效'); }
}

async function fetchPage(url: URL, headers: Headers, signal: AbortSignal, fetchImpl: typeof fetch): Promise<Response> {
	let next = url;
	for (let redirects = 0; redirects <= 3; redirects += 1) {
		const response = await fetchImpl(next, { method: 'GET', headers, signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' });
		if (response.url && new URL(response.url).origin !== url.origin) {
			await response.body?.cancel();
			throw new ProviderDiscoveryError('redirect', '模型发现已拒绝跨源重定向，未转发登录凭据');
		}
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get('location');
			await response.body?.cancel();
			let redirected: URL;
			try { if (!location) throw new Error(); redirected = new URL(location, next); } catch {
				throw new ProviderDiscoveryError('redirect', '供应商返回了无效的模型列表重定向');
			}
			if (redirected.origin !== url.origin || redirected.username || redirected.password || redirects === 3) {
				throw new ProviderDiscoveryError('redirect', '模型发现已拒绝跨源或过多重定向，未向其他来源转发登录凭据');
			}
			next = redirected;
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new ProviderDiscoveryError('http', `获取模型列表失败（HTTP ${response.status}）`, response.status);
		}
		return response;
	}
	throw new ProviderDiscoveryError('redirect', '模型列表重定向次数过多');
}

async function discover(options: DiscoverProviderModelsOptions, url: URL, headers: Headers, signal: AbortSignal, fetchImpl: typeof fetch): Promise<UiProviderModelDiscovery> {
	const models = new Map<string, DiscoveredProviderModel>();
	const warnings = new Set<string>();
	const cursors = new Set<string>();
	const budget = { bytes: 0 };
	const google = options.api === 'google-generative-ai';
	const anthropic = options.api === 'anthropic-messages';
	if (google) url.searchParams.set('pageSize', '1000');
	if (anthropic) url.searchParams.set('limit', '1000');
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const json = await readJson(await fetchPage(url, headers, signal, fetchImpl), budget);
		const entries = google ? json.models : json.data;
		if (!Array.isArray(entries)) throw new ProviderDiscoveryError('invalid_response', '供应商返回的模型列表格式无效');
		for (const entry of entries) {
			const model = parseModel(entry, options.api);
			if (!model || models.has(model.id)) continue;
			if (models.size >= MAX_MODELS) { warnings.add('模型数量超过 1000，仅显示前 1000 个模型。'); break; }
			models.set(model.id, model);
		}
		const hasMore = google ? typeof json.nextPageToken === 'string' && json.nextPageToken.length > 0 : json.has_more === true;
		if (!hasMore) break;
		if (models.size >= MAX_MODELS || page === MAX_PAGES - 1) { warnings.add('模型列表尚有更多分页，已达到本次发现限制，结果可能不完整。'); break; }
		const cursor = safeText(google ? json.nextPageToken : json.last_id, 2048);
		if (!cursor || cursors.has(cursor)) throw new ProviderDiscoveryError('invalid_response', '供应商模型列表分页信息无效或重复');
		cursors.add(cursor);
		url.searchParams.set(google ? 'pageToken' : 'after_id', cursor);
	}
	if ([...models.values()].some((model) => model.contextWindow === undefined || model.maxTokens === undefined || model.reasoning === undefined)) {
		warnings.add('部分模型未返回完整的上下文、输出限额或思考能力，请在保存前确认；未根据模型名称推测能力。');
	}
	if ([...models.values()].some((model) => model.reasoning === true && model.thinkingLevels === undefined)) {
		warnings.add('部分模型支持思考，但接口未返回支持的思考强度，请手动确认可用级别。');
	}
	return { models: [...models.values()], warnings: [...warnings] };
}

/** Read-only model discovery; never persists configuration or contacts another origin. */
export async function discoverProviderModels(options: DiscoverProviderModelsOptions, fetchImpl: typeof fetch = fetch): Promise<UiProviderModelDiscovery> {
	const url = endpoint(options);
	const headers = requestHeaders(options);
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => { controller.abort(); reject(new ProviderDiscoveryError('timeout', '获取模型列表超时，请检查供应商连接后重试')); }, TIMEOUT_MS);
	});
	try {
		return await Promise.race([discover(options, url, headers, controller.signal, fetchImpl), timeout]);
	} catch (error) {
		if (error instanceof ProviderDiscoveryError) throw error;
		// Fetch errors can embed the URL, request headers, or provider response; do not expose them.
		throw new ProviderDiscoveryError(controller.signal.aborted ? 'timeout' : 'network', controller.signal.aborted ? '获取模型列表超时，请检查供应商连接后重试' : '无法连接供应商以获取模型列表，请检查地址、网络和凭据');
	} finally { clearTimeout(timer); controller.abort(); }
}
