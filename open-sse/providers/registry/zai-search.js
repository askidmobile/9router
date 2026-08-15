export default {
  id: "zai-search",
  alias: "zai-search",
  display: {
    name: "Z.AI Coding Search",
    icon: "bolt",
    color: "#6366f1",
    textIcon: "ZAI",
    website: "https://z.ai",
    notice: {
      text: "Web search via the Z.AI Coding plan MCP endpoint. Reuses the API key from the `zai` chat provider.",
      apiKeyUrl: "https://z.ai",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  serviceKinds: ["webSearch"],
  // Credential fallback: reuses the Z.AI Coding plan API key registered under
  // the `zai` chat provider — one key, chat + search.
  credentialFallback: "zai",
  searchConfig: {
    baseUrl: "https://api.z.ai/api/mcp/web_search_prime/mcp",
    method: "POST",
    authType: "apikey",
    authHeader: "bearer",
    costPerQuery: 0,
    freeMonthlyQuota: 0,
    searchTypes: ["web"],
    defaultMaxResults: 5,
    maxMaxResults: 50,
    timeoutMs: 10000,
    cacheTTLMs: 300000,
  },
};
