export type UiAgentErrorKind = 'auth' | 'rate-limit' | 'context' | 'network' | 'model-unavailable' | 'validation' | 'unknown';
export type UiAgentErrorSource = 'provider' | 'transport' | 'runtime' | 'extension' | 'desktop';

/** Safe, renderer-facing evidence for an agent failure. Provider bodies and secrets are never copied verbatim. */
export interface UiAgentError {
	message: string;
	kind: UiAgentErrorKind;
	source: UiAgentErrorSource;
	code?: string;
	provider?: string;
	status?: number;
	retryable?: boolean;
	traceId?: string;
	detail?: string;
}

type ErrorRecord = Record<string, unknown>;
const MAX_MESSAGE = 8000;
const MAX_DETAIL = 4000;
const text = (value: unknown, maximum: number): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : undefined;
const record = (value: unknown): ErrorRecord | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ErrorRecord : null;

function number(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) return Number(value);
	return undefined;
}

const ERROR_KINDS = new Set<string>(['auth', 'rate-limit', 'context', 'network', 'model-unavailable', 'validation']);

export function classifyStructuredAgentError(input: { message: string; code?: string; status?: number }): UiAgentErrorKind {
	const evidence = `${input.code ?? ''} ${input.message}`.toLocaleLowerCase();
	if (input.status === 401 || input.status === 403 || /unauth|forbidden|invalid[_ -]?(?:api[_ -]?key|token)|credential|鉴权|认证|密钥|令牌/.test(evidence)) return 'auth';
	if (input.status === 429 || /rate[_ -]?limit|too many requests|quota|限流|频率|配额/.test(evidence)) return 'rate-limit';
	if (/context[_ -]?(?:window|length|size|limit)|token[_ -]?limit|maximum context|prompt[_ -]?too[_ -]?long|上下文|过长/.test(evidence)) return 'context';
	if (/model[_ -]?(?:not[_ -]?found|unavailable|disabled)|no[_ -]?(?:available[_ -]?)?model|provider[_ -]?not[_ -]?ready|没有可用模型|模型不可用|模型已禁用/.test(evidence)) return 'model-unavailable';
	if (input.status === 408 || input.status === 502 || input.status === 503 || input.status === 504 || /network|timeout|timed[_ -]?out|econn|enotfound|fetch[_ -]?failed|socket|transport|网络|超时|连接/.test(evidence)) return 'network';
	if (/invalid[_ -]?(?:request|input|argument)|validation|参数无效|输入无效/.test(evidence)) return 'validation';
	return 'unknown';
}

/** Normalizes unknown SDK/provider errors while preferring structured status/code evidence over message heuristics. */
export function normalizeAgentError(error: unknown, source: UiAgentErrorSource = 'runtime'): UiAgentError {
	const outer = record(error);
	const cause = record(outer?.cause);
	const message = text(outer?.message, MAX_MESSAGE) ?? (error instanceof Error ? text(error.message, MAX_MESSAGE) : undefined) ?? text(error, MAX_MESSAGE) ?? 'Unknown agent error';
	const code = text(outer?.code, 160) ?? text(cause?.code, 160) ?? text(outer?.errorCode, 160);
	const status = number(outer?.status) ?? number(outer?.statusCode) ?? number(cause?.status) ?? number(cause?.statusCode);
	const provider = text(outer?.provider, 160) ?? text(cause?.provider, 160);
	const traceId = text(outer?.traceId, 256) ?? text(outer?.requestId, 256) ?? text(cause?.traceId, 256) ?? text(cause?.requestId, 256);
	const nested = text(cause?.message, MAX_DETAIL);
	const detail = nested && nested !== message ? nested : undefined;
	// Structured evidence wins: an explicit kind from createAgentError survives normalization.
	const explicitKind = typeof outer?.kind === 'string' && ERROR_KINDS.has(outer.kind) ? outer.kind as UiAgentErrorKind
		: typeof cause?.kind === 'string' && ERROR_KINDS.has(cause.kind) ? cause.kind as UiAgentErrorKind : undefined;
	const kind = explicitKind ?? classifyStructuredAgentError({ message, code, status });
	const explicitRetryable = typeof outer?.retryable === 'boolean' ? outer.retryable : typeof cause?.retryable === 'boolean' ? cause.retryable : undefined;
	return {
		message,
		kind,
		source: source !== 'runtime' ? source : kind === 'network' ? 'transport'
			: kind === 'auth' || kind === 'rate-limit' || kind === 'model-unavailable' || kind === 'validation' ? 'provider' : 'runtime',
		...(code ? { code } : {}),
		...(provider ? { provider } : {}),
		...(status !== undefined ? { status } : {}),
		...(explicitRetryable !== undefined ? { retryable: explicitRetryable } : kind === 'network' || kind === 'rate-limit' ? { retryable: true } : {}),
		...(traceId ? { traceId } : {}),
		...(detail ? { detail } : {}),
	};
}

/** Creates an Error whose enumerable evidence survives local RPC adapters; events still carry normalizeAgentError output explicitly. */
export function createAgentError(info: Omit<UiAgentError, 'source'> & { source?: UiAgentErrorSource }): Error {
	const error = new Error(info.message) as Error & ErrorRecord;
	Object.assign(error, info, { source: info.source ?? 'runtime' });
	return error;
}
