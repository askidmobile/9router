"use client";

import { useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import Select from "./Select";
import Toggle from "./Toggle";

export default function ProviderProxyCard({ providerId }) {
  const [pools, setPools] = useState([]);
  const [policy, setPolicy] = useState({ proxyEnabled: false, proxyPoolIds: [], rotateStrategy: "none" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const endpoint = `/api/settings/provider-proxy/${encodeURIComponent(providerId)}`;

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetch("/api/proxy-pools", { cache: "no-store" }), fetch(endpoint, { cache: "no-store" })])
      .then(async ([poolResponse, policyResponse]) => {
        if (!poolResponse.ok || !policyResponse.ok) throw new Error("Failed to load proxy settings");
        const [poolData, policyData] = await Promise.all([poolResponse.json(), policyResponse.json()]);
        if (!cancelled) {
          setPools(poolData.proxyPools || []);
          setPolicy(policyData);
          setLoading(false);
        }
      }).catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [endpoint]);

  const update = changes => { setPolicy(current => ({ ...current, ...changes })); setMessage(""); };
  const save = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(policy) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to save proxy settings");
      setPolicy(data);
      setMessage("Saved");
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold mb-3">Provider proxy</h2>
      <Toggle checked={policy.proxyEnabled} onChange={proxyEnabled => update({ proxyEnabled })} disabled={loading || saving}
        label="Enable proxy for this provider" description="Off by default. Imported proxies are never assigned automatically." />
      {policy.inherited && <p className="text-xs text-text-muted mt-2">Existing connection-specific proxies are preserved until you save a provider policy here.</p>}
      {policy.proxyEnabled && (
        <div className="flex flex-col gap-3 mt-4">
          <Select label="Rotation" aria-label="Proxy rotation" value={policy.rotateStrategy} disabled={saving || loading}
            onChange={event => update({ rotateStrategy: event.target.value, proxyPoolIds: event.target.value === "none" ? policy.proxyPoolIds.slice(0, 1) : policy.proxyPoolIds })}
            options={[{ value: "none", label: "Off — fixed proxy" }, { value: "round-robin", label: "Round-robin — selected proxies only" }, { value: "random", label: "Random — selected proxies only" }]} />
          {policy.rotateStrategy === "none" ? (
            <Select label="Proxy" aria-label="Provider proxy" value={policy.proxyPoolIds[0] || ""} disabled={saving || loading}
              onChange={event => update({ proxyPoolIds: event.target.value ? [event.target.value] : [] })}
              options={[{ value: "", label: "Select a proxy" }, ...pools.map(pool => ({ value: pool.id, label: `${pool.name}${pool.isActive ? "" : " (inactive)"}` }))]} />
          ) : (
            <fieldset className="flex flex-col gap-2 max-h-56 overflow-y-auto">
              <legend className="text-sm font-medium mb-2">Allowed proxies (select at least two)</legend>
              {pools.map(pool => (
                <label key={pool.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" disabled={saving} checked={policy.proxyPoolIds.includes(pool.id)}
                    onChange={event => update({ proxyPoolIds: event.target.checked ? [...policy.proxyPoolIds, pool.id] : policy.proxyPoolIds.filter(id => id !== pool.id) })} />
                  {pool.name}{!pool.isActive && " (inactive)"}
                </label>
              ))}
            </fieldset>
          )}
          <p className="text-xs text-text-muted">If the selected proxy is unavailable, the request fails. There is no direct or environment-proxy fallback. New imports never join this selection.</p>
          {pools.length === 0 && <a href="/dashboard/proxy-pools" className="text-sm text-primary">Load and check proxies in Proxy Pools</a>}
        </div>
      )}
      <div className="flex items-center gap-3 mt-4">
        <Button size="sm" onClick={save} disabled={loading || saving}>{saving ? "Saving…" : "Save proxy settings"}</Button>
        {message && <span role="status" className="text-sm text-green-600">{message}</span>}
        {error && <span role="alert" className="text-sm text-red-500">{error}</span>}
      </div>
    </Card>
  );
}
