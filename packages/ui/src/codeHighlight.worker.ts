import { workerHighlight } from './codeHighlightWorker';

self.onmessage = (event: MessageEvent<{ source: string; language: string }>) => {
	self.postMessage({ html: workerHighlight(event.data.source, event.data.language) });
};
