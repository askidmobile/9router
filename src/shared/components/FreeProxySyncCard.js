"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import Toggle from "./Toggle";

export default function FreeProxySyncCard({ onComplete }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/proxy-pools/free-sync", { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to load free proxy status");
    const data = await response.json();
    setStatus(data);
    return data;
  }, []);
  useEffect(() => { void Promise.resolve().then(load).catch(err => setError(err.message)); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => {
      load().then(data => { if (data.result?.completedAt && data.result.completedAt !== status?.result?.completedAt) onComplete(); }).catch(err => setError(err.message));
    }, status?.running ? 3000 : 15000);
    return () => clearInterval(timer);
  }, [status?.running, status?.result?.completedAt, load, onComplete]);

  const request = async (method, body) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/proxy-pools/free-sync", { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new Error("Failed to update free proxies");
      await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const result = status?.result;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="text-lg font-semibold">Free proxies</h2>
        <Button size="sm" icon="sync" disabled={busy || !status || status.running} onClick={() => request("POST")}>
          {status?.running ? "Downloading and checking…" : "Load and check now"}
        </Button>
      </div>
      <Toggle checked={status?.enabled === true} disabled={busy || !status} onChange={enabled => request("PATCH", { enabled })}
        label="Refresh Proxifly and IPLocate every 30 minutes" />
      <p className="text-xs text-text-muted mt-3">Only proxies passing HTTPS, certificate and exit-IP checks are imported. Enable and select them separately on each provider page. Account routes are not changed by imports.</p>
      {result && <p className="text-xs text-text-muted mt-3" role="status">Last sync: {new Date(result.completedAt).toLocaleString()} · Checked: {result.checked} · Working: {result.working} · Added: {result.added}</p>}
      {result && Object.entries(result.sources || {}).map(([source, data]) => (
        <p key={source} className={`text-xs mt-1 ${data.error ? "text-red-500" : "text-text-muted"}`}>{source}: {data.error || `${data.fetched} candidates`}</p>
      ))}
      {(error || result?.errors?.length > 0) && <p role="alert" className="text-sm text-red-500 mt-2">{error || result.errors.join("; ")}</p>}
    </Card>
  );
}
