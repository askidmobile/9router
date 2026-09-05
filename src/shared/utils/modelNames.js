import { getProviderAlias } from "@/shared/constants/providers";

export function modelNameKey(provider, model) {
  return `${getProviderAlias(provider)}|${model}`;
}

export function resolveModelName(overrides, provider, model, fallback) {
  return overrides?.[modelNameKey(provider, model)] || overrides?.[`${provider}|${model}`] || fallback || model;
}
