import { requireElicitationResponse, type UiElicitationForm, type UiElicitationResponse } from './elicitation.ts';

/** Display metadata supplied by an extension; it never grants permission by itself. */
export type UiApprovalScope = 'once' | 'session' | 'workspace';
export interface UiApprovalDetails {
  command?: string;
  cwd?: string;
  files?: Array<{ path: string; diff?: string }>;
  source?: string;
  scopes?: UiApprovalScope[];
}
export interface UiApprovalDecision { approved: boolean; scope: UiApprovalScope; feedback?: string }
export type UiExtensionDialogResponse = string | boolean | null | UiApprovalDecision | UiElicitationResponse;

const SCOPES: UiApprovalScope[] = ['once', 'session', 'workspace'];
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

/** Bounded, explicit wire contract: reject malformed metadata rather than silently hiding it. */
export function requireApprovalDetails(value: unknown): UiApprovalDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('审批详情无效');
  const item = value as Record<string, unknown>;
  const result: UiApprovalDetails = {};
  for (const [key, max] of [['command', 32000], ['cwd', 4096], ['source', 500]] as const) {
    if (item[key] !== undefined) {
      if (!text(item[key], max)) throw new Error('审批详情过大或格式无效');
      result[key] = item[key];
    }
  }
  if (item.files !== undefined) {
    if (!Array.isArray(item.files) || item.files.length > 20) throw new Error('审批文件列表无效');
    let bytes = 0;
    result.files = item.files.map((file: unknown) => {
      if (!file || typeof file !== 'object') throw new Error('审批文件无效');
      const entry = file as Record<string, unknown>;
      if (!text(entry.path, 4096) || !entry.path.trim() || (entry.diff !== undefined && !text(entry.diff, 64000))) throw new Error('审批文件无效');
      bytes += String(entry.diff ?? '').length;
      if (bytes > 256000) throw new Error('审批差异过大，请拆分操作');
      return { path: entry.path, ...(entry.diff === undefined ? {} : { diff: entry.diff as string }) };
    });
  }
  if (item.scopes !== undefined) {
    if (!Array.isArray(item.scopes) || !item.scopes.length || item.scopes.some(scope => !SCOPES.includes(scope))) throw new Error('授权范围无效');
    result.scopes = [...new Set<UiApprovalScope>(['once', ...item.scopes])];
  }
  return result;
}

export function requireDialogResponse(request: { kind: string; options?: string[]; approval?: UiApprovalDetails; form?: UiElicitationForm }, value: unknown): UiExtensionDialogResponse {
  if (value === null) return null;
  if (request.kind === 'form' && request.form) return requireElicitationResponse(request.form, value);
  if (request.kind === 'confirm' && request.approval) {
    if (typeof value === 'boolean') return { approved: value, scope: 'once' };
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('审批结果无效');
    const item = value as Record<string, unknown>;
    const scopes = request.approval.scopes ?? ['once'];
    if (typeof item.approved !== 'boolean' || !SCOPES.includes(item.scope as UiApprovalScope)
      || (item.approved ? !scopes.includes(item.scope as UiApprovalScope) : item.scope !== 'once')
      || (item.feedback !== undefined && !text(item.feedback, 4000))) throw new Error('审批结果或授权范围无效');
    return { approved: item.approved, scope: item.scope as UiApprovalScope,
      ...(!item.approved && typeof item.feedback === 'string' && item.feedback.trim() ? { feedback: item.feedback.trim() } : {}) };
  }
  if (request.kind === 'confirm' && typeof value === 'boolean') return value;
  if (request.kind === 'select' && typeof value === 'string' && request.options?.includes(value)) return value;
  if ((request.kind === 'input' || request.kind === 'editor') && text(value, 1000000)) return value;
  throw new Error('交互结果无效');
}
