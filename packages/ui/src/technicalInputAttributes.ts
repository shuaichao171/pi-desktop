/**
 * Shared attributes for technical inputs (IDs, URLs, keys, commands, JSON).
 * Spellcheck and OS auto-correction produce misleading red squiggles and
 * silent rewrites in these fields (zcode lib/technicalInputAttributes).
 */
export const technicalInputAttributes = {
	autoCapitalize: 'none',
	autoComplete: 'off',
	autoCorrect: 'off',
	spellCheck: false,
} as const;
