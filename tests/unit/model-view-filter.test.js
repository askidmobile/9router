import { describe, expect, it } from "vitest";
import {
  STATUS_MATCHERS,
  filterModelGroups,
  filterProviderGroups,
  isRowActive,
} from "@/app/(dashboard)/dashboard/models/compare/filter.js";

const row = (overrides = {}) => ({
  key: "p|m",
  providerAlias: "p",
  id: "model-a",
  name: "Model A",
  alias: "",
  active: true,
  disabled: false,
  pricing: { input: 1, output: 2 },
  pricingSource: { fallbacks: {} },
  status: { state: "ok" },
  ...overrides,
});

const providerGroup = (overrides = {}) => ({
  key: "p",
  name: "Provider P",
  active: true,
  models: [row()],
  ...overrides,
});

describe("isRowActive", () => {
  it("requires a connected provider and an enabled model", () => {
    expect(isRowActive(row())).toBe(true);
    expect(isRowActive(row({ disabled: true }))).toBe(false);
    expect(isRowActive(row({ active: false }))).toBe(false);
  });
});

describe("filterProviderGroups", () => {
  it("hides disabled models in the Active scope", () => {
    const groups = [providerGroup({ models: [row(), row({ id: "off", disabled: true })] })];
    const visible = filterProviderGroups(groups, { scope: "active" });

    expect(visible[0].models.map((model) => model.id)).toEqual(["model-a"]);
  });

  it("keeps disabled models in the All scope", () => {
    const groups = [providerGroup({ models: [row(), row({ id: "off", disabled: true })] })];

    expect(filterProviderGroups(groups, { scope: "all" })[0].models).toHaveLength(2);
  });

  it("drops a provider whose models are all disabled in the Active scope", () => {
    const groups = [providerGroup({ models: [row({ disabled: true })] })];

    expect(filterProviderGroups(groups, { scope: "active" })).toEqual([]);
    expect(filterProviderGroups(groups, { scope: "all" })).toHaveLength(1);
  });

  it("drops unconnected providers in the Active scope", () => {
    const groups = [providerGroup({ active: false })];

    expect(filterProviderGroups(groups, { scope: "active" })).toEqual([]);
  });

  it("still searches by id, name and alias", () => {
    const groups = [providerGroup({
      models: [row({ id: "gpt-6", name: "GPT 6" }), row({ id: "glm-5", name: "GLM 5", alias: "fast" })],
    })];

    expect(filterProviderGroups(groups, { query: "glm" })[0].models).toHaveLength(1);
    expect(filterProviderGroups(groups, { query: "fast" })[0].models).toHaveLength(1);
    expect(filterProviderGroups(groups, { query: "nothing" })).toEqual([]);
  });
});

describe("filterModelGroups", () => {
  const modelGroup = (overrides = {}) => ({
    identity: "modela",
    name: "Model A",
    providers: [row(), row({ key: "q|m", providerAlias: "q" })],
    ...overrides,
  });

  it("hides disabled provider entries in the Active scope", () => {
    const groups = [modelGroup({
      providers: [row(), row({ key: "q|m", providerAlias: "q", disabled: true })],
    })];

    const visible = filterModelGroups(groups, { scope: "active" });
    expect(visible[0].providers.map((entry) => entry.providerAlias)).toEqual(["p"]);
  });

  it("hides entries from unconnected providers in the Active scope", () => {
    const groups = [modelGroup({
      providers: [row(), row({ key: "q|m", providerAlias: "q", active: false })],
    })];

    expect(filterModelGroups(groups, { scope: "active" })[0].providers).toHaveLength(1);
  });

  it("drops a model entirely when every entry is disabled", () => {
    const groups = [modelGroup({ providers: [row({ disabled: true })] })];

    expect(filterModelGroups(groups, { scope: "active" })).toEqual([]);
    expect(filterModelGroups(groups, { scope: "all" })).toHaveLength(1);
  });

  it("applies status filters on top of the scope", () => {
    const groups = [modelGroup({
      providers: [
        row(),
        row({ key: "q|m", providerAlias: "q", status: { state: "down" } }),
      ],
    })];

    const visible = filterModelGroups(groups, { scope: "active", statusFilter: "issues", statusMatchers: STATUS_MATCHERS });
    expect(visible[0].providers.map((entry) => entry.providerAlias)).toEqual(["q"]);
  });

  it("matches the group name even when no single row contains it", () => {
    const groups = [modelGroup({
      name: "DeepSeek V4.1 Flash 1017",
      providers: [row({ id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", name: "" })],
    })];

    expect(filterModelGroups(groups, { query: "v4.1 flash 1017" })).toHaveLength(1);
  });

  it("does not mutate the incoming groups", () => {
    const groups = [modelGroup({
      providers: [row(), row({ key: "q|m", providerAlias: "q", disabled: true })],
    })];

    filterModelGroups(groups, { scope: "active" });
    expect(groups[0].providers).toHaveLength(2);
  });
});