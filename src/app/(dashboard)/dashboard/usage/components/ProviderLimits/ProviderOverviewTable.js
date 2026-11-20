"use client";

import { Fragment, useMemo, useState } from "react";
import ProviderIcon from "@/shared/components/ProviderIcon";
import QuotaTable from "./QuotaTable";
import { useTranslation } from "@/i18n/useTranslation";
import { formatResetTime, getConnectionLabel } from "./utils";
import { formatEtaDays, formatMoney, STATUS_STYLES } from "./overviewUtils";

const STATUS_LABELS = {
  critical: "Critical",
  low: "Low",
  ok: "OK",
  loading: "Loading",
  error: "Error",
  nodata: "No data",
  spendOnly: "Spend only",
};

const ACCOUNT_STATE_STYLES = {
  available: "bg-green-500/10 text-green-600 dark:text-green-400",
  depleted: "bg-red-500/10 text-red-600 dark:text-red-400",
  error: "bg-red-500/10 text-red-600 dark:text-red-400",
  nodata: "bg-surface-2 text-text-muted",
  loading: "bg-surface-2 text-text-muted",
  inactive: "bg-surface-2 text-text-muted",
};

const ACCOUNT_STATE_LABELS = {
  available: "available",
  depleted: "depleted",
  // не «error»: слово совпадает с material-иконкой и ломало бы её глиф
  error: "Failed",
  nodata: "no data",
  loading: "loading",
  inactive: "off",
};

function quotaBarColor(pct) {
  if (pct > 70) return "bg-green-500";
  if (pct >= 30) return "bg-yellow-500";
  return "bg-red-500";
}

