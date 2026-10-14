export const ACCOUNT_QUOTA_URLS = {
  apinex: "https://api.apinex.bond/v1/balance",
  requesty: "https://api-v2.requesty.ai/v1/manage/apikey/self",
  cheaper: "https://api.cheaperinference.com/v1/account/balance",
  kilocode: "https://api.kilo.ai/api/profile/balance",
  "jina-ai": "https://dash.jina.ai/api/v1/api_key/fe_user",
  "jina-reader": "https://dash.jina.ai/api/v1/api_key/fe_user",
  kenari: "https://kenari.id/v1/account/balance",
};
export const KENARI_QUOTA_URL = "https://kenari.id/v1/account/quota";
export const CUSTOM_QUOTA_ORIGINS = { "https://kenari.id": "kenari" };
export const HEADER_QUOTA_PROVIDERS = ["groq", "brave-search", "nebius", "anthropic", "cerebras"];
export const QUOTA_SNAPSHOT_MAX_AGE_MS = 86400000;
