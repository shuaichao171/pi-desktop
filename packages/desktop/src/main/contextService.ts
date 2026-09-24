import { opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { UiAttachment, UiContextRequest } from '@pidesktop/shared';

const DIRECTORY_LIMIT = 200;

function within(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return !path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Validate the renderer request before looking up any user-controlled paths. */
export function validateContextRequest(request: unknown): asserts request is UiContextRequest {
	if (!request || typeof request !== 'object') throw new Error('上下文参数无效');
	const value = request as Partial<UiContextRequest>;
	if (!['file', 'directory', 'session'].includes(value.kind ?? '')
		|| typeof value.workspace !== 'string' || !isAbsolute(value.workspace) || /[\u0000-\u001f\u007f]/.test(value.workspace) || value.workspace.length > 32_768
		|| typeof value.path !== 'string' || /[\u0000-\u001f\u007f]/.test(value.path) || value.path.length > 32_768) throw new Error('上下文参数无效');
	if (value.kind === 'session') {
		if (!isAbsolute(value.path)) throw new Error('会话路径无效');
	} else if (isAbsolute(value.path) || /^[a-z]:/i.test(value.path) || /^[\\/]/.test(value.path)) throw new Error('必须使用工作区内的相对路径');
}

/** Files stay references: neither binary data nor large file bodies enter a prompt. */
export async function readWorkspaceContext(request: UiContextRequest): Promise<UiAttachment> {
	validateContextRequest(request);
	if (request.kind !== 'file' && request.kind !== 'directory') throw new Error('文件上下文类型无效');
	const root = await realpath(request.workspace);
	if (!(await stat(root)).isDirectory()) throw new Error('工作区不是文件夹');
	const candidate = resolve(root, request.path);
	if (!within(root, candidate)) throw new Error('引用路径不属于此工作区');
	const path = await realpath(candidate);
	if (!within(root, path)) throw new Error('引用路径不属于此工作区');
	const details = await stat(path);
	if (request.kind === 'file' ? !details.isFile() : !details.isDirectory()) throw new Error('引用的文件或文件夹类型不匹配');
	const relativePath = relative(root, candidate).split(sep).join('/') || '.';
	const description = [
		`User-selected ${request.kind} reference. Read this path with your tools when relevant to the user's request.`,
		`Workspace: ${JSON.stringify(request.workspace)}`,
		`Relative path: ${JSON.stringify(relativePath)}`,
		`Resolved path: ${JSON.stringify(path)}`,
	];
	let truncated = false;
	if (request.kind === 'directory') {
		const entries: { name: string; kind: 'directory' | 'file' }[] = [];
		const directory = await opendir(path);
		for await (const entry of directory) {
			if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
			if (entries.length === DIRECTORY_LIMIT) { truncated = true; break; }
			entries.push({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' });
		}
		entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1);
		description.push('Immediate children (names only; file contents have not been read):',
			...entries.map((entry) => `${entry.kind}: ${JSON.stringify(entry.name)}`));
		if (truncated) description.push(`[Directory overview truncated after ${DIRECTORY_LIMIT} entries.]`);
	} else description.push('File contents have not been read.');
	return {
		kind: 'text', name: relativePath,
		mimeType: request.kind === 'file' ? 'text/x-pi-file-reference' : 'text/x-pi-directory-reference',
		text: description.join('\n'),
		source: { kind: request.kind, workspace: request.workspace, path: relativePath, ...(truncated ? { truncated: true } : {}) },
	};
}
