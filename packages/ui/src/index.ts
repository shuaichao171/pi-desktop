export { AppShell } from './components/AppShell';
export { ChatView } from './components/ChatView';
export { Sidebar } from './components/Sidebar';
export { MessageItem } from './components/MessageItem';
export { Composer } from './components/Composer';
export { useChatStore, selectBusy, selectStartupReady } from './store';

import {
	applyUiFontSize, initUiFontSize, normalizeUiFontSize, readUiFontSize, saveUiFontSize,
	DEFAULT_UI_FONT_SIZE, UI_FONT_SIZE_MAX, UI_FONT_SIZE_MIN,
} from './uiFontSize';

export {
	applyUiFontSize, initUiFontSize, normalizeUiFontSize, readUiFontSize, saveUiFontSize,
	DEFAULT_UI_FONT_SIZE, UI_FONT_SIZE_MAX, UI_FONT_SIZE_MIN,
};

// Apply the saved interface font size before the first render; blocked storage falls back.
initUiFontSize();
import { initContentFontSizes } from './contentFontSize';
initContentFontSizes();
