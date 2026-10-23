// Chromium treats focus moved by script as :focus-visible whenever the previous
// element matched it, and text fields always match. Closing a dialog after typing
// in it, or a picker that focuses its trigger, therefore draws a keyboard ring
// after a mouse-only interaction. Recording the last input modality on <html>
// lets CSS hide those rings until the user navigates with the keyboard again.

const NAVIGATION_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'F6']);
const ACTIVATION_KEYS = new Set(['Enter', ' ']);

function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
	if (!(target instanceof HTMLInputElement)) return false;
	return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].includes(target.type);
}

let installed = false;

export function installInputModality(root: HTMLElement = document.documentElement): void {
	if (installed) return;
	installed = true;
	const set = (modality: 'pointer' | 'keyboard') => {
		if (root.dataset.inputModality !== modality) root.dataset.inputModality = modality;
	};
	window.addEventListener('pointerdown', () => set('pointer'), { capture: true, passive: true });
	window.addEventListener('keydown', (event) => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		// Typing into a field is not navigation; Enter/Space only count when they activate a control.
		if (NAVIGATION_KEYS.has(event.key) || (ACTIVATION_KEYS.has(event.key) && !isTextEntry(event.target))) set('keyboard');
	}, { capture: true });
}
