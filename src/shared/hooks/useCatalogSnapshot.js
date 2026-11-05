"use client";

// Stale-while-revalidate for the models catalog.
//
// The page used to fire eight requests and show a skeleton until the last one
// landed. Now there is one cheap request, and the previously rendered snapshot
// is drawn immediately from localStorage (bounded in size, so a huge catalog
// cannot exhaust the quota) while the fresh copy loads in the background.

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "9router.models.catalog.v1";
const MAX_PERSIST_BYTES = 3 * 1024 * 1024;

function readStored() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.models ? parsed : null;
  } catch {
    return null;
  }
}

function writeStored(snapshot) {
  try {
    const raw = JSON.stringify(snapshot);
    // localStorage is a shared 5 MB budget; a pathological catalog is not worth
    // evicting everything else, so oversized snapshots stay memory-only.
    if (raw.length > MAX_PERSIST_BYTES) return;
    globalThis.localStorage?.setItem(STORAGE_KEY, raw);
  } catch {
    // Quota exceeded or storage disabled — caching is an optimisation only.
  }
}

export function useCatalogSnapshot() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [revalidating, setRevalidating] = useState(false);
  const [error, setError] = useState(null);
  const [fromCache, setFromCache] = useState(false);
  const inflight = useRef(null);

  useEffect(() => {
    const stored = readStored();
    if (stored) {
      setData(stored);
      setFromCache(true);
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current;
    setRevalidating(true);
    const run = (async () => {
      try {
        const res = await fetch("/api/models/catalog", { cache: "no-store" });
        if (!res.ok) throw new Error(`catalog responded ${res.status}`);
        const json = await res.json();
        if (json?.error) throw new Error(json.error);
        setData(json);
        setFromCache(false);
        setError(null);
        writeStored(json);
        return json;
      } catch (err) {
        // Keep whatever is on screen: a failed revalidation must not blank the
        // page, it only marks the snapshot as stale.
        setError(err?.message || "Failed to load the model catalog");
        return null;
      } finally {
        setLoading(false);
        setRevalidating(false);
        inflight.current = null;
      }
    })();
    inflight.current = run;
    return run;
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, revalidating, error, fromCache, refresh };
}