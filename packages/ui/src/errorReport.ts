import type { UiAgentError, UiDiagnosticEvent } from '@pidesktop/shared';

const PRIVATE_FIELD = /^(?:authorization|proxy-authorization|cookie|set-cookie|.*(?:api[_-]?key|password|secret|token)|messages?|prompts?|input|content|attachments?|request(?:body)?|body|data)$/i;
function scrubJson(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[redacted]';
  if (Array.isArray(value)) return value.map(entry => scrubJson(entry, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, PRIVATE_FIELD.test(key) ? '[redacted]' : scrubJson(entry, depth + 1)]));
  return value;
}

/** Report only the supplied error, never store snapshots, messages, attachments or account config. */
export function redactErrorText(input: string): string {
  let value = input.slice(0, 64000)
    .replace(/((?:^|\n)\s*(?:request\s*body|prompt|messages|attachments)\s*:\s*)[\s\S]*/i, '$1[redacted payload]');
  // API failures frequently append a JSON request/response. Parse balanced objects so nested
  // messages and escaped quotes cannot defeat the redaction with a partial regex match.
  let output = '', start = 0, attempts = 0;
  for (let cursor = 0; cursor < value.length; cursor++) {
    if (value[cursor] !== '{' && value[cursor] !== '[') continue;
    if (++attempts > 100) { value = value.slice(0, cursor) + '[unstructured payload omitted]'; break; }
    const begin = cursor; let depth = 0, quoted = false, escaped = false;
    for (; cursor < value.length; cursor++) {
      const char = value[cursor];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') { if (--depth === 0) break; }
    }
    const raw = value.slice(begin, cursor + 1);
    try { output += value.slice(start, begin) + JSON.stringify(scrubJson(JSON.parse(raw)), null, 2); start = cursor + 1; }
    catch { cursor = begin; }
  }
  value = output + value.slice(start);
  return value
    .replace(/\bBearer\s+[^\s,"';]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/((?:--?)(?:api[_-]?key|password|token|secret)(?:\s+|=))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|cookie)["']?\s*[=:]\s*)[^\r\n,;]+/gi, '$1[redacted]')
    .replace(/((?:request\s*body|messages?|prompt|attachments?|input|content)["']?\s*[=:]\s*)[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/g, raw => { try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); } catch { return '[redacted URL]'; } })
    .replace(/data:[^,\s]+,[A-Za-z0-9+/=]+/g, '[redacted attachment]')
    + (input.length > 64000 ? '\n[error details truncated at 64 KB]' : '');
}

export function createErrorReport(error: string, scope: UiDiagnosticEvent['scope'], kind: 'render-error' | 'operation-error', status?: string, info?: UiAgentError | null) {
  const id = globalThis.crypto?.randomUUID?.() ?? `error-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const time = new Date().toISOString();
  const details = redactErrorText(error);
  const safeStatus = status && /^[a-z-]{1,30}$/.test(status) ? status : undefined;
  // Structured evidence only joins the report when it describes this exact failure.
  const evidence = info && (info.message === error || error.includes(info.message)) ? [
    `kind=${info.kind}`, `source=${info.source}`,
    ...(info.code ? [`code=${info.code}`] : []),
    ...(info.status !== undefined ? [`status=${info.status}`] : []),
    ...(info.provider ? [`provider=${info.provider}`] : []),
    ...(info.retryable !== undefined ? [`retryable=${info.retryable}`] : []),
    ...(info.traceId ? [`traceId=${info.traceId}`] : []),
  ].join(' ') : undefined;
  const nested = evidence && info?.detail ? `\n${redactErrorText(info.detail)}` : '';
  return { id, details, diagnostic: { id, scope, kind, outcome: 'failure' as const }, text: `Pi Desktop error\nDiagnostic ID: ${id}\nTime: ${time}\nArea: ${scope}\nType: ${kind}${safeStatus ? `\nStatus: ${safeStatus}` : ''}${evidence ? `\nStructured: ${evidence}` : ''}${nested}\n\n${details}` };
}
