import type { CSSProperties } from 'react';

// Providers get a one-character tile tinted with a stable hue: well-known
// services use their familiar brand hue, everything else hashes its id onto a
// small palette so the same provider always looks the same in every list.
// Names match whole id segments (split on - _ . / space), so "spark-gateway"
// is not mistaken for Volcengine Ark and "gpt-review" still reads as OpenAI.
const KNOWN_HUES: Array<[string[], string]> = [
	[['anthropic', 'claude'], '#d97757'],
	[['openai', 'gpt', 'chatgpt'], '#10a37f'],
	[['google', 'gemini', 'vertex'], '#4285f4'],
	[['deepseek'], '#4d6bfe'],
	[['moonshot', 'kimi'], '#7c8cff'],
	[['zhipu', 'glm', 'bigmodel', 'zai'], '#3b82f6'],
	[['qwen', 'dashscope', 'alibaba', 'bailian'], '#7c5cff'],
	[['mistral'], '#fa520f'],
	[['xai', 'grok'], '#9ca3af'],
	[['openrouter'], '#6467f2'],
	[['groq'], '#f55036'],
	[['azure'], '#0078d4'],
	[['bedrock', 'amazon', 'aws'], '#ff9900'],
	[['ollama', 'lmstudio', 'local', 'localhost'], '#a3a3a3'],
	[['minimax'], '#e7457a'],
	[['doubao', 'volcengine', 'volc', 'ark'], '#2f6bff'],
];
const PALETTE = ['#5b8def', '#2bb673', '#e0883b', '#b26ae0', '#e05a7a', '#1fa8b8', '#c9a227', '#7f8ea3'];

function hash(value: string): number {
	let result = 0;
	for (const char of value) result = (result * 31 + char.codePointAt(0)!) >>> 0;
	return result;
}

export function providerHue(provider: string): string {
	const id = provider.toLowerCase();
	const segments = new Set(id.split(/[\s._\/-]+/).filter(Boolean));
	return KNOWN_HUES.find(([names]) => names.some((name) => segments.has(name)))?.[1] ?? PALETTE[hash(id) % PALETTE.length]!;
}

/** First meaningful character: a letter or digit, or the first CJK character. */
export function providerInitial(label: string): string {
	const match = label.trim().match(/[\p{L}\p{N}]/u);
	return match ? match[0].toUpperCase() : '?';
}

export function providerMarkStyle(provider: string): CSSProperties {
	return { '--pd-provider-hue': providerHue(provider) } as CSSProperties;
}
