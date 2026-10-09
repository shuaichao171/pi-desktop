import type { UiThinkingLevel } from '@pidesktop/shared';

export interface ReasoningGuess {
	reasoning: boolean;
	/** Pi levels offered when the model reasons; undefined for known non-reasoning families. */
	levels?: UiThinkingLevel[];
}

interface CapabilityRule {
	/** Case-insensitive match against the model id (e.g. "zai-org/GLM-5.3"). */
	match: RegExp;
	reasoning?: boolean;
	levels?: UiThinkingLevel[];
	/**
	 * Conservative context window in tokens. Values mirror zcode's builtin catalog
	 * where known; when unsure we deliberately underestimate — compaction just
	 * triggers early instead of the request failing on an oversized context.
	 */
	contextWindow?: number;
}

// Common effort ladders mapped to pi's canonical levels. Values are deliberately
// conservative: providers accepting fewer efforts reject extras loudly, while a
// missing level just hides an option the user could still map by hand.
const OPENAI_EFFORT: UiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];
const STANDARD: UiThinkingLevel[] = ['off', 'low', 'medium', 'high'];
const GLM: UiThinkingLevel[] = ['off', 'low', 'high', 'max'];
const GROK: UiThinkingLevel[] = ['off', 'low', 'high'];

// Ordered rules. Capabilities resolve independently (first matching rule that
// defines the capability wins): the [1m] suffix only contributes a context
// window, so the reasoning family rules still apply to the same model id.
// Negative (known non-reasoning) families come before vendor prefixes, and
// reasoning families run from specific variants to the general family.
const RULES: readonly CapabilityRule[] = [
	// Aggregator convention: ids suffixed with "[1m]" select the 1M-context variant.
	{ match: /\[1m\]/i, contextWindow: 1_000_000 },
	// Non-reasoning or non-chat models.
	{ match: /embedding|bge-|rerank|whisper|tts|dalle|sora|moderation|guard|voice|realtime/i, reasoning: false },
	{ match: /(?:^|[^a-z0-9])(?:gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-3\.5|gpt-4$|chatgpt|davinci|o1-mini|o3-mini)/i, reasoning: false, contextWindow: 128_000 },
	{ match: /claude-(?:[123]|instant|2\.)/i, reasoning: false, contextWindow: 200_000 },
	{ match: /gemini-(?:[01]|2\.0)/i, reasoning: false, contextWindow: 1_048_576 },
	{ match: /deepseek-chat/i, reasoning: false, contextWindow: 128_000 },
	{ match: /qwen-?(?:[12]|2\.5)(?![\d.])/i, reasoning: false, contextWindow: 32_768 },
	{ match: /glm-(?:[1234]|4\.[0-4])(?![\d.])/i, reasoning: false, contextWindow: 131_072 },
	{ match: /kimi-k?2(?![\d.])/i, reasoning: false, contextWindow: 262_144 },
	// Reasoning families, specific variants first.
	{ match: /gpt-(?:5\.6|5\.4-pro|6-astra)/i, reasoning: true, levels: OPENAI_EFFORT, contextWindow: 1_050_000 },
	{ match: /gpt-5\.4-(?:mini|nano)/i, reasoning: true, levels: OPENAI_EFFORT, contextWindow: 400_000 },
	{ match: /gpt-[56]|codex/i, reasoning: true, levels: OPENAI_EFFORT, contextWindow: 400_000 },
	{ match: /(?:^|[^a-z0-9])o[34](?:[^a-z0-9]|$)/i, reasoning: true, levels: OPENAI_EFFORT, contextWindow: 200_000 },
	{ match: /glm-5\.[23]/i, reasoning: true, levels: GLM, contextWindow: 1_000_000 },
	{ match: /glm-4\.[5-9]/i, reasoning: true, levels: GLM, contextWindow: 131_072 },
	{ match: /glm-[5-9]/i, reasoning: true, levels: GLM, contextWindow: 200_000 },
	{ match: /claude-(?:fable|mythos|opus|sonnet)-?[5-9]/i, reasoning: true, levels: STANDARD, contextWindow: 1_000_000 },
	{ match: /claude-(?:opus|sonnet|haiku|fable|[4-9])/i, reasoning: true, levels: STANDARD, contextWindow: 200_000 },
	{ match: /grok-4\.3/i, reasoning: true, levels: GROK, contextWindow: 1_000_000 },
	{ match: /grok-4\.6/i, reasoning: true, levels: GROK, contextWindow: 500_000 },
	{ match: /grok-(?:[4-9]|3-mini)/i, reasoning: true, levels: GROK, contextWindow: 256_000 },
	{ match: /deepseek-(?:v[4-9]|v3\.[2-9])/i, reasoning: true, levels: STANDARD, contextWindow: 1_000_000 },
	{ match: /deepseek-reasoner/i, reasoning: true, levels: STANDARD, contextWindow: 128_000 },
	{ match: /kimi-k[3-9]/i, reasoning: true, levels: STANDARD, contextWindow: 1_048_576 },
	{ match: /kimi-k2\.[5-9]/i, reasoning: true, levels: STANDARD, contextWindow: 262_144 },
	{ match: /qwen3\.8-omni/i, reasoning: true, levels: STANDARD, contextWindow: 65_536 },
	{ match: /qwen-?3\.[5-9]|qwen-[4-9]|qwen-(?:plus|flash)/i, reasoning: true, levels: STANDARD, contextWindow: 1_000_000 },
	{ match: /qwen3-(?:max|vl)/i, reasoning: true, levels: STANDARD, contextWindow: 262_144 },
	{ match: /qwen(?:3|[4-9])/i, reasoning: true, levels: STANDARD, contextWindow: 131_072 },
	{ match: /gemini-(?:[3-9]|2\.5)/i, reasoning: true, levels: STANDARD, contextWindow: 1_048_576 },
	{ match: /minimax-m[3-9]/i, reasoning: true, levels: STANDARD, contextWindow: 1_000_000 },
	{ match: /minimax|abab/i, reasoning: true, levels: STANDARD, contextWindow: 204_800 },
	{ match: /(?:^|\/)(?:hy[3-9]|hunyuan)/i, reasoning: true, levels: STANDARD },
	{ match: /(?:^|\/)step-[3-9]/i, reasoning: true, levels: STANDARD },
	{ match: /mimo-v?[2-9]/i, reasoning: true, levels: STANDARD, contextWindow: 262_144 },
	{ match: /inkling|nemotron|longcat|seed-/i, reasoning: true, levels: STANDARD },
];

/** Best-effort reasoning guess from the model id alone; undefined when no rule matches. */
export function guessReasoning(modelId: string): ReasoningGuess | undefined {
	const rule = RULES.find((rule) => rule.reasoning !== undefined && rule.match.test(modelId));
	if (!rule) return undefined;
	return { reasoning: rule.reasoning as boolean, ...(rule.levels ? { levels: rule.levels } : {}) };
}

/** Best-effort context window guess (tokens) from the model id alone; undefined when unknown. */
export function guessContextWindow(modelId: string): number | undefined {
	return RULES.find((rule) => rule.contextWindow !== undefined && rule.match.test(modelId))?.contextWindow;
}
