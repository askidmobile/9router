// Filtering rules for both Models views.
//
// The Active/All switch has one meaning across the page: "active" = a model the
// router can serve right now, i.e. its provider is connected and the model is not
// disabled. Keeping that in one place stops the provider view and the model view
// from drifting apart, which is exactly how the disabled models leaked into the
// default view in the first place.

/** A row the router can currently serve. */
export function isRowActive(row) {
  return row?.active === true && row?.disabled !== true;
}

function matchesQuery(row, query, groupName = "") {
  if (!query) return true;
  return (
    String(row.id || "").toLowerCase().includes(query)
    || String(row.name || "").toLowerCase().includes(query)
    || String(row.alias || "").toLowerCase().includes(query)
    || String(groupName || "").toLowerCase().includes(query)
  );
}

/**
 * @param {object[]} providerGroups - `{ key, active, models[] }`
 * @param {{scope?: string, providerFilter?: string, query?: string}} options
 */
export function filterProviderGroups(providerGroups, { scope = "all", providerFilter = "", query = "" } = {}) {
  const needle = query.trim().toLowerCase();
  return providerGroups
    .map((group) => {
      if (providerFilter && group.key !== providerFilter) return null;
      if (scope === "active" && !group.active) return null;
      const scoped = scope === "active"
        ? group.models.filter((row) => row.disabled !== true)
        : group.models;
      const models = scoped.filter((row) => matchesQuery(row, needle));
      return models.length > 0 ? { ...group, models } : null;
    })
    .filter(Boolean);
}

/**
 * @param {object[]} modelGroups - `{ identity, name, providers[] }`
 * @param {{scope?: string, providerFilter?: string, query?: string,
 *          statusFilter?: string, statusMatchers?: object}} options
 */
export function filterModelGroups(modelGroups, {
  scope = "all",
  providerFilter = "",
  query = "",
  statusFilter = "",
  statusMatchers = {},
} = {}) {
  const needle = query.trim().toLowerCase();
  const statusMatch = statusFilter ? statusMatchers[statusFilter] : null;

  return modelGroups
    .map((group) => {
      let rows = group.providers;
      if (providerFilter) rows = rows.filter((row) => row.providerAlias === providerFilter);
      if (scope === "active") rows = rows.filter(isRowActive);
      if (statusMatch) rows = rows.filter(statusMatch);
      rows = rows.filter((row) => matchesQuery(row, needle, group.name));
      return rows.length > 0 ? { ...group, providers: rows } : null;
    })
    .filter(Boolean);
}

export const STATUS_MATCHERS = {
  issues: (row) => ["degraded", "down", "cooldown"].includes(row.status?.state),
  "missing-price": (row) => !row.pricing || Object.keys(row.pricing).length === 0,
  "cache-missing": (row) => row.pricingSource?.fallbacks?.cached === "input",
};