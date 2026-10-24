import { createContext, runInContext } from 'node:vm';
import type { UiUsageData, UiUsageQueryConfig, UiUsageQueryResult, UiUsageQueryTemplate } from '../../shared/src/managementFeatures.ts';
import { readStoredCredential } from '@earendil-works/pi-coding-agent';
import { runWithProviderNetwork } from './providerNetwork.ts';
import { detectBalanceProvider, queryNativeBalance } from './providerBalance.ts';
import { usageScriptPreset } from '@pidesktop/shared';

/**
 * Provider usage-query script engine (cc-switch-compatible contract).
 *
 * A usage script is a JS expression evaluating to
 *   ({ request: { url, method, headers?, body? }, extractor: function(response) })
 * with {{baseUrl}} {{apiKey}} {{accessToken}} {{userId}} placeholders. The
 * request runs through the global fetch (already routed by the provider
 * network policy) and the extractor maps the JSON response to usage data.
 *
 * Security mirrors cc-switch's usage_script.rs:
 * - Non-custom templates enforce HTTPS (loopback exempt) and same host+port as
 *   the provider baseUrl, so an edited preset can never exfiltrate the API key
 *   to another origin. Custom scripts are explicit user intent and may call
 *   any HTTP(S) endpoint.
 * - Both script phases run in a fresh vm context (JS intrinsics only, no
 *   require/process/fetch/console) under a CPU timeout.
 * - Redirects are rejected rather than followed: following one would replay
 *   the Authorization header against whatever origin the server names.
 * - Errors never echo credentials; response previews are capped at 200 chars.
 */

export const USAGE_SCRIPT_TIMEOUT_MS = 5_000;
const USAGE_SCRIPT_SOURCE_LIMIT = 65_536;
const RESPONSE_BYTE_LIMIT = 2_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const HEADER_NAME_BLOCKLIST = /^(?:host|connection|content-length|transfer-encoding|proxy-authorization|proxy-connection|upgrade|trailer|te)$/iu;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const TEMPLATES: readonly UiUsageQueryTemplate[] = ['general', 'newapi', 'sub2api', 'balance', 'custom'];

export class UsageQueryError extends Error {
  readonly transient: boolean;
  readonly status?: number;
  constructor(message: string, transient = false, status?: number) { super(message); this.name = 'UsageQueryError'; this.transient = transient; this.status = status; }
}

export function normalizeUsageQueryConfig(value: unknown): UiUsageQueryConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const template = TEMPLATES.includes(source.template as UiUsageQueryTemplate) ? source.template as UiUsageQueryTemplate : undefined;
  if (!template) return null;
  const config: UiUsageQueryConfig = { enabled: source.enabled === true, template };
  const minutes = source.intervalMinutes;
  if (Number.isSafeInteger(minutes) && (minutes as number) >= 0 && (minutes as number) <= 100_800) config.intervalMinutes = minutes as number;
  if (typeof source.script === 'string' && source.script.length <= USAGE_SCRIPT_SOURCE_LIMIT) config.script = source.script;
  if (typeof source.accessToken === 'string' && source.accessToken.length <= 16_384 && !/[\u0000-\u001f\u007f]/u.test(source.accessToken)) config.accessToken = source.accessToken;
  if (typeof source.userId === 'string' && source.userId.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(source.userId)) config.userId = source.userId;
  return config;
}

/** Read-side projection for listModelProviders; the access token value never leaves the host. */
export function usageQueryInfo(config: UiUsageQueryConfig | null): { enabled: boolean; template: UiUsageQueryTemplate; intervalMinutes?: number; script?: string; userId?: string; hasAccessToken?: boolean } | undefined {
  if (!config) return undefined;
  const info: { enabled: boolean; template: UiUsageQueryTemplate; intervalMinutes?: number; script?: string; userId?: string; hasAccessToken?: boolean } = { enabled: config.enabled, template: config.template };
  if (config.intervalMinutes !== undefined) info.intervalMinutes = config.intervalMinutes;
  if (config.script !== undefined) info.script = config.script;
  if (config.userId !== undefined) info.userId = config.userId;
  if (config.accessToken !== undefined && config.accessToken.length > 0) info.hasAccessToken = true;
  return info;
}

// ── URL safety (port of cc-switch usage_script.rs validation) ────────────────

function isLoopbackHost(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost') return true;
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(hostname)) return Number(hostname.split('.')[0]) === 127;
  return hostname === '[::1]' || hostname === '::1';
}

