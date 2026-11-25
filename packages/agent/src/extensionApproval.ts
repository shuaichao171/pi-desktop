import { randomUUID } from 'node:crypto';
import { requireApprovalDetails, requireDialogResponse, type UiApprovalDecision, type UiApprovalDetails, type UiExtensionDialogRequest, type UiExtensionDialogResponse } from '@pidesktop/shared';

/** Additional options accepted by desktop ctx.ui.confirm; ordinary SDK callers remain boolean-only. */
export interface DesktopApprovalOptions {
  signal?: AbortSignal;
  timeout?: number;
  approval?: UiApprovalDetails;
  /** The extension owns any session/workspace rule and receives rejection feedback here. */
  onApprovalDecision?: (decision: UiApprovalDecision) => void | Promise<void>;
}
export async function requestDesktopConfirmation(
  request: (value: UiExtensionDialogRequest, signal?: AbortSignal) => Promise<UiExtensionDialogResponse>,
  title: string, message: string, options?: DesktopApprovalOptions,
): Promise<boolean> {
  const approval = options?.approval === undefined ? undefined : requireApprovalDetails(options.approval);
  // 没有决策接收方的旧扩展无法兑现持久授权；只能显示并授予本次权限。
  if (approval && !options?.onApprovalDecision) approval.scopes = ['once'];
  const dialog: UiExtensionDialogRequest = { id: randomUUID(), kind: 'confirm', title, message, timeout: options?.timeout, ...(approval ? { approval } : {}) };
  const response = requireDialogResponse(dialog, await request(dialog, options?.signal));
  const decision: UiApprovalDecision = response && typeof response === 'object' && 'approved' in response ? response : { approved: response === true, scope: 'once' };
  if (approval) await options?.onApprovalDecision?.(decision);
  return decision.approved;
}
