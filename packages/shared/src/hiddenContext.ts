/**
 * 会话隐藏上下文（hidden context）：每个会话一份的自然语言指令，
 * 注入到该会话的系统提示词，但不出现在消息流里。
 *
 * 借鉴 Claude Desktop 的 hiddenContext：指令属于会话作用域，由用户显式
 * 编辑；注入走 Pi SDK 的 `before_agent_start` 扩展事件（可变的
 * systemPromptOptions，SDK 会以结构化 system 段落记录增量），绝不能把
 * 指令追加到用户消息文本——那会污染转录。存储在 pi-desktop 自有的
 * hidden-context.json（键 = 规范化 sessionPath），Pi 会话文件本身不含
 * 这份设置；注入产生的 system 段落增量会随转录持久化（详见
 * docs/specs/HIDDEN_CONTEXT.md）。
 */

export const HIDDEN_CONTEXT_CHANNELS = {
  get: 'hidden-context:get',
  set: 'hidden-context:set',
  changed: 'hidden-context:changed',
} as const;

/** Multi-line text cap; longer input is rejected at the IPC boundary. */
export const HIDDEN_CONTEXT_MAX_CHARS = 8000;

/** Validates renderer-provided instruction text; empty string clears the record. */
export function requireHiddenContextText(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('隐藏指令内容无效');
  if (value.length > HIDDEN_CONTEXT_MAX_CHARS) throw new Error(`隐藏指令不能超过 ${HIDDEN_CONTEXT_MAX_CHARS} 字符`);
  return value;
}

/** Added to AgentBridge by the main integration; records live in pi-desktop's own storage. */
export interface HiddenContextFeatureBridge {
  /** The conversation's instruction text ('' when none); only fetched for the open conversation. */
  getHiddenContext(sessionPath: string): Promise<string>;
  /** Saves (or clears with '') the conversation's instruction. */
  setHiddenContext(sessionPath: string, text: string): Promise<void>;
  /** Push: a conversation's instruction changed (edited in another pane/window). */
  onHiddenContextChanged?(listener: (sessionPath: string, text: string) => void): () => void;
}
