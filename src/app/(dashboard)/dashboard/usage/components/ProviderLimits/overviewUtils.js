import { AI_PROVIDERS } from "@/shared/constants/providers";
import {
  DEPLETED_QUOTA_THRESHOLD,
  filterQuotasByVisibility,
  getRemainingPercentage,
} from "./utils";

// Пороговые константы провайдерского статуса (в днях срока исчерпания).
export const MONEY_CRITICAL_ETA_DAYS = 1;
export const MONEY_LOW_ETA_DAYS = 7;
// Баланс ниже этой величины считаем нулевым (защита от пыли в $0.0049).
export const MONEY_DEPLETED_EPSILON_USD = 0.005;
// Худший остаток лимитной квоты, ниже которого провайдер «на исходе».
export const LOW_REMAINING_PERCENTAGE = 30;

// Эпсилон для сравнения валютных сумм.
const MONEY_EPSILON = 1e-9;

/**
 * Денежная строка квот. Деньгами считаем ТОЛЬКО isCreditBalance===true:
 * продюсер `creditBalance()` кладёт баланс в `total` (used=0) и ставит валюту.
 * Флаг `isAmount` сам по себе деньгами не является — им помечены строка
 * «Rate limit» (requests/min) у apinex и «Total spent (USD)» (потраченное
 * за всё время) у experiential; обе попали бы в «баланс» по ошибке.
 * Vercel-строка «Remaining (USD)» не помечена как баланс (в ней `used`
 * хранит сам остаток) — она учитывается как обычный лимитовый процент.
 */
export function isMoneyQuota(quota) {
  return quota?.isCreditBalance === true;
}

/**
 * Лимитная строка, пригодная для агрегата «худший остаток %».
 * Отбрасываем: денежные, unlimited, error-заглушки ({name:"error", message})
 * и строки-заглушки без тотала и без явного процента (0/0 — шум).
 */
export function isLimitQuota(quota) {
  if (!quota || quota.message) return false;
  if (isMoneyQuota(quota) || quota.unlimited === true) return false;
  return (
    quota.total > 0 ||
    quota.percentage !== undefined ||
    quota.remainingPercentage !== undefined
  );
}

/**
 * Единая проверка «квота исчерпана» — для таблицы и для bulk-кнопок
 * (Turn off/on Empty), чтобы они всегда согласованы.
 *
 * Для денежных строк баланс = total-used; нулевой баланс — исчерпано.
 * Для лимитных — остаток % по getRemainingPercentage ≤ порога. В отличие от
 * старого calculatePercentage(used,total) это уважает явные проценты
 * провайдеров (vercel: used=4.9/total=5 при остатке 96% ≠ «исчерпано»).
 */
export function isQuotaEntryDepleted(quota) {
  if (!quota || quota.message) return false;
  if (isMoneyQuota(quota)) {
    return Math.max((quota.total || 0) - (quota.used || 0), 0) <= MONEY_EPSILON;
  }
  if (!isLimitQuota(quota)) return false;
  return getRemainingPercentage(quota) <= DEPLETED_QUOTA_THRESHOLD;
}

/**
 * Классификация аккаунта (коннекта) для таблицы по провайдерам.
 * available | depleted | error | nodata | loading | inactive.
 */
export function classifyConnection(connection, quotaEntry, error, isLoading) {
  if (connection?.isActive === false) return "inactive";
  if (error) return "error";
  if (!quotaEntry) return isLoading ? "loading" : "nodata";
  const quotas = quotaEntry.quotas || [];
  if (quotas.length === 0) {
    // Топ-левел message («No current rate-limit snapshot…») — данных нет,
    // но это не ошибка авторизации.
    return "nodata";
  }
  // Claude при ошибке возвращает единственную строку {name:"error", message}.
  if (quotas.every((q) => q.message)) return "error";
  if (quotas.some(isQuotaEntryDepleted)) return "depleted";
  return "available";
}

/** Худший остаток % по видимым лимитным строкам аккаунта; null — если их нет. */
function worstRemainingPercentage(quotas) {
  let worst = null;
  for (const quota of quotas) {
    if (!isLimitQuota(quota)) continue;
    const pct = getRemainingPercentage(quota);
    if (worst === null || pct < worst) worst = pct;
  }
  return worst;
}

