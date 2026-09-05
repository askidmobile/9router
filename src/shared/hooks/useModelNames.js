"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { modelNameKey, resolveModelName } from "@/shared/utils/modelNames";

const EMPTY = {};
let cache = EMPTY;
let loaded = false;
let inflight = null;
let revision = 0;
const listeners = new Set();
const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
const snapshot = () => cache;
const serverSnapshot = () => EMPTY;

function loadNames() {
  if (loaded) return Promise.resolve(cache);
  if (inflight) return inflight;
  const currentRevision = revision;
  const request = fetch("/api/models/names")
    .then(async (res) => {
      if (!res.ok) throw new Error("Failed to fetch display names");
      return res.json();
    })
    .then((data) => {
      if (currentRevision === revision) {
        cache = data.overrides || EMPTY;
        loaded = true;
        listeners.forEach((listener) => listener());
      }
      return cache;
    })
    .catch(() => cache)
    .finally(() => { if (inflight === request) inflight = null; });
  inflight = request;
  return request;
}

export async function saveModelName({ providerAlias, id, name, defaultName }) {
  const nextName = name.trim();
  const res = await fetch("/api/models/names", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: providerAlias, model: id, name: nextName === defaultName ? "" : nextName }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to save display name");
  }
  revision += 1;
  const next = { ...cache };
  const key = modelNameKey(providerAlias, id);
  if (nextName && nextName !== defaultName) next[key] = nextName;
  else delete next[key];
  cache = next;
  listeners.forEach((listener) => listener());
  loaded = false;
  inflight = null;
  await loadNames();
}

export function useModelNames() {
  const overrides = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useEffect(() => { loadNames(); }, []);
  const getName = useCallback(
    (provider, model, fallback) => resolveModelName(overrides, provider, model, fallback),
    [overrides],
  );
  return { overrides, getName };
}
