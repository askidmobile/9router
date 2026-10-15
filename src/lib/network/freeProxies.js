import { isIP } from "node:net";
import { ProxyAgent, fetch as directFetch } from "undici";
import { getProxyPools, createProxyPool, updateProxyPool, pruneUnusedFreeProxies } from "../db/repos/proxyPoolsRepo.js";
import { getSettings, updateSettings } from "../db/repos/settingsRepo.js";

export const FREE_PROXY_INTERVAL_MS = 30 * 60 * 1000;
const SOURCE_LIMIT = 20;
const POOL_LIMIT = 40;
const TEST_URL = "https://api64.ipify.org?format=json";
const MANAGED_BY = "free-proxy-sync";
const state = globalThis.__nineRouterFreeProxySync ||= { running: false, timer: null, result: null };

// Only literal public IPv4 endpoints are imported; DNS names and IPv6 need a pinned-address guard first.
export function isPublicProxyIp(host) {
  if (typeof host !== "string" || isIP(host) !== 4) return false;
  const [a, b, c] = host.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

export function parseFreeProxies(source, payload, protocol = "http") {
  const rows = source === "iplocate"
    ? String(payload).split(/\r?\n/).map(line => {
      const [ip, port] = line.trim().split(":");
      return { ip, port, protocol };
    })
    : Array.isArray(payload) ? payload : Array.isArray(payload?.proxies) ? payload.proxies : [payload];
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const port = Number(row?.port);
    const scheme = row?.protocol?.toLowerCase();
    if (!isPublicProxyIp(row?.ip) || !Number.isInteger(port) || port < 1 || port > 65535
      || !["http", "https"].includes(scheme)) continue;
    const proxyUrl = `${scheme}://${row.ip}:${port}`;
    if (seen.has(proxyUrl)) continue;
    seen.add(proxyUrl);
    result.push({ source, proxyUrl });
  }
  return result;
}

async function readLimited(response, maxBytes = 1024 * 1024) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error("Response exceeds size limit");
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    await response.body.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchFreeProxySource(source) {
  if (source === "proxifly") {
    const response = await directFetch("https://api.proxifly.dev/proxy?format=json&quantity=20&protocol=http&https=true&anonymity=elite", {
      signal: AbortSignal.timeout(15000), redirect: "error",
    });
    return parseFreeProxies(source, JSON.parse(await readLimited(response))).slice(0, SOURCE_LIMIT);
  }
  const response = await directFetch("https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt", {
    signal: AbortSignal.timeout(15000), redirect: "error",
  });
  const candidates = parseFreeProxies(source, await readLimited(response));
  // Sample across the list so a broken prefix does not starve discovery every cycle.
  for (let i = 0; i < Math.min(SOURCE_LIMIT, candidates.length); i++) {
    const j = i + Math.floor(Math.random() * (candidates.length - i));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, SOURCE_LIMIT);
}

export async function testFreeProxy(proxyUrl, directIp) {
  let dispatcher;
  const startedAt = Date.now();
  try {
    const url = new URL(proxyUrl);
    if (!isPublicProxyIp(url.hostname) || !["http:", "https:"].includes(url.protocol)
      || url.username || url.password) throw new Error("Invalid public proxy endpoint");
    directIp ||= await getDirectExitIp();
    dispatcher = new ProxyAgent({ uri: url.href, requestTls: { rejectUnauthorized: true }, proxyTls: { rejectUnauthorized: true } });
    const response = await directFetch(TEST_URL, {
      dispatcher, signal: AbortSignal.timeout(5000), redirect: "error",
    });
    const { ip } = JSON.parse(await readLimited(response, 1024));
    if (isIP(ip) === 0 || ip === directIp) throw new Error("Proxy does not provide a different exit IP");
    return { ok: true, exitIp: ip, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: error.name === "TimeoutError" ? "Proxy test timed out" : "Proxy HTTPS/exit-IP test failed" };
  } finally {
    await dispatcher?.destroy().catch(() => {});
  }
}