/** Ближайший будущий resetAt по строкам аккаунта; null — если нет. */
function nearestResetAt(quotas, nowMs) {
  let nearest = null;
  for (const quota of quotas) {
    if (!quota.resetAt) continue;
    const ts = new Date(quota.resetAt).getTime();
    if (!Number.isFinite(ts) || ts <= nowMs) continue;
    if (nearest === null || ts < nearest) nearest = ts;
  }
  return nearest;
}

/**
 * Собрать строки таблицы «по провайдерам».
 *
 * Группировка — по conn.provider: именно им ключуются quotaVisibility,
 * providerNames и usageHistory.provider (расходы статистики), а
 * getQuotaProvider() мапит к квот-провайдеру (kenari и т.п.) и развёл бы
 * группы и расходы по разным ключам.
 */
export function buildProviderOverviewRows({
  connections = [],
  quotaData = {},
  errors = {},
  loading = {},
  statsByProvider = {},
  providerNames = {},
  quotaVisibility = {},
} = {}) {
  const groups = new Map();
  for (const connection of connections) {
    const key = connection.provider || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(connection);
  }

  const nowMs = Date.now();
  const rows = [];

  for (const [providerId, providerConnections] of groups) {
    const accounts = providerConnections.map((connection) => {
      const entry = quotaData[connection.id];
      const state = classifyConnection(connection, entry, errors[connection.id], loading[connection.id]);
      const quotas = filterQuotasByVisibility(
        providerId,
        entry?.quotas || [],
        quotaVisibility,
      );
      return {
        connection,
        state,
        quotas,
        worstRemainingPct: worstRemainingPercentage(quotas),
        resetAt: nearestResetAt(quotas, nowMs),
        plan: entry?.plan || null,
      };
    });

    // Балансы суммируем по каждой валюте отдельно (deepseek держит CNY и USD
    // одновременно, minimax — «credits»). ETA и футер считаем только по USD:
    // расход статистики в долларах, делить CNY на USD нельзя.
    const balances = {};
    for (const account of accounts) {
      for (const quota of account.quotas) {
        if (!isMoneyQuota(quota)) continue;
        const currency = quota.currency || "USD";
        balances[currency] =
          (balances[currency] || 0) +
          Math.max((quota.total || 0) - (quota.used || 0), 0);
      }
    }
    const balanceUsd = balances.USD !== undefined ? balances.USD : null;

    const activeAccounts = accounts.filter((a) => a.state !== "inactive");
    const dataAccounts = activeAccounts.filter(
      (a) => a.state === "available" || a.state === "depleted",
    );
    const availableCount = dataAccounts.filter((a) => a.state === "available").length;
    const erroredCount = activeAccounts.filter((a) => a.state === "error").length;

    // Худший остаток % (для статуса) и ближайший сброс — по аккаунтам
    // с данными.
    let worstPct = null;
    let resetTs = null;
    for (const account of dataAccounts) {
      if (account.worstRemainingPct !== null && (worstPct === null || account.worstRemainingPct < worstPct)) {
        worstPct = account.worstRemainingPct;
      }
      if (account.resetAt !== null && (resetTs === null || account.resetAt < resetTs)) {
        resetTs = account.resetAt;
      }
    }

    // Агрегаты по именам квот — то, что видит пользователь в колонке:
    // «сколько осталось и доступно». Для каждой квоты провайдера средний
    // остаток считается по аккаунтам, где ЭТА квота не исчерпана (Ae10 мёртв
    // только по Monthly — его Rolling/Weekly продолжают участвовать в своих
    // агрегатах); если исчерпана у всех — среднее по всем. Худший процент
    // сохраняем для тултипа.
    const quotaSummaries = buildQuotaSummaries(dataAccounts);

    const spend = statsByProvider[providerId] || {};
    const spend24h = {
      cost: Number(spend.cost) || 0,
      requests: Number(spend.requests) || 0,
      tokens:
        (Number(spend.promptTokens) || 0) + (Number(spend.completionTokens) || 0),
    };

    // Срок исчерпания: только для USD-баланса при ненулевом темпе расхода.
    let etaDays = null;
    if (balanceUsd !== null && balanceUsd > MONEY_DEPLETED_EPSILON_USD && spend24h.cost > MONEY_EPSILON) {
      etaDays = balanceUsd / spend24h.cost;
    }

    let status;
    if (activeAccounts.length > 0 && activeAccounts.every((a) => a.state === "loading")) {
      status = "loading";
    } else if (dataAccounts.length === 0) {
      status = erroredCount > 0 ? "error" : "nodata";
    } else {
      const allDepleted = dataAccounts.every((a) => a.state === "depleted");
      const anyDepleted = !allDepleted && dataAccounts.some((a) => a.state === "depleted");
      const moneyDepleted = balanceUsd !== null && balanceUsd <= MONEY_DEPLETED_EPSILON_USD;
      const etaCritical = etaDays !== null && etaDays < MONEY_CRITICAL_ETA_DAYS;
      const etaLow = etaDays !== null && etaDays < MONEY_LOW_ETA_DAYS;
      if (allDepleted || moneyDepleted || etaCritical) {
        status = "critical";
      } else if (anyDepleted || etaLow || (worstPct !== null && worstPct <= LOW_REMAINING_PERCENTAGE)) {
        status = "low";
      } else {
        status = "ok";
      }
    }

    rows.push({
      providerId,
      label:
        AI_PROVIDERS[providerId]?.name ||
        providerNames[providerId] ||
        providerId,
      accounts,
      accountsTotal: accounts.length,
      activeCount: activeAccounts.length,
      availableCount,
      erroredCount,
      balances,
      balanceUsd,
      worstRemainingPct: worstPct,
      quotaSummaries,
      worstQuotaName: worstQuotaNameFor(dataAccounts),
      nearestResetAt: resetTs,
      spend24h,
      etaDays,
      status,
      spendOnly: false,
    });
  }

  // Провайдеры только с расходом: в статистике есть, квот-коннектов нет
  // (нативные ноды, комбо-провайдеры и т.п.). Строки тусклые, без квот.
  for (const [providerId, spend] of Object.entries(statsByProvider)) {
    if (groups.has(providerId)) continue;
    const cost = Number(spend?.cost) || 0;
    const requests = Number(spend?.requests) || 0;
    if (cost <= MONEY_EPSILON && requests <= 0) continue;
    rows.push({
      providerId,
      label: AI_PROVIDERS[providerId]?.name || providerNames[providerId] || providerId,
      accounts: [],
      accountsTotal: 0,
      activeCount: 0,
      availableCount: 0,
      erroredCount: 0,
      balances: {},
      balanceUsd: null,
      worstRemainingPct: null,
      quotaSummaries: [],
      worstQuotaName: null,
      nearestResetAt: null,
      spend24h: {
        cost,
        requests,
        tokens: (Number(spend?.promptTokens) || 0) + (Number(spend?.completionTokens) || 0),
      },
      etaDays: null,
      status: "spendOnly",
      spendOnly: true,
    });
  }

  return rows;
}

