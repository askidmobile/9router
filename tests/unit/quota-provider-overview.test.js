// Агрегация таблицы «по провайдерам» (основной режим страницы Quota Tracker).
// Сам компонент — "use client" JSX и по конвенции репозитория в vitest не
// импортируется; покрыта чистая логика из overviewUtils.js.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildProviderOverviewRows,
  formatEtaDays,
  formatMoney,
  isQuotaEntryDepleted,
  sortProviderRows,
  STATUS_STYLES,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/overviewUtils.js";

// Кредитный баланс в стиле creditBalance(): баланс в total, used=0.
function credit(total, currency = "USD") {
  return { name: "Available (USD)", used: 0, total, isCreditBalance: true, currency, resetAt: null };
}

function limitQuota(name, used, total, resetAt = null) {
  return { name, used, total, resetAt };
}

describe("quota provider overview", () => {
  it("sums credit balances across accounts and computes USD depletion ETA from 24h spend", () => {
    const rows = buildProviderOverviewRows({
      connections: [
        { id: "a1", provider: "apinex", name: "acc1", isActive: true },
        { id: "a2", provider: "apinex", name: "acc2", isActive: true },
      ],
      quotaData: {
        a1: { quotas: [credit(9)] },
        a2: { quotas: [credit(3)] },
      },
      statsByProvider: {
        apinex: { cost: 4, requests: 100, promptTokens: 1000, completionTokens: 500 },
      },
    });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.balances).toEqual({ USD: 12 });
    expect(row.balanceUsd).toBe(12);
    expect(row.etaDays).toBe(3); // $12 / $4 в сутки
    expect(row.spend24h).toEqual({ cost: 4, requests: 100, tokens: 1500 });
    // ETA 3 дня < 7 → по спеке статуса это low, не ok.
    expect(row.status).toBe("low");
  });

  it("keeps balances per currency and computes ETA from USD only (deepseek CNY+USD)", () => {
    const rows = buildProviderOverviewRows({
      connections: [{ id: "d1", provider: "deepseek", name: "acc", isActive: true }],
      quotaData: {
        d1: {
          quotas: [
            credit(100, "CNY"),
            credit(2.5, "USD"),
          ],
        },
      },
      statsByProvider: {
        deepseek: { cost: 0.5, requests: 10, promptTokens: 0, completionTokens: 0 },
      },
    });

    const row = rows[0];
    expect(row.balances).toEqual({ CNY: 100, USD: 2.5 });
    expect(row.balanceUsd).toBe(2.5);
    expect(row.etaDays).toBe(5); // только USD-баланс делится на USD-расход
  });

  it("does not treat isAmount rows (rate limits, lifetime spend) as balance", () => {
    const rows = buildProviderOverviewRows({
      connections: [{ id: "x1", provider: "apinex", name: "acc", isActive: true }],
      quotaData: {
        x1: {
          quotas: [
            credit(5),
            // «Rate limit» apinex: isAmount без валюты — это requests/min.
            { name: "Rate limit", used: 0, total: 60, isAmount: true, amountLabel: "Limit", unit: "requests/min" },
          ],
        },
      },
    });

    expect(rows[0].balances).toEqual({ USD: 5 });
    expect(rows[0].balanceUsd).toBe(5);
  });

  it("one depleted account out of three is low, not critical", () => {
    const rows = buildProviderOverviewRows({
      connections: [
        { id: "c1", provider: "codex", name: "acc1", isActive: true },
        { id: "c2", provider: "codex", name: "acc2", isActive: true },
        { id: "c3", provider: "codex", name: "acc3", isActive: true },
      ],
      quotaData: {
        c1: { quotas: [limitQuota("5h", 99, 100)] }, // 1% — исчерпан
        c2: { quotas: [limitQuota("5h", 10, 100)] },
        c3: { quotas: [limitQuota("5h", 0, 100)] },
      },
    });

    expect(rows[0].status).toBe("low");
    expect(rows[0].availableCount).toBe(2);
    expect(rows[0].activeCount).toBe(3);
    expect(rows[0].worstRemainingPct).toBe(1);
    // Средний остаток по аккаунтам с данными: (1 + 90 + 100) / 3 = 63.67 → 64.
    expect(rows[0].avgRemainingPct).toBe(64);
    expect(rows[0].dataAccountCount).toBe(3);
  });

  it("shows the average remaining limit next to the worst (OpenCode Go 50/0/50 case)", () => {
    // Сценарий с продa: один аккаунт исчерпан (0% Monthly), у двух — по 50%;
    // строка провайдера не должна выглядеть «мёртвой»: worst 0%, avg 33%.
    const rows = buildProviderOverviewRows({
      connections: [
        { id: "o1", provider: "opencode-go", name: "Askid Gmail", isActive: true },
        { id: "o2", provider: "opencode-go", name: "Ae10", isActive: true },
        { id: "o3", provider: "opencode-go", name: "Ae10Us", isActive: true },
      ],
      quotaData: {
        o1: {
          quotas: [
            limitQuota("Rolling (5h)", 0, 100),
            limitQuota("Weekly", 0, 100),
            limitQuota("Monthly", 50, 100),
          ],
        },
        o2: {
          quotas: [
            limitQuota("Rolling (5h)", 0, 100),
            limitQuota("Weekly", 0, 100),
            limitQuota("Monthly", 100, 100),
          ],
        },
        o3: {
          quotas: [
            limitQuota("Rolling (5h)", 0, 100),
            limitQuota("Weekly", 0, 100),
            limitQuota("Monthly", 50, 100),
          ],
        },
      },
    });

    const row = rows[0];
    expect(row.status).toBe("low"); // часть аккаунтов исчерпана, но не все
    expect(row.availableCount).toBe(2);
    // Худший per-account остаток = Monthly 0% у Ae10; средний = (50+0+50)/3 = 33.
    expect(row.worstRemainingPct).toBe(0);
    expect(row.worstQuotaName).toBe("Monthly");
    expect(row.avgRemainingPct).toBe(33);
  });

  it("single account with data has no average shown (it duplicates the worst)", () => {
    const rows = buildProviderOverviewRows({
      connections: [{ id: "s1", provider: "qoder", name: "acc", isActive: true }],
      quotaData: { s1: { quotas: [limitQuota("Personal", 10, 100)] } },
    });
    expect(rows[0].dataAccountCount).toBe(1);
    // Поле считается, но компонент показывает ⌀ только при dataAccountCount > 1.
    expect(rows[0].avgRemainingPct).toBe(90);
  });

  it("all active accounts depleted → critical; turned-off accounts excluded", () => {
    const rows = buildProviderOverviewRows({
      connections: [
        { id: "k1", provider: "kiro", name: "acc1", isActive: true },
        { id: "k2", provider: "kiro", name: "acc2", isActive: false },
      ],
      quotaData: {
        k1: { quotas: [limitQuota("session", 100, 100)] },
        k2: { quotas: [limitQuota("session", 100, 100)] },
      },
    });

    expect(rows[0].status).toBe("critical");
    expect(rows[0].activeCount).toBe(1);
  });

  it("zero USD balance marks a money provider critical even with healthy rate-limit rows", () => {
    const rows = buildProviderOverviewRows({
      connections: [{ id: "z1", provider: "apinex", name: "acc", isActive: true }],
      quotaData: {
        z1: {
          quotas: [
            credit(0),
            { name: "Rate limit", used: 0, total: 60, isAmount: true, unit: "requests/min" },
          ],
        },
      },
    });

    expect(rows[0].status).toBe("critical");
    expect(formatEtaDays(rows[0].etaDays, rows[0].balanceUsd)).toBe("Depleted");
  });

  it("claude error placeholder row does not make the provider critical", () => {
    const rows = buildProviderOverviewRows({
      connections: [{ id: "e1", provider: "claude", name: "acc", isActive: true }],
      quotaData: {
        e1: { quotas: [{ name: "error", used: 0, total: 0, message: "bad token" }] },
      },
    });

    // Ошибка аккаунта — статус error, но не «критичные квоты».
    expect(rows[0].status).toBe("error");
    expect(rows[0].worstRemainingPct).toBeNull();
  });

  it("vercel remaining-balance row counts as 96% limit, not depleted", () => {
    // used хранит сам остаток ($4.9 из $5), явный remainingPercentage=98.
    const vercelRow = { name: "Remaining (USD)", used: 4.9, total: 5, remainingPercentage: 98 };
    expect(isQuotaEntryDepleted(vercelRow)).toBe(false);

    const rows = buildProviderOverviewRows({
      connections: [{ id: "v1", provider: "vercel-ai-gateway", name: "acc", isActive: true }],
      quotaData: { v1: { quotas: [vercelRow] } },
    });
    expect(rows[0].worstRemainingPct).toBe(98);
    expect(rows[0].status).toBe("ok");
    // Строка не помечена isCreditBalance — в денежный баланс не попадает.
    expect(rows[0].balanceUsd).toBeNull();
  });

  it("adds spend-only rows for providers present in stats but without quota connections", () => {
    const rows = buildProviderOverviewRows({
      connections: [{ id: "q1", provider: "qoder", name: "acc", isActive: true }],
      quotaData: { q1: { quotas: [limitQuota("Personal", 10, 100)] } },
      statsByProvider: {
        qoder: { cost: 1, requests: 5, promptTokens: 0, completionTokens: 0 },
        experiential: { cost: 2.5, requests: 40, promptTokens: 9000, completionTokens: 1000 },
      },
    });

    const byId = Object.fromEntries(rows.map((r) => [r.providerId, r]));
    expect(byId.qoder.spend24h.cost).toBe(1);
    expect(byId.experiential.spendOnly).toBe(true);
    expect(byId.experiential.spend24h.cost).toBe(2.5);
    expect(byId.experiential.accounts).toEqual([]);
  });

  it("partially errored provider keeps status from accounts with data", () => {
    const rows = buildProviderOverviewRows({
      connections: [
        { id: "p1", provider: "github", name: "acc1", isActive: true },
        { id: "p2", provider: "github", name: "acc2", isActive: true },
      ],
      quotaData: {
        p1: { quotas: [limitQuota("copilot", 20, 100)] },
      },
      errors: { p2: "HTTP 500" },
    });

    expect(rows[0].status).toBe("ok");
    expect(rows[0].erroredCount).toBe(1);
  });

  it("hidden quota rows (quotaVisibility) are excluded from aggregates", () => {
    const rows = buildProviderOverviewRows({
      connections: [{ id: "h1", provider: "antigravity", name: "acc", isActive: true }],
      quotaData: {
        h1: {
          quotas: [
            { name: "Gemini (Weekly)", modelKey: "gemini_weekly", used: 99, total: 100 },
            { name: "Claude & GPT (Weekly)", modelKey: "claude_gpt_weekly", used: 0, total: 100 },
          ],
        },
      },
      quotaVisibility: { antigravity: { hidden: ["gemini_weekly"] } },
    });

    expect(rows[0].worstRemainingPct).toBe(100);
    expect(rows[0].worstQuotaName).toBe("Claude & GPT (Weekly)");
  });

  it("sorts critical first, then by 24h spend; spend and eta sorts work", () => {
    const rows = [
      { providerId: "ok1", label: "OK Provider", status: "ok", spend24h: { cost: 9 }, etaDays: 40 },
      { providerId: "crit", label: "Crit Provider", status: "critical", spend24h: { cost: 1 }, etaDays: 0.2 },
      { providerId: "low", label: "Low Provider", status: "low", spend24h: { cost: 5 }, etaDays: 3 },
      { providerId: "ok2", label: "OK Two", status: "ok", spend24h: { cost: 2 }, etaDays: null },
    ];

    const bySeverity = sortProviderRows(rows, "severity", "desc");
    expect(bySeverity.map((r) => r.providerId)).toEqual(["crit", "low", "ok1", "ok2"]);

    const bySpend = sortProviderRows(rows, "spend", "desc");
    expect(bySpend.map((r) => r.spend24h.cost)).toEqual([9, 5, 2, 1]);

    const byEta = sortProviderRows(rows, "eta", "asc");
    // null — вниз, остальные по возрастанию срока.
    expect(byEta.map((r) => r.providerId)).toEqual(["crit", "low", "ok1", "ok2"]);
  });

  it("formats ETA and money labels", () => {
    expect(formatEtaDays(null, null)).toBe("—");
    expect(formatEtaDays(null, 10)).toBe("No spend");
    expect(formatEtaDays(0, 0)).toBe("Depleted");
    expect(formatEtaDays(0.5, 5)).toBe("≈ 12h");
    expect(formatEtaDays(3.14, 5)).toBe("≈ 3.1d");
    expect(formatEtaDays(31, 5)).toBe("> 30d");
    expect(formatMoney(12.345)).toBe("$12.35");
    expect(formatMoney(7, "CNY")).toBe("7.00 CNY");
  });

  it("status icon names never collide with i18n dictionary keys", () => {
    // Runtime-транслятор переписывает текстовые ноды по словарю; совпадение
    // имени material-иконки с ключом ломает ligature («error» → «ошибка»
    // вместо глифа в бейдже Critical). Ни один словарь не должен содержать
    // имён иконок статусов (инцидент 2026-11-20: ключ «error» в ru/uk).
    const literalsDir = join(
      dirname(dirname(fileURLToPath(import.meta.url))),
      "..",
      "public",
      "i18n",
      "literals",
    );
    const iconNames = Object.values(STATUS_STYLES).map((s) => s.icon);
    const files = readdirSync(literalsDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const dict = JSON.parse(readFileSync(join(literalsDir, file), "utf-8"));
      for (const icon of iconNames) {
        expect(dict, `${file} must not translate the icon name "${icon}"`).not.toHaveProperty(icon);
      }
    }
  });
});