async function getDirectExitIp() {
  const response = await directFetch(TEST_URL, { signal: AbortSignal.timeout(8000), redirect: "error" });
  const { ip } = JSON.parse(await readLimited(response, 1024));
  if (!isIP(ip)) throw new Error("Cannot determine direct exit IP");
  return ip;
}

export function getFreeProxySyncState() {
  return { running: state.running, result: state.result, intervalMs: FREE_PROXY_INTERVAL_MS };
}

export async function syncFreeProxies() {
  if (state.running) return;
  state.running = true;
  const result = { startedAt: new Date().toISOString(), added: 0, checked: 0, working: 0, sources: {}, errors: [] };
  try {
    await pruneUnusedFreeProxies();
    const pools = await getProxyPools();
    const existing = new Map(pools.map(pool => [pool.proxyUrl, pool]));
    const candidates = new Map(pools.filter(pool => pool.managedBy === MANAGED_BY)
      .slice(0, POOL_LIMIT).map(pool => [pool.proxyUrl, { source: pool.source, proxyUrl: pool.proxyUrl }]));
    const sources = ["proxifly", "iplocate"];
    const fetched = await Promise.allSettled(sources.map(fetchFreeProxySource));
    fetched.forEach((entry, index) => {
      const source = sources[index];
      if (entry.status === "rejected") {
        result.sources[source] = { fetched: 0, error: entry.reason?.message || "Source fetch failed" };
        return;
      }
      result.sources[source] = { fetched: entry.value.length };
      for (const item of entry.value) if (!existing.has(item.proxyUrl) || existing.get(item.proxyUrl).managedBy === MANAGED_BY) candidates.set(item.proxyUrl, item);
    });
    const directIp = await getDirectExitIp();
    const list = [...candidates.values()];
    let managedCount = pools.filter(pool => pool.managedBy === MANAGED_BY).length;
    for (let i = 0; i < list.length; i += 8) {
      const batch = await Promise.all(list.slice(i, i + 8).map(async item => ({ item, test: await testFreeProxy(item.proxyUrl, directIp) })));
      for (const { item, test } of batch) {
        result.checked++;
        if (test.ok) result.working++;
        const pool = existing.get(item.proxyUrl);
        const health = {
          testStatus: test.ok ? "active" : "error", lastTestedAt: new Date().toISOString(),
          lastError: test.ok ? null : test.error, latencyMs: test.ok ? test.elapsedMs : null,
          exitIp: test.ok ? test.exitIp : null,
        };
        if (pool) {
          await updateProxyPool(pool.id, {
            ...health, strictProxy: true,
            isActive: test.ok && (pool.isActive || pool.autoDisabled === true),
            autoDisabled: !test.ok && (pool.isActive || pool.autoDisabled === true),
          });
        } else if (test.ok && managedCount < POOL_LIMIT) {
          await createProxyPool({
            name: `[${item.source}] ${item.proxyUrl}`, ...item, ...health,
            type: "http", strictProxy: true, managedBy: MANAGED_BY,
          });
          result.added++;
          managedCount++;
        }
      }
    }
  } catch (error) {
    result.errors.push(error?.message || "Proxy sync failed");
  } finally {
    result.completedAt = new Date().toISOString();
    state.result = result;
    try { await updateSettings({ freeProxyLastSync: result }); }
    finally { state.running = false; }
  }
  return result;
}

export function startFreeProxySync() {
  if (state.timer || process.env.NEXT_PHASE === "phase-production-build" || process.env.FREE_PROXY_SYNC === "off") return;
  const schedule = delay => {
    state.timer = setTimeout(async () => {
      try {
        if ((await getSettings()).freeProxyAutoSync !== false) await syncFreeProxies();
      } catch (error) { console.warn("[FreeProxySync]", error.message); }
      schedule(FREE_PROXY_INTERVAL_MS);
    }, delay);
    state.timer.unref?.();
  };
  schedule(30000);
}