function portOrDefault(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function parseUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

/** base_url sanity: HTTPS unless loopback, must have a hostname. */
export function validateBaseUrl(baseUrl: string): Error | null {
  if (!baseUrl) return new Error('base_url 不能为空');
  const parsed = parseUrl(baseUrl);
  if (!parsed) return new Error('无效的 base_url');
  if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed)) return new Error('base_url 必须使用 HTTPS 协议（localhost 除外）');
  if (!parsed.hostname) return new Error('base_url 必须包含有效的主机名');
  return null;
}

/**
 * Request URL safety: non-custom templates must stay on the provider origin
 * (same host and effective port) and use HTTPS (loopback exempt). Custom
 * scripts are explicit user intent and may call any HTTP(S) endpoint.
 */
export function validateRequestUrl(requestUrl: string, baseUrl: string, isCustomTemplate: boolean): Error | null {
  const parsed = parseUrl(requestUrl);
  if (!parsed) return new Error('无效的请求 URL');
  const loopback = isLoopbackHost(parsed);
  if (!isCustomTemplate && parsed.protocol !== 'https:' && !loopback) return new Error('请求 URL 必须使用 HTTPS 协议（localhost 除外）');
  if (!isCustomTemplate && baseUrl) {
    const base = parseUrl(baseUrl);
    if (!base) return new Error('无效的 base_url');
    if (parsed.hostname !== base.hostname) return new Error(`请求域名 ${parsed.hostname} 与 base_url 域名 ${base.hostname} 不匹配（必须是同源请求）`);
    if (portOrDefault(parsed) !== portOrDefault(base)) return new Error(`请求端口 ${portOrDefault(parsed)} 必须与 base_url 端口 ${portOrDefault(base)} 匹配`);
  }
  return null;
}

// ── Script sandbox ───────────────────────────────────────────────────────────

interface ScriptRequest { url: string; method: string; headers: Record<string, string>; body?: string }

