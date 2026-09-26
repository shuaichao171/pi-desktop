export interface DiffLine {
	kind: 'context' | 'addition' | 'deletion' | 'hunk' | 'meta';
	text: string;
	oldLine?: number;
	newLine?: number;
}

/** Parse hunk boundaries before interpreting prefixes: +++ can also be added code. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
	const lines = diff.split('\n');
	if (lines.at(-1) === '') lines.pop();
	let oldLine = 0;
	let newLine = 0;
	let oldRemaining = 0;
	let newRemaining = 0;
	return lines.map((text): DiffLine => {
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[3]);
			oldRemaining = Number(hunk[2] ?? 1);
			newRemaining = Number(hunk[4] ?? 1);
			return { kind: 'hunk', text };
		}
		if (text.startsWith('+') && newRemaining > 0) {
			newRemaining -= 1;
			return { kind: 'addition', text, newLine: newLine++ };
		}
		if (text.startsWith('-') && oldRemaining > 0) {
			oldRemaining -= 1;
			return { kind: 'deletion', text, oldLine: oldLine++ };
		}
		if (text.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
			oldRemaining -= 1;
			newRemaining -= 1;
			return { kind: 'context', text, oldLine: oldLine++, newLine: newLine++ };
		}
		return { kind: 'meta', text };
	});
}

export interface EditDiffLine {
	kind: 'context' | 'addition' | 'deletion' | 'elision' | 'meta';
	/** Line content without the Pi prefix and number. */
	text: string;
	oldLine?: number;
	newLine?: number;
}

/**
 * Parse Pi's edit-tool diff rows (`+3 added`, `-2 removed`, ` 1 context`,
 * ` ...` elision). Added rows carry the new line number, removed rows the old one.
 */
export function parsePiEditDiff(diff: string): EditDiffLine[] {
	const lines = diff.split('\n');
	if (lines.at(-1) === '') lines.pop();
	return lines.map((line): EditDiffLine => {
		const change = /^([+-]) *(\d+)(?: (.*))?$/.exec(line);
		if (change) {
			const number = Number(change[2]);
			return change[1] === '+'
				? { kind: 'addition', text: change[3] ?? '', newLine: number }
				: { kind: 'deletion', text: change[3] ?? '', oldLine: number };
		}
		const context = /^ +(\d+)(?: (.*))?$/.exec(line);
		if (context) {
			const number = Number(context[1]);
			return { kind: 'context', text: context[2] ?? '', oldLine: number, newLine: number };
		}
		if (/^ +\.\.\.$/.test(line)) return { kind: 'elision', text: '…' };
		return { kind: 'meta', text: line };
	});
}
