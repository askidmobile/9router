import { describe, expect, it } from "vitest";
import {
  groupLabel,
  idTail,
  modelGroupKey,
  normalizeDisplayName,
} from "@/lib/modelCatalog/grouping.js";

const row = (overrides) => ({ id: "x", name: "x", ...overrides });

describe("normalizeDisplayName", () => {
  it("ignores case, spaces and separators", () => {
    expect(normalizeDisplayName("DeepSeek-V4.1 Flash")).toBe("deepseekv41flash");
    expect(normalizeDisplayName("deepseek v4.1 flash")).toBe("deepseekv41flash");
  });

  it("keeps a plus sign, because Command R+ is not Command R", () => {
    expect(normalizeDisplayName("Command R+")).not.toBe(normalizeDisplayName("Command R"));
  });
});

describe("idTail", () => {
  it("drops the vendor namespace", () => {
    expect(idTail("deepseek-ai/DeepSeek-V4.1-Flash")).toBe("DeepSeek-V4.1-Flash");
    expect(idTail("deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash");
  });
});

describe("modelGroupKey", () => {
  it("merges different id shapes that carry the same display name", () => {
    const keys = [
      modelGroupKey(row({ id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", name: "DeepSeek V4.1 Flash 1017" })),
      modelGroupKey(row({ id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017" })),
      modelGroupKey(row({ id: "deepseek-v4.1-flash-1017", name: "DeepSeek-V4.1-Flash-1017" })),
    ];

    expect(new Set(keys).size).toBe(1);
  });

  it("strips channel markers but keeps product qualifiers", () => {
    expect(modelGroupKey(row({ name: "DeepSeek V4.1 Flash (Free)" })))
      .toBe(modelGroupKey(row({ name: "DeepSeek V4.1 Flash" })));
    expect(modelGroupKey(row({ name: "DeepSeek V4.1 Flash (Azure via Respan)" })))
      .toBe(modelGroupKey(row({ name: "DeepSeek V4.1 Flash" })));

    expect(modelGroupKey(row({ name: "the model 4.8 (Fast)" })))
      .not.toBe(modelGroupKey(row({ name: "the model 4.8" })));
    expect(modelGroupKey(row({ name: "the model 5.5 (Thinking)" })))
      .not.toBe(modelGroupKey(row({ name: "the model 5.5" })));
  });

  it("does not merge a dated variant into the base model", () => {
    expect(modelGroupKey(row({ name: "DeepSeek V4.1 Flash 1017" })))
      .not.toBe(modelGroupKey(row({ name: "DeepSeek V4.1 Flash" })));
  });

  it("falls back to the id when a model has no usable name", () => {
    expect(modelGroupKey(row({ id: "vendor/some-model", name: "" }))).toBe("somemodel");
    expect(modelGroupKey(row({ id: "vendor/some-model", name: "A" }))).toBe("somemodel");
  });

  it("keeps models without a name or a usable id separate", () => {
    const a = modelGroupKey(row({ id: "a/", name: "", key: "p|a" }));
    const b = modelGroupKey(row({ id: "b/", name: "", key: "p|b" }));
    expect(a).not.toBe(b);
  });
});

describe("groupLabel", () => {
  it("prefers the spelling most providers agree on", () => {
    const label = groupLabel([
      row({ name: "DeepSeek V4.1 Flash" }),
      row({ name: "DeepSeek V4.1 Flash" }),
      row({ name: "DeepSeek-V4.1-Flash" }),
    ]);

    expect(label).toBe("DeepSeek V4.1 Flash");
  });

  it("drops the channel marker when it is the only difference", () => {
    expect(groupLabel([row({ name: "Agnes 2.5 Flash (Free)" }), row({ name: "Agnes 2.5 Flash" })]))
      .toBe("Agnes 2.5 Flash");
  });
});