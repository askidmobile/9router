import { makeKv } from "./db/helpers/kvStore.js";

const snapshots = makeKv("providerQuota");

export async function saveQuotaSnapshot(provider, connectionId, model, quotas) {
  const observedAt = new Date().toISOString();
  await snapshots.updateMany([connectionId], current => ({
    provider,
    models: { ...(current?.provider === provider ? current.models : {}), [model]: { observedAt, quotas } },
  }));
}

export const getQuotaSnapshot = (connectionId) => snapshots.get(connectionId);
