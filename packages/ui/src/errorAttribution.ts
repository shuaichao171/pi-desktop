/**
 * Error attribution (4.4): maps raw model/transport errors onto a small set of
 * actionable kinds so the run-status bar can suggest the right fix instead of
 * showing every failure as a generic red banner. Mirrors ZCode's
 * chatErrorAttribution / usageErrorCopy direction.
 */
export type UiErrorKind = 'auth' | 'rate-limit' | 'context' | 'network' | 'unknown';

const PATTERNS: ReadonlyArray<{ kind: UiErrorKind; pattern: RegExp }> = [
	// Authentication/permission problems point at provider credentials.
	{ kind: 'auth', pattern: /\b(401|403)\b|unauthorized|forbidden|invalid[ _-]?(api[ _-]?key|token)|api[ _-]?key|鉴权|认证|密钥|令牌/i },
	// Provider throttling suggests waiting rather than retrying immediately.
	{ kind: 'rate-limit', pattern: /\b429\b|rate[ _-]?limit|too many requests|quota|限流|频率|配额/i },
	// Context overflow points at compaction.
	{ kind: 'context', pattern: /context[ _-]?(window|length|size|limit)|token[ _-]?limit|maximum context|prompt[ _-]?too[ _-]?long|上下文|过长/i },
	// Connectivity failures can simply be retried.
	{ kind: 'network', pattern: /\b(network|timeout|timed?[ _-]?out|econnrefused|enotfound|fetch[ _-]?failed|socket|abort)\b|网络|超时|连接/i },
];

/** Classifies a raw error message; order matters (auth before network, etc.). */
export function classifyAgentError(message: string): UiErrorKind {
	if (!message) return 'unknown';
	for (const { kind, pattern } of PATTERNS) {
		if (pattern.test(message)) return kind;
	}
	return 'unknown';
}
