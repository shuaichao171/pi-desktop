/** Electron adds its transport prefix to errors thrown by ipcMain.handle. */
export function unwrapIpcError(error: unknown, channel: string): unknown {
	if (!(error instanceof Error)) return error;
	const prefix = `Error invoking remote method '${channel}': `;
	if (!error.message.startsWith(prefix)) return error;
	const message = error.message.slice(prefix.length).replace(/^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError): /, '');
	return new Error(message || '操作失败，请重试', { cause: error });
}