function runScript(source: string, sandbox: Record<string, unknown>): unknown {
  if (!source.trim()) throw new UsageQueryError('用量查询脚本为空');
  if (source.length > USAGE_SCRIPT_SOURCE_LIMIT) throw new UsageQueryError('用量查询脚本过长');
  const context = createContext(sandbox);
  try {
    return runInContext(source, context, { timeout: USAGE_SCRIPT_TIMEOUT_MS });
  } catch (error) {
    throw new UsageQueryError(`解析用量查询脚本失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractScriptRequest(config: unknown): ScriptRequest {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new UsageQueryError('用量查询脚本必须返回包含 request 与 extractor 的对象');
  const source = config as Record<string, unknown>;
  const request = source.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new UsageQueryError('缺少 request 配置');
  const fields = request as Record<string, unknown>;
  if (typeof fields.url !== 'string' || !fields.url) throw new UsageQueryError('request.url 必须是非空字符串');
  if (typeof fields.method !== 'string' || !METHODS.has(fields.method.toUpperCase())) throw new UsageQueryError(`不支持的 HTTP 方法: ${String(fields.method)}`);
  const headers: Record<string, string> = {};
  let headerSize = 0;
  if (fields.headers !== undefined) {
    if (typeof fields.headers !== 'object' || fields.headers === null || Array.isArray(fields.headers)) throw new UsageQueryError('request.headers 必须是字符串表');
    const entries = Object.entries(fields.headers as Record<string, unknown>);
    if (entries.length > 64) throw new UsageQueryError('request.headers 最多 64 项');
    for (const [name, value] of entries) {
      if (typeof value !== 'string' || /[\r\n\u0000]/u.test(name) || HEADER_NAME_BLOCKLIST.test(name)) throw new UsageQueryError('request.headers 含有无效或被禁止的请求头');
      headerSize += name.length + value.length;
      if (headerSize > 32_768) throw new UsageQueryError('request.headers 总大小超限');
      headers[name] = value;
    }
  }
  const requestSpec: ScriptRequest = { url: fields.url, method: fields.method.toUpperCase(), headers };
  if (fields.body !== undefined) {
    if (typeof fields.body !== 'string' || fields.body.length > 65_536) throw new UsageQueryError('request.body 必须是不超过 64 KiB 的字符串');
    requestSpec.body = fields.body;
  }
  return requestSpec;
}

/** Result shape validation (port of cc-switch validate_result; all fields optional, types enforced). */
export function validateUsageDataList(value: unknown): UiUsageData[] {
  const items = Array.isArray(value) ? value : [value];
  if (!items.length) throw new UsageQueryError('脚本返回的数组不能为空');
  const checked: UiUsageData[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new UsageQueryError('脚本必须返回对象或对象数组');
    const record = item as Record<string, unknown>;
    const entry: UiUsageData = {};
    const expect = (key: string, kind: 'boolean' | 'string' | 'number'): void => {
      const value = record[key];
      if (value === null || value === undefined) return;
      if (typeof value !== kind) throw new UsageQueryError(`${key} 必须是${kind === 'number' ? '数字' : kind === 'string' ? '字符串' : '布尔值'}或 null`);
      if (kind === 'number' && !Number.isFinite(value as number)) throw new UsageQueryError(`${key} 必须是有限数字`);
      if (kind === 'string' && (value as string).length > 500) throw new UsageQueryError(`${key} 过长`);
      (entry as Record<string, unknown>)[key] = value;
    };
    expect('isValid', 'boolean');
    expect('invalidMessage', 'string');
    expect('remaining', 'number');
    expect('used', 'number');
    expect('total', 'number');
    expect('planName', 'string');
    expect('unit', 'string');
    expect('extra', 'string');
    checked.push(entry);
  }
  return checked;
}

function buildScriptWithVars(script: string, vars: { apiKey: string; baseUrl: string; accessToken?: string; userId?: string }): string {
  return script
    .replaceAll('{{apiKey}}', vars.apiKey)
    .replaceAll('{{baseUrl}}', vars.baseUrl)
    .replaceAll('{{accessToken}}', vars.accessToken ?? '')
    .replaceAll('{{userId}}', vars.userId ?? '');
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

export async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > RESPONSE_BYTE_LIMIT) { await reader.cancel().catch(() => {}); throw new UsageQueryError('响应体超过 2 MiB 限制', true); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function fetchUsageJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { throw new UsageQueryError('请求失败：网络不可达或超时', true); }
  if (response.status >= 300 && response.status < 400) throw new UsageQueryError(`HTTP ${response.status}：重定向被拒绝`);
  const text = await readBoundedText(response).catch((error: unknown) => {
    if (error instanceof UsageQueryError) throw error;
    throw new UsageQueryError('读取响应失败', true);
  });
  if (!response.ok) {
    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    throw new UsageQueryError(`HTTP ${response.status}：${preview}`, false, response.status);
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new UsageQueryError('解析响应 JSON 失败'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UsageQueryError('响应不是 JSON 对象');
  return body as Record<string, unknown>;
}

// ── Script template execution ────────────────────────────────────────────────

export async function runUsageScriptQuery(options: {
  config: UiUsageQueryConfig;
  baseUrl: string;
  apiKey: string;
}): Promise<UiUsageData[]> {
  const { config, baseUrl, apiKey } = options;
  const isCustomTemplate = config.template === 'custom';
  const script = config.script && config.script.trim() ? config.script : usageScriptPreset(config.template);
  const withVars = buildScriptWithVars(script, { apiKey, baseUrl, ...(config.accessToken !== undefined ? { accessToken: config.accessToken } : {}), ...(config.userId !== undefined ? { userId: config.userId } : {}) });

  if (baseUrl && !isCustomTemplate) {
    const baseError = validateBaseUrl(baseUrl);
    if (baseError) throw baseError;
  }

  const sandbox: Record<string, unknown> = {};
  const configObject = runScript(withVars, sandbox);
  const request = extractScriptRequest(configObject);

  const urlError = validateRequestUrl(request.url, baseUrl, isCustomTemplate);
  if (urlError) throw urlError;

  // Fail fast before any network traffic: a script without an extractor is malformed.
  if (typeof (configObject as Record<string, unknown>).extractor !== 'function') throw new UsageQueryError('缺少 extractor 函数');

  const response = await sendScriptRequest(request);
  sandbox.__pdConfig = configObject;
  sandbox.__pdResponse = response;
  let extracted: unknown;
  try {
    extracted = runInContext('__pdConfig.extractor(__pdResponse)', createContext(sandbox), { timeout: USAGE_SCRIPT_TIMEOUT_MS });
  } catch (error) {
    throw new UsageQueryError(`执行 extractor 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  finally {
    delete sandbox.__pdConfig;
    delete sandbox.__pdResponse;
  }
  return validateUsageDataList(extracted);
}

/** Full request sender for scripts whose method or body needs more than fetchUsageJson's GET. */
async function sendScriptRequest(request: ScriptRequest): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch { throw new UsageQueryError('请求失败：网络不可达或超时', true); }
  if (response.status >= 300 && response.status < 400) throw new UsageQueryError(`HTTP ${response.status}：重定向被拒绝`);
  const text = await readBoundedText(response).catch((error: unknown) => {
    if (error instanceof UsageQueryError) throw error;
    throw new UsageQueryError('读取响应失败', true);
  });
  if (!response.ok) {
    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    throw new UsageQueryError(`HTTP ${response.status}：${preview}`, false, response.status);
  }
  try { return JSON.parse(text); } catch { throw new UsageQueryError('解析响应 JSON 失败'); }
}

// ── Request validation & orchestration ───────────────────────────────────────

/** Validates a save request into a storable config (stricter than the read-side normalizer). */
export function validateUsageQueryRequest(value: unknown): UiUsageQueryConfig {
  const config = normalizeUsageQueryConfig(value);
  if (!config) throw new Error('用量查询配置无效');
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    if (source.enabled !== undefined && typeof source.enabled !== 'boolean') throw new Error('用量查询 enabled 必须是布尔值');
    if (source.script !== undefined && config.script === undefined) throw new Error('用量查询脚本无效');
    if (source.accessToken !== undefined && config.accessToken === undefined) throw new Error('用量查询 accessToken 无效');
    if (source.userId !== undefined && config.userId === undefined) throw new Error('用量查询 userId 无效');
  }
  return config;
}