function worstQuotaNameFor(dataAccounts) {
  let name = null;
  let worst = null;
  for (const account of dataAccounts) {
    for (const quota of account.quotas) {
      if (!isLimitQuota(quota)) continue;
      const pct = getRemainingPercentage(quota);
      if (worst === null || pct < worst) {
        worst = pct;
        name = quota.name;
      }
    }
  }
  return name;
}

/**
 * Агрегаты по именам квот для строки провайдера.
 * Для каждого имени: средний остаток % по аккаунтам, где эта квота жива
 * (остаток > порога исчерпания); счётчик живых из всех; худший процент.
 * Сортировка — самые расходуемые первыми. Процентные заглушки (0/0) и
 * денежные строки не участвуют (isLimitQuota).
 */
export function buildQuotaSummaries(dataAccounts) {
  const byName = new Map();
  for (const account of dataAccounts) {
    for (const quota of account.quotas) {
      if (!isLimitQuota(quota)) continue;
      const name = quota.name;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(quota);
    }
  }

  const summaries = [];
  for (const [name, quotas] of byName) {
    const pcts = quotas.map((quota) => getRemainingPercentage(quota));
    const alive = pcts.filter((pct) => pct > DEPLETED_QUOTA_THRESHOLD);
    const pool = alive.length > 0 ? alive : pcts;
    const avgPct = Math.round(pool.reduce((sum, pct) => sum + pct, 0) / pool.length);
    summaries.push({
      name,
      avgPct,
      worstPct: Math.min(...pcts),
      accountCount: pool.length,
      totalAccounts: pcts.length,
    });
  }

  summaries.sort((a, b) => a.avgPct - b.avgPct || a.name.localeCompare(b.name));
  return summaries;
}

