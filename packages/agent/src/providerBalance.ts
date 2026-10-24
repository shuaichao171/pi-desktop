import type { UiUsageData } from '../../shared/src/managementFeatures.ts';
import { fetchUsageJson, UsageQueryError } from './providerUsageQuery.ts';

/**
 * Native balance queries, ported from cc-switch's services/balance.rs.
 *
 * The `balance` template routes by the provider's base URL host to the vendor's
 * official balance endpoint. Quota endpoints for coding plans (Kimi / Zhipu /
 * MiniMax / Volcengine / OpenCode Go / Command Code) are a cc-switch follow-up
 * and are intentionally not part of this port; the `custom` script template
 * covers them in the meantime.
 */

type BalanceProvider = 'deepseek' | 'stepfun' | 'siliconflow-cn' | 'siliconflow-en' | 'openrouter' | 'novita';

export function detectBalanceProvider(baseUrl: string): BalanceProvider | null {
  const url = baseUrl.toLowerCase();
  if (url.includes('api.deepseek.com')) return 'deepseek';
  if (url.includes('api.stepfun.ai') || url.includes('api.stepfun.com')) return 'stepfun';
  if (url.includes('api.siliconflow.cn')) return 'siliconflow-cn';
  if (url.includes('api.siliconflow.com')) return 'siliconflow-en';
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (url.includes('api.novita.ai')) return 'novita';
  return null;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Numeric fields may arrive as numbers or numeric strings (OpenRouter does both). */
export function numberField(source: Record<string, unknown>, field: string): number | undefined {
  const value = source[field];
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
  return undefined;
}

// ── DeepSeek ─────────────────────────────────────────────────────────────────
// GET https://api.deepseek.com/user/balance
// Response: { balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }], is_available }

/** DeepSeek lists CNY and USD wallets; billing uses whichever has funds. */
export function parseDeepSeekBalance(body: Record<string, unknown>): UiUsageData[] {
  const isAvailable = body.is_available === undefined ? true : body.is_available === true;
  const data: UiUsageData[] = [];
  if (Array.isArray(body.balance_infos)) {
    for (const info of body.balance_infos) {
      if (!record(info)) continue;
      const currency = typeof info.currency === 'string' ? info.currency : 'CNY';
      const total = numberField(info, 'total_balance');
      data.push({ planName: currency, ...(total !== undefined ? { remaining: total } : {}), unit: currency, isValid: isAvailable, ...(isAvailable ? {} : { invalidMessage: '余额不足' }) });
    }
  }
  // Once any wallet has funds, empty wallets are hidden instead of reading as exhausted.
  if (data.some((entry) => (entry.remaining ?? 0) > 0)) return data.filter((entry) => (entry.remaining ?? 0) > 0);
  return data;
}

// ── StepFun ──────────────────────────────────────────────────────────────────
// GET https://api.stepfun.com/v1/accounts
// Response: { object, type, balance, total_cash_balance, total_voucher_balance }

export function parseStepFunBalance(body: Record<string, unknown>): UiUsageData[] {
  const balance = numberField(body, 'balance') ?? 0;
  return [{ planName: 'StepFun', remaining: balance, unit: 'CNY', isValid: true }];
}

// ── SiliconFlow ──────────────────────────────────────────────────────────────
// GET https://api.siliconflow.cn/v1/user/info (or .com for the EN site)
// Response: { code, data: { balance, chargeBalance, totalBalance, status } }

export function parseSiliconFlowBalance(body: Record<string, unknown>, isCn: boolean): UiUsageData[] {
  const data = record(body.data) ? body.data : undefined;
  if (!data) throw new UsageQueryError('SiliconFlow 响应缺少 data 字段');
  const total = numberField(data, 'totalBalance') ?? 0;
  return [{ planName: isCn ? 'SiliconFlow' : 'SiliconFlow (EN)', remaining: total, unit: isCn ? 'CNY' : 'USD', isValid: true }];
}

// ── OpenRouter ───────────────────────────────────────────────────────────────
// GET https://openrouter.ai/api/v1/credits
// Response: { data: { total_credits, total_usage } }
// /key's limit_remaining is a spending cap, not the account credit balance.

export function parseOpenRouterBalance(body: Record<string, unknown>): UiUsageData[] {
  const data = record(body.data) ? body.data : body;
  const totalCredits = numberField(data, 'total_credits');
  const totalUsage = numberField(data, 'total_usage');
  if (totalCredits === undefined || totalUsage === undefined) throw new UsageQueryError('OpenRouter 余额响应缺少金额字段');
  // Purchased credits say nothing about key validity; a free account with no
  // credits can still use free models, so the balance shows without flagging
  // the key as expired.
  return [{ planName: 'OpenRouter', remaining: totalCredits - totalUsage, total: totalCredits, used: totalUsage, unit: 'USD', isValid: true }];
}

// ── Novita AI ────────────────────────────────────────────────────────────────
// GET https://api.novita.ai/v3/user/balance
// Response: { availableBalance, cashBalance, creditLimit, outstandingInvoices }
// Amounts are expressed in 0.0001 USD units.

export function parseNovitaBalance(body: Record<string, unknown>): UiUsageData[] {
  const available = numberField(body, 'availableBalance');
  if (available === undefined) throw new UsageQueryError('Novita AI 余额响应缺少金额字段');
  return [{ planName: 'Novita AI', remaining: available / 10_000, unit: 'USD', isValid: true }];
}

// ── Dispatch ─────────────────────────────────────────────────────────────────


/** Runs the native balance query for a detected provider. */
export async function queryNativeBalance(provider: BalanceProvider, apiKey: string): Promise<UiUsageData[]> {
  const plan = nativeBalancePlan(provider);
  let body: Record<string, unknown>;
  try {
    body = await fetchUsageJson(plan.url, { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'pi-desktop usage-query' });
  } catch (error) {
    // Auth failures are deterministic, not transient: retrying an invalid key
    // cannot succeed and would only spam the provider.
    if (error instanceof UsageQueryError && (error.status === 401 || error.status === 403)) throw new UsageQueryError(`鉴权失败（HTTP ${error.status}），请检查凭据`);
    throw error;
  }
  return plan.parse(body);
}

function nativeBalancePlan(provider: BalanceProvider): { url: string; parse: (body: Record<string, unknown>) => UiUsageData[] } {
  switch (provider) {
    case 'deepseek': return { url: 'https://api.deepseek.com/user/balance', parse: parseDeepSeekBalance };
    case 'stepfun': return { url: 'https://api.stepfun.com/v1/accounts', parse: parseStepFunBalance };
    case 'siliconflow-cn': return { url: 'https://api.siliconflow.cn/v1/user/info', parse: (body) => parseSiliconFlowBalance(body, true) };
    case 'siliconflow-en': return { url: 'https://api.siliconflow.com/v1/user/info', parse: (body) => parseSiliconFlowBalance(body, false) };
    case 'openrouter': return { url: 'https://openrouter.ai/api/v1/credits', parse: parseOpenRouterBalance };
    case 'novita': return { url: 'https://api.novita.ai/v3/user/balance', parse: parseNovitaBalance };
  }
}

