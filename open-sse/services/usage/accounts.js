import { ACCOUNT_QUOTA_URLS, KENARI_QUOTA_URL } from "../../config/quotaTracking.js";
import { creditBalance, fetchWithTimeout, parseResetTime, toFiniteNumber } from "./shared.js";
import { parseRateLimitHeaders } from "./rateLimits.js";

async function readAccountJson(url, headers, proxyOptions) {
  const response = await fetchWithTimeout(url, { headers, redirect: "error" }, 10000, proxyOptions);
  if (response.status === 401) throw new Error("Authentication failed. Check the connection credentials.");
  if (response.status === 403) throw new Error("Quota access requires reporting permission for this key.");
  if (!response.ok) throw new Error(`Quota API unavailable (HTTP ${response.status}).`);
  const data = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Quota data unavailable.");
  return { data, headers: response.headers };
}

export async function getAccountUsage(connection, proxyOptions = null) {
  const { provider, apiKey, accessToken, providerSpecificData } = connection;
  const token = apiKey || accessToken;
  if (typeof token !== "string" || !token.trim()) return { message: "Credentials unavailable for quota tracking." };
  const headers = { Authorization: `Bearer ${token.trim()}`, Accept: "application/json" };
  if (provider === "kilocode" && providerSpecificData?.orgId) headers["X-Kilocode-OrganizationID"] = providerSpecificData.orgId;
  const url = new URL(ACCOUNT_QUOTA_URLS[provider]);
  const jina = provider === "jina-ai" || provider === "jina-reader";
  // The official dashboard requires a query key; never return raw errors or account payloads.
  if (jina) { url.searchParams.set("api_key", token.trim()); delete headers.Authorization; }

  try {
    const { data, headers: responseHeaders } = await readAccountJson(url.toString(), headers, proxyOptions);
    const quotas = {};
    let notice;
    if (provider === "apinex" || provider === "cheaper") {
      const reserved = toFiniteNumber(data.reserved_usd, null);
      const available = provider === "cheaper"
        ? toFiniteNumber(data.available_usd, null)
        : toFiniteNumber(data.balance_usd, null);
      if (available === null) throw new Error("Balance data unavailable.");
      const amount = provider === "apinex" && reserved !== null ? Math.max(0, available - reserved) : available;
      const name = provider === "apinex" && reserved === null ? "Balance (USD)" : "Available (USD)";
      quotas[name] = creditBalance(amount, "USD");
      if (reserved !== null) quotas[name].detail = `Reserved: ${reserved.toFixed(2)} USD`;
      const rpm = toFiniteNumber(data.rpm, null);
      if (provider === "apinex" && rpm !== null) quotas["Rate limit"] = { total: rpm, used: 0, isAmount: true, amountLabel: "Limit", unit: "requests/min" };
    } else if (provider === "requesty") {
      const used = toFiniteNumber(data.monthly_spend, null);
      const total = toFiniteNumber(data.monthly_limit, null);
      if (used === null || total === null || total < 0) throw new Error("Monthly budget data unavailable.");
      quotas["Monthly key spend (USD)"] = { used, total, unit: "USD", unlimited: total === 0, remainingPercentage: total > 0 ? Math.max(0, Math.round((total - used) / total * 100)) : undefined };
    } else if (provider === "qubax") {
      if (data.currency !== "USD") throw new Error("Balance currency unavailable.");
      quotas["Balance (USD)"] = creditBalance(data.balance_usd, "USD");
      Object.assign(quotas, parseRateLimitHeaders(provider, responseHeaders));
    } else if (provider === "kilocode") {
      quotas["Balance (USD)"] = creditBalance(data.balance, "USD");
    } else if (provider === "unorouter") {
      // /api/usage/token/ reports quota units, 500,000 per US$1 (Platform API
      // docs). The top-level total_* describe the API key's own grant: an
      // unlimited key has granted=0, so its total_available goes negative by
      // construction — that is NOT the account balance. The money the
      // provider's dashboard shows lives in user_quota (verified 2026-11-20:
      // user_quota.total_available 2 517 459 = $5.03 on the payment page).
      const payload = data?.data ?? data;
      const DIVISOR = 500000;
      const userAvailable = toFiniteNumber(payload.user_quota?.total_available, null);
      const keyAvailable = toFiniteNumber(payload.total_available, null);
      const keyGranted = toFiniteNumber(payload.total_granted, null);

      let available = userAvailable;
      if (available === null) {
        // Fallback for payloads without user_quota: the key view is only
        // meaningful when the key actually holds a grant.
        if (keyAvailable === null || (payload.unlimited_quota === true && (keyGranted ?? 0) === 0)) {
          throw new Error("Balance data unavailable.");
        }
        available = keyAvailable;
      }
      quotas["Available (USD)"] = creditBalance(available / DIVISOR, "USD");

      const usedUnits = toFiniteNumber(payload.user_quota?.total_used ?? payload.total_used, null);
      const detail = [
        usedUnits !== null ? `Used: $${(usedUnits / DIVISOR).toFixed(2)}` : null,
        payload.unlimited_quota === true
          ? "API key: unlimited"
          : keyGranted !== null && keyGranted > 0
            ? `Key grant: $${(keyGranted / DIVISOR).toFixed(2)}`
            : null,
      ].filter(Boolean).join(" · ");
      if (detail) quotas["Available (USD)"].detail = detail;

      // Подписка (недельная квота тарифа). sk-ключ её не видит: роуту нужен
      // токен доступа сайта + заголовок New-Api-User с id пользователя
      // (оба хранятся в providerSpecificData, поля опциональны). Провал
      // запроса не должен глушить баланс — просто остаёмся без строки.
      const subToken = typeof providerSpecificData?.unorouterAccessToken === "string" ? providerSpecificData.unorouterAccessToken.trim() : "";
      const subUserId = typeof providerSpecificData?.unorouterUserId === "string" ? providerSpecificData.unorouterUserId.trim() : "";
      if (subToken && subUserId) {
        try {
          const subRes = await fetchWithTimeout(
            "https://api.unorouter.com/api/subscription/self",
            {
              headers: { Authorization: `Bearer ${subToken}`, "New-Api-User": subUserId, Accept: "application/json" },
              redirect: "error",
            },
            10000,
            proxyOptions,
          );
          if (subRes.ok) {
            const subJson = await subRes.json();
            const subs = Array.isArray(subJson?.data?.subscriptions) ? subJson.data.subscriptions : [];
            for (const entry of subs) {
              const sub = entry?.subscription ?? entry;
              if (!sub || sub.status !== "active") continue;
              const totalUsd = (toFiniteNumber(sub.amount_total, 0) || 0) / DIVISOR;
              const usedUsd = (toFiniteNumber(sub.amount_used, 0) || 0) / DIVISOR;
              if (totalUsd <= 0) continue;
              quotas[`Subscription · ${entry.plan_title || "plan"}`] = {
                used: usedUsd,
                total: totalUsd,
                unit: "USD",
                remainingPercentage: Math.max(0, Math.round(((totalUsd - usedUsd) / totalUsd) * 100)),
                resetAt: sub.next_reset_time ? new Date(sub.next_reset_time * 1000).toISOString() : null,
                recurring: true,
              };
            }
          }
        } catch { /* подписка недоступна — баланс уже показан */ }
      }
    } else if (provider === "refuseless") {
      const available = toFiniteNumber(data.available, null);
      if (available === null) throw new Error("Balance data unavailable.");
      quotas["Available (USD)"] = creditBalance(available, "USD");
      const balance = toFiniteNumber(data.balance, null);
      const reserved = toFiniteNumber(data.reserved, null);
      const detail = [
        balance !== null ? `Balance: $${balance.toFixed(2)}` : null,
        reserved !== null && reserved > 0 ? `Reserved by in-flight requests: $${reserved.toFixed(2)}` : null,
      ].filter(Boolean).join(" · ");
      if (detail) quotas["Available (USD)"].detail = detail;
      const keyLimit = toFiniteNumber(data.key_limit, null);
      if (keyLimit !== null) quotas["Key budget left (USD)"] = creditBalance(keyLimit, "USD");
    } else if (jina) {
      quotas["Balance (tokens)"] = creditBalance(data.wallet?.total_balance, "tokens");
      const trial = toFiniteNumber(data.wallet?.trial_balance, null);
      const paid = toFiniteNumber(data.wallet?.regular_balance, null);
      if (trial !== null && paid !== null) quotas["Balance (tokens)"].detail = `Trial: ${trial.toLocaleString("en-US")} · Paid: ${paid.toLocaleString("en-US")}`;
    } else if (provider === "kenari") {
      if (data.currency !== "IDR") throw new Error("Balance currency unavailable.");
      const available = toFiniteNumber(data.available_micro_idr, null);
      if (available === null) throw new Error("Balance data unavailable.");
      quotas["Available (IDR)"] = creditBalance(available / 1000000, "IDR");
      const reserved = toFiniteNumber(data.reserved_micro_idr, null);
      if (reserved !== null) quotas["Available (IDR)"].detail = `Reserved: ${(reserved / 1000000).toFixed(2)} IDR`;
      try {
        const { data: quota } = await readAccountJson(KENARI_QUOTA_URL, headers, proxyOptions);
        const names = { five_hour: "Session (5h)", week: "Weekly", month: "Monthly" };
        for (const [key, window] of Object.entries(quota.plan?.windows || {})) {
          const total = toFiniteNumber(window.budget_rp, null);
          const used = toFiniteNumber(window.used_rp, null);
          const remaining = toFiniteNumber(window.remaining_rp, null);
          if (total === null || used === null || remaining === null) continue;
          quotas[names[key] || key] = { used, total, unit: "IDR", remainingPercentage: total > 0 ? Math.max(0, Math.round(remaining / total * 100)) : 0, resetAt: parseResetTime(window.resets_at) };
        }
        if (quota.coupon) {
          const remaining = toFiniteNumber(quota.coupon.remaining_rp, null);
          if (remaining !== null) quotas["Coupon (IDR)"] = { ...creditBalance(remaining, "IDR"), recurring: false, resetAt: parseResetTime(quota.coupon.expires_at) };
        }
      } catch { notice = "Balance loaded; subscription quota is unavailable."; }
    }
    return { quotas, ...(notice ? { notice } : {}) };
  } catch (error) {
    // Fetch errors can contain Jina's credential URL. Only our own safe messages are exposed.
    const safe = /^(Authentication failed|Quota access requires|Quota API unavailable|Quota data unavailable|Balance data unavailable|Balance currency unavailable|Monthly budget data unavailable)/.test(error.message);
    return { message: safe ? error.message : "Quota data unavailable. Try refreshing later." };
  }
}
