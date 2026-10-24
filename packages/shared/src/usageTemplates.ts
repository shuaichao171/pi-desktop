import type { UiUsageQueryTemplate } from './managementFeatures';

/**
 * Usage-query script presets, mirroring cc-switch's template family.
 * `{{baseUrl}}` `{{apiKey}}` `{{accessToken}}` `{{userId}}` are replaced by the
 * host before execution; scripts evaluate to
 * `{ request: {url, method, headers?}, extractor: function(response) }`.
 */
export const USAGE_SCRIPT_USER_AGENT = 'pi-desktop usage-query';

export function usageScriptPreset(template: UiUsageQueryTemplate): string {
  switch (template) {
    case 'general': return `({
  request: {
    url: "{{baseUrl}}/user/balance",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "User-Agent": "${USAGE_SCRIPT_USER_AGENT}"
    }
  },
  extractor: function(response) {
    return {
      isValid: response.is_active || true,
      remaining: response.balance,
      unit: "USD"
    };
  }
})`;
    case 'newapi': return `({
  request: {
    url: "{{baseUrl}}/api/user/self",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer {{accessToken}}",
      "User-Agent": "${USAGE_SCRIPT_USER_AGENT}",
      "New-Api-User": "{{userId}}"
    },
  },
  extractor: function (response) {
    if (response.success && response.data) {
      return {
        planName: response.data.group || "default",
        remaining: response.data.quota / 500000,
        used: response.data.used_quota / 500000,
        total: (response.data.quota + response.data.used_quota) / 500000,
        unit: "USD",
      };
    }
    return {
      isValid: false,
      invalidMessage: response.message || "usage query failed"
    };
  },
})`;
    case 'sub2api': return `({
  request: {
    url: "{{baseUrl}}".replace(/\\/+$/, "").replace(/\\/v1$/, "") + "/v1/usage",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "User-Agent": "${USAGE_SCRIPT_USER_AGENT}"
    }
  },
  extractor: function (response) {
    var quota = response.quota || {};
    var result = {
      isValid: response.isValid !== false,
      unit: response.unit || quota.unit || "USD"
    };
    if (typeof response.planName === "string") result.planName = response.planName;
    if (typeof response.remaining === "number" && response.remaining >= 0) {
      result.remaining = response.remaining;
    }
    if (quota.limit > 0) {
      result.used = quota.used;
      result.total = quota.limit;
    }
    if (!result.isValid) {
      result.invalidMessage = response.status
        ? String(response.status)
        : "usage query failed";
    }
    return result;
  },
})`;
    case 'custom': return `({
  request: {
    url: "",
    method: "GET",
    headers: {}
  },
  extractor: function(response) {
    return {
      remaining: 0,
      unit: "USD"
    };
  }
})`;
    case 'balance': return '';
  }
}
