export const MAX_ATTACHMENTS = 12;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_BYTES = 200_000;

const TEXT_FILE_PATTERN = /\.(txt|md|mdx|json|jsonl|ya?ml|toml|xml|csv|tsv|js|jsx|ts|tsx|css|scss|html?|py|rs|go|java|kt|c|cc|cpp|h|hpp|sh|ps1|sql|log|ini|cfg|env|gitignore)$/i;
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

type AttachmentPolicy =
	| { kind: 'image' | 'text'; mimeType: string }
	| { errorKey: 'composer.imageTypes' | 'composer.imageEmpty' | 'composer.imageSize' | 'composer.fileTypes' | 'composer.textSize' };

export function inspectAttachmentFile(file: Pick<File, 'name' | 'type' | 'size'>): AttachmentPolicy {
	const extension = file.name.split('.').at(-1)?.toLocaleLowerCase() ?? '';
	const imageMimeType = file.type.startsWith('image/') ? file.type : IMAGE_MIME_BY_EXTENSION[extension];
	if (imageMimeType) {
		if (!SUPPORTED_IMAGE_TYPES.has(imageMimeType)) return { errorKey: 'composer.imageTypes' };
		if (file.size === 0) return { errorKey: 'composer.imageEmpty' };
		if (file.size > MAX_IMAGE_BYTES) return { errorKey: 'composer.imageSize' };
		return { kind: 'image', mimeType: imageMimeType };
	}
	if (!file.type.startsWith('text/') && !TEXT_FILE_PATTERN.test(file.name)) return { errorKey: 'composer.fileTypes' };
	if (file.size > MAX_TEXT_BYTES) return { errorKey: 'composer.textSize' };
	return { kind: 'text', mimeType: file.type || 'text/plain' };
}