function quotaTextColor(pct) {
  if (pct > 70) return "text-green-600 dark:text-green-400";
  if (pct >= 30) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

function SortHeader({ label, sortKey, activeSortKey, sortDir, onSort, align = "left" }) {
  const isActive = sortKey === activeSortKey;
  return (
    <th
      className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}
      aria-sort={isActive ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-0.5 uppercase tracking-wide transition-colors hover:text-text-primary ${
          isActive ? "text-text-primary" : ""
        }`}
        title={isActive ? `Sorted by ${label}` : `Sort by ${label}`}
      >
        {label}
        <span
          className={`material-symbols-outlined text-[14px] ${isActive ? "" : "opacity-0"}`}
          aria-hidden="true"
          data-i18n-skip="true"
        >
          {sortDir === "asc" ? "arrow_upward" : "arrow_downward"}
        </span>
      </button>
    </th>
  );
}

export default function ProviderOverviewTable({
  rows = [],
  sortKey = "severity",
  sortDir = "desc",
  onSort = () => {},
  onHideQuota = null,
}) {
  const t = useTranslation();
  const [expanded, setExpanded] = useState(() => new Set());

  const toggleExpanded = (providerId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(providerId)) {
        next.delete(providerId);
      } else {
        next.add(providerId);
      }
      return next;
    });
  };

  const totals = useMemo(() => {
    let balanceUsd = 0;
    let hasBalance = false;
    let spendCost = 0;
    let requests = 0;
    for (const row of rows) {
      if (row.balanceUsd !== null) {
        balanceUsd += row.balanceUsd;
        hasBalance = true;
      }
      spendCost += row.spend24h?.cost || 0;
      requests += row.spend24h?.requests || 0;
    }
    return { balanceUsd: hasBalance ? balanceUsd : null, spendCost, requests };
  }, [rows]);

  const sortButtonProps = (key) => ({
    sortKey: key,
    activeSortKey: sortKey,
    sortDir,
    onSort,
  });

  return (
    <div className="overflow-hidden rounded-2xl border border-black/10 bg-surface dark:border-white/10">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-left text-sm">
          <thead className="border-b border-black/10 bg-black/[0.03] text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.04]">
            <tr>
              <th className="w-8 px-2 py-2" aria-label={t("Expand accounts")} />
              <SortHeader label={t("Provider")} {...sortButtonProps("provider")} />
              <th className="px-3 py-2 text-left font-medium uppercase tracking-wide">{t("Status")}</th>
              <th className="px-3 py-2 text-left font-medium uppercase tracking-wide">{t("Quotas / Balance")}</th>
              <SortHeader label={t("Spend 24h")} {...sortButtonProps("spend")} />
              <SortHeader label={t("Est. depletion")} {...sortButtonProps("eta")} />
              <th className="px-3 py-2 text-left font-medium uppercase tracking-wide">{t("Next reset")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isOpen = expanded.has(row.providerId);
              const status = STATUS_STYLES[row.status] || STATUS_STYLES.nodata;
              const isCritical = row.status === "critical";
              const isLow = row.status === "low";
              const rowTint = isCritical
                ? "bg-red-500/[0.05]"
                : isLow
                  ? "bg-amber-500/[0.04]"
                  : "";
              const expandable = row.accounts.length > 0;
              const accountsLine = row.spendOnly
                ? t("No quota tracking")
                : `${row.availableCount}/${row.activeCount} ${t("available")}${
                    row.erroredCount > 0 ? ` · ${row.erroredCount} ${t("err")}` : ""
                  }`;
              const accountsTitle = row.spendOnly
                ? t("No quota tracking")
                : `${row.accountsTotal} ${t("accounts")}: ${row.availableCount} ${t("available")}, ${
                    dataStateCount(row.accounts, "depleted")
                  } ${t("depleted")}, ${inactiveCount(row.accounts)} ${t("off")}, ${row.erroredCount} ${t("err")}`;

              return (
                <Fragment key={row.providerId}>
                  <tr
                    className={`border-b border-black/5 transition-colors hover:bg-black/[0.02] dark:border-white/5 dark:hover:bg-white/[0.02] ${rowTint} ${
                      row.spendOnly ? "opacity-70" : ""
                    }`}
                  >
                    <td className="px-2 py-2.5 align-top">
                      {expandable && (
                        <button
                          type="button"
                          onClick={() => toggleExpanded(row.providerId)}
                          aria-expanded={isOpen}
                          aria-label={t("Toggle accounts")}
                          className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-black/5 hover:text-text-primary dark:hover:bg-white/5"
                        >
                          <span
                            className={`material-symbols-outlined text-[16px] transition-transform ${isOpen ? "rotate-90" : ""}`}
                            data-i18n-skip="true"
                          >
                            chevron_right
                          </span>
                        </button>
                      )}
                    </td>

                    {/* Провайдер + счётчики аккаунтов */}
                    <td className="min-w-[160px] px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <ProviderIcon
                          src={`/providers/${row.providerId}.png`}
                          alt={row.providerId}
                          size={24}
                          className="size-6 shrink-0 rounded-md object-contain"
                          fallbackText={row.providerId.slice(0, 2).toUpperCase()}
                        />
                        <div className="min-w-0">
                          <div className="truncate font-semibold text-text-primary">{row.label}</div>
                          <div className="truncate text-[11px] text-text-muted" title={accountsTitle}>
                            {accountsLine}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Статус */}
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${status.chip}`}
                      >
                        <span
                          className={`material-symbols-outlined text-[13px] ${
                            row.status === "loading" ? "animate-spin" : ""
                          }`}
                          data-i18n-skip="true"
                        >
                          {status.icon}
                        </span>
                        {t(STATUS_LABELS[row.status])}
                      </span>
                    </td>

                    {/* Квоты/баланс: агрегаты по квотам (сколько осталось и
                        доступно) + суммы денег по валютам */}
                    <td className="min-w-[180px] px-3 py-2.5">
                      <div className="space-y-1">
                        {row.quotaSummaries.slice(0, 3).map((summary) => (
                          <div
                            key={summary.name}
                            className="flex items-center gap-2"
                            title={`${summary.name}: ${t("Average remaining across available accounts")} ${summary.avgPct}% · ${summary.accountCount}/${summary.totalAccounts} ${t("accounts")} · ${t("Worst quota")} ${summary.worstPct}%`}
                          >
                            <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full border border-transparent bg-black/5 dark:bg-white/10">
                              <div
                                className={`h-full ${quotaBarColor(summary.avgPct)}`}
                                style={{ width: `${Math.min(summary.avgPct, 100)}%` }}
                              />
                            </div>
                            <span className={`text-xs font-medium tabular-nums ${quotaTextColor(summary.avgPct)}`}>
                              {summary.avgPct}%
                            </span>
                            <span className="max-w-[120px] truncate text-[11px] text-text-muted">
                              {summary.name}
                            </span>
                            {summary.accountCount < summary.totalAccounts && (
                              <span className="shrink-0 text-[11px] tabular-nums text-text-muted">
                                {summary.accountCount}/{summary.totalAccounts}
                              </span>
                            )}
                          </div>
                        ))}
                        {row.quotaSummaries.length > 3 && (
                          <div
                            className="text-[11px] text-text-muted"
                            title={row.quotaSummaries.map((s) => `${s.name}: ${s.avgPct}% (${s.accountCount}/${s.totalAccounts})`).join(" · ")}
                          >
                            +{row.quotaSummaries.length - 3}
                          </div>
                        )}
                        {Object.entries(row.balances).map(([currency, amount]) => (
                          <div
                            key={currency}
                            className="text-xs font-medium tabular-nums text-blue-600 dark:text-blue-400"
                            title={`${t("Balance across accounts")}: ${formatMoney(amount, currency)}`}
                          >
                            {formatMoney(amount, currency)}
                          </div>
                        ))}
                        {row.quotaSummaries.length === 0 && Object.keys(row.balances).length === 0 && (
                          <span className="text-xs italic text-text-muted">—</span>
                        )}
                      </div>
                    </td>

                    {/* Расход за 24 часа */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <div className="font-medium tabular-nums text-text-primary">
                        {formatMoney(row.spend24h.cost)}
                      </div>
                      <div className="text-[11px] tabular-nums text-text-muted">
                        {row.spend24h.requests.toLocaleString()} {t("req")}
                        {row.spend24h.tokens > 0 && (
                          <span title={t("Tokens in the last 24 hours")}>
                            {" · "}
                            {(row.spend24h.tokens / 1000).toFixed(1)}k
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Прогноз исчерпания (денежные провайдеры) */}
                    <td
                      className={`whitespace-nowrap px-3 py-2.5 text-right tabular-nums ${
                        row.status === "critical" ? "font-semibold text-red-600 dark:text-red-400" : "text-text-primary"
                      }`}
                      title={t("Balance divided by the average daily spend over the last 24 hours")}
                    >
                      {formatEtaDays(row.etaDays, row.balanceUsd)}
                    </td>

                    {/* Ближайший сброс окна */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-right text-xs tabular-nums text-text-muted">
                      {row.nearestResetAt
                        ? formatResetTime(new Date(row.nearestResetAt))
                        : "—"}
                    </td>
                  </tr>

                  {/* Раскрытая строка: аккаунты с их квотами */}
                  {isOpen && expandable && (
                    <tr className="border-b border-black/5 dark:border-white/5">
                      <td colSpan={7} className="bg-black/[0.015] px-4 py-3 dark:bg-white/[0.015]">
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                          {row.accounts.map((account) => (
                            <div
                              key={account.connection.id}
                              className="rounded-xl border border-black/10 bg-surface p-2 dark:border-white/10"
                            >
                              <div className="mb-1.5 flex min-w-0 items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <span className="truncate text-xs font-semibold text-text-primary">
                                    {getConnectionLabel(account.connection) || account.connection.id.slice(0, 8)}
                                  </span>
                                  {account.plan && (
                                    <span className="ml-1.5 rounded-full bg-brand-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand-600 dark:text-brand-300">
                                      {account.plan}
                                    </span>
                                  )}
                                </div>
                                <span
                                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${ACCOUNT_STATE_STYLES[account.state]}`}
                                >
                                  {t(ACCOUNT_STATE_LABELS[account.state])}
                                </span>
                              </div>
                              {account.quotas.length > 0 ? (
                                <QuotaTable
                                  quotas={account.quotas}
                                  compact
                                  sortMode="default"
                                  onHideQuota={
                                    onHideQuota
                                      ? (quotaRow) => onHideQuota(row.providerId, quotaRow)
                                      : null
                                  }
                                />
                              ) : (
                                <p className="px-1 py-2 text-[11px] italic text-text-muted">
                                  {t("No quota data")}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot className="border-t border-black/10 bg-black/[0.02] text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
            <tr>
              <td />
              <td className="px-3 py-2 font-semibold uppercase tracking-wide">
                {t("Total")} · {rows.length}
              </td>
              <td />
              <td className="px-3 py-2 tabular-nums">
                {totals.balanceUsd !== null ? formatMoney(totals.balanceUsd) : "—"}
              </td>
              <td className="px-3 py-2 text-right font-medium tabular-nums text-text-primary">
                {formatMoney(totals.spendCost)}
                <div className="text-[11px] font-normal text-text-muted">
                  {totals.requests.toLocaleString()} {t("req")}
                </div>
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function dataStateCount(accounts, state) {
  return accounts.filter((a) => a.state === state).length;
}

function inactiveCount(accounts) {
  return accounts.filter((a) => a.state === "inactive").length;
}