export const PROVIDER_SORT_KEYS = ["severity", "spend", "eta", "provider"];

const SEVERITY_RANK = {
  critical: 0,
  low: 1,
  ok: 2,
  spendOnly: 3,
  loading: 4,
  error: 5,
  nodata: 6,
};

/**
 * Сортировка строк таблицы. Дефолт «severity»: критичные сверху, внутри
 * группы — по расходу за 24ч. Остальные ключи — с направлением dir.
 */
export function sortProviderRows(rows, sortKey = "severity", sortDir = "desc") {
  const sorted = [...rows];
  const dir = sortDir === "asc" ? 1 : -1;

  sorted.sort((a, b) => {
    if (sortKey === "spend") {
      const diff = b.spend24h.cost - a.spend24h.cost;
      return diff !== 0 ? diff * -dir : a.label.localeCompare(b.label);
    }
    if (sortKey === "eta") {
      // null (нет прогноза) — всегда вниз; иначе по возрастанию срока.
      if (a.etaDays === null && b.etaDays === null) return a.label.localeCompare(b.label);
      if (a.etaDays === null) return 1;
      if (b.etaDays === null) return -1;
      const diff = a.etaDays - b.etaDays;
      return diff !== 0 ? diff * dir : a.label.localeCompare(b.label);
    }
    if (sortKey === "provider") {
      return a.label.localeCompare(b.label) * dir;
    }
    // severity (дефолт): направление фиксировано — критичные сверху.
    const rankDiff = (SEVERITY_RANK[a.status] ?? 9) - (SEVERITY_RANK[b.status] ?? 9);
    if (rankDiff !== 0) return rankDiff;
    return b.spend24h.cost - a.spend24h.cost;
  });

  return sorted;
}

/**
 * Человекочитаемый прогноз исчерпания.
 * balanceUsd нужен, чтобы отличить «нет прогноза» от «баланс уже ноль».
 */
export function formatEtaDays(etaDays, balanceUsd) {
  if (balanceUsd !== null && balanceUsd <= MONEY_DEPLETED_EPSILON_USD) {
    return "Depleted";
  }
  if (etaDays === null || !Number.isFinite(etaDays)) {
    return balanceUsd !== null ? "No spend" : "—";
  }
  if (etaDays < 1) {
    return `≈ ${Math.max(1, Math.ceil(etaDays * 24))}h`;
  }
  if (etaDays < 30) {
    return `≈ ${etaDays.toFixed(1)}d`;
  }
  return "> 30d";
}

/** Формат денежной суммы; USD — с двумя знаками, прочие валюты — с кодом. */
export function formatMoney(amount, currency = "USD") {
  const value = Number(amount) || 0;
  const fixed = value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === "USD" ? `$${fixed}` : `${fixed} ${currency}`;
}

// Стили и иконки статусов таблицы. Данные живут здесь (не в JSX), чтобы тест
// мог проверить имена иконок против i18n-словарей: runtime-транслятор ходит
// по DOM и переписывает текстовые ноды по словарю — совпадение имени иконки с
// ключом словаря ломает ligature Material Symbols (в бейдже вместо глифа
// появляется переведённое слово). Поэтому icon ≠ ключу ни одного словаря.
export const STATUS_STYLES = {
  critical: {
    chip: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
    icon: "priority_high",
  },
  low: {
    chip: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    icon: "warning",
  },
  ok: {
    chip: "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400",
    icon: "check_circle",
  },
  loading: {
    chip: "border-black/10 bg-black/[0.02] text-text-muted dark:border-white/10 dark:bg-white/[0.03]",
    icon: "progress_activity",
  },
  error: {
    chip: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
    icon: "cloud_off",
  },
  nodata: {
    chip: "border-black/10 bg-black/[0.02] text-text-muted dark:border-white/10 dark:bg-white/[0.03]",
    icon: "hourglass_empty",
  },
  spendOnly: {
    chip: "border-black/10 bg-black/[0.02] text-text-muted dark:border-white/10 dark:bg-white/[0.03]",
    icon: "payments",
  },
};
