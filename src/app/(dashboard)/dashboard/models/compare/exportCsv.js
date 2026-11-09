// CSV export of the comparison table — the fastest way to diff two providers
// side by side in a spreadsheet.

const HEADER = [
  "model", "provider", "context_window", "max_output",
  "input_per_1m", "output_per_1m", "cache_read_per_1m", "cache_write_per_1m",
  "price_source", "price_updated", "price_warnings",
  "status", "requests_24h", "error_rate", "avg_latency_ms", "alias", "disabled",
  "output_tokens_per_second", "time_to_first_output_ms", "speed_samples_24h",
];

function cell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildCatalogCsv(groups, providers = {}) {
  const lines = [HEADER.join(",")];
  for (const group of groups || []) {
    for (const row of group.providers || []) {
      lines.push([
        group.name || group.id,
        providers[row.providerAlias]?.name || row.providerAlias,
        row.caps?.contextWindow,
        row.caps?.maxOutput,
        row.pricing?.input,
        row.pricing?.output,
        row.pricing?.cached,
        row.pricing?.cache_creation,
        row.pricingSource?.source,
        row.pricingSource?.updatedAt,
        (row.pricingSource?.warnings || []).map((warning) => warning.code).join("; "),
        row.status?.label,
        row.health?.requests,
        row.health?.errorRate,
        row.health?.avgLatency,
        row.alias,
        row.disabled ? "yes" : "no",
        row.health?.tokensPerSecond,
        row.health?.avgTtft,
        row.health?.speedSamples,
      ].map(cell).join(","));
    }
  }
  return lines.join("\n");
}

export function downloadCatalogCsv(groups, providers = {}) {
  const csv = `\uFEFF${buildCatalogCsv(groups, providers)}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `9router-models-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