export interface ProviderUsageQueryContext {
  provider: string;
  /** The provider's models.json entry, if one exists. */
  entry: Record<string, unknown> | undefined;
  authPath: string;
}

/** Reads the stored api key; env-var/command key templates are out of scope for usage queries. */
function resolveApiKey(provider: string, entry: Record<string, unknown> | undefined, authPath: string): { key: string | null; reason?: string } {
  const credential = readStoredCredential(provider, authPath);
  if (credential?.type === 'oauth') return { key: null, reason: 'OAuth 供应商暂不支持用量查询' };
  if (credential?.type === 'api_key' && credential.key) return { key: credential.key };
  if (entry && (typeof entry.key === 'string' || typeof entry.apiKey === 'string')) return { key: null, reason: '此供应商的密钥来自外部高级配置，用量查询暂不支持，请在供应商详情直接保存 API Key' };
  return { key: null, reason: '未配置 API Key，请先在供应商详情保存凭据' };
}

/** One usage query against the provider's saved configuration. */
export async function runProviderUsageQuery(context: ProviderUsageQueryContext): Promise<UiUsageQueryResult> {
  const { provider, entry, authPath } = context;
  const base: UiUsageQueryResult = { provider, ok: false, queriedAt: Date.now() };
  const config = normalizeUsageQueryConfig(entry?.desktopUsageQuery);
  if (!config || !config.enabled) return { ...base, error: '用量查询未启用' };
  const baseUrl = typeof entry?.baseUrl === 'string' ? entry.baseUrl : null;
  if (!baseUrl) return { ...base, error: '供应商缺少 baseUrl，请先保存连接' };
  const { key, reason } = resolveApiKey(provider, entry, authPath);
  if (!key || reason) return { ...base, error: reason ?? '未配置 API Key' };

  const useSystemProxy = typeof entry?.desktopUseSystemProxy === 'boolean' ? entry.desktopUseSystemProxy : undefined;
  const work = async (): Promise<UiUsageData[]> => {
    if (config.template === 'balance') {
      const detected = detectBalanceProvider(baseUrl);
      if (!detected) throw new UsageQueryError('未识别的官方余额供应商（支持 DeepSeek、StepFun、SiliconFlow、OpenRouter、Novita AI），请改用脚本模板');
      return queryNativeBalance(detected, key);
    }
    return runUsageScriptQuery({ config, baseUrl, apiKey: key });
  };
  try {
    const data = useSystemProxy === undefined ? await work() : await runWithProviderNetwork(useSystemProxy, work);
    return { provider, ok: true, queriedAt: Date.now(), data };
  } catch (error) {
    if (error instanceof UsageQueryError) return { ...base, error: error.message, ...(error.transient ? { transient: true } : {}) };
    return { ...base, error: `用量查询失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
