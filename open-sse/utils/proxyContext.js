import { AsyncLocalStorage } from "node:async_hooks";

const context = globalThis.__nineRouterProxyContext ||= new AsyncLocalStorage();

export function getProxyContext() {
  return context.getStore();
}

export function withProxyContext(config, callback) {
  if (!config) return callback();
  // Load the fetch bridge for adapters that otherwise only use global fetch.
  return import("./proxyFetch.js").then(() => context.run(config, callback));
}
