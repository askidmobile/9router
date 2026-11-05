import { describe, expect, it } from "vitest";
import { MIN_SAMPLES, deriveModelStatus } from "@/shared/utils/modelStatus";

const summary = (overrides = {}) => ({
  requests: 100,
  ok: 99,
  err: 1,
  errorRate: 0.01,
  avgLatency: 120,
  rateLimited: 0,
  serverErrors: 0,
  timeouts: 0,
  authErrors: 0,
  lastError: null,
  lastErrorAt: null,
  ...overrides,
});

describe("deriveModelStatus", () => {
  it("reports operational for clean traffic", () => {
    expect(deriveModelStatus({ summary: summary(), recent: summary({ rateLimited: 0 }) }).state).toBe("ok");
  });

  it("reports unknown below the sample floor", () => {
    const status = deriveModelStatus({ summary: summary({ requests: MIN_SAMPLES - 1, errorRate: 1 }) });
    expect(status.state).toBe("unknown");
  });

  it("reports degraded at a 10% error rate", () => {
    expect(deriveModelStatus({ summary: summary({ err: 10, errorRate: 0.1 }) }).state).toBe("degraded");
  });

  it("reports down at a 50% error rate", () => {
    expect(deriveModelStatus({ summary: summary({ err: 50, errorRate: 0.5 }) }).state).toBe("down");
  });

  it("treats a recent 429 as degraded even with a healthy day", () => {
    const status = deriveModelStatus({
      summary: summary({ errorRate: 0.01 }),
      recent: summary({ requests: 10, err: 2, errorRate: 0.2, rateLimited: 2 }),
    });
    expect(status.state).toBe("degraded");
  });

  it("lets a live lock override telemetry", () => {
    const status = deriveModelStatus({
      summary: summary({ errorRate: 0 }),
      lock: { state: "cooldown", until: "2026-11-06T12:00:00.000Z" },
    });
    expect(status.state).toBe("cooldown");
  });

  it("treats an account-wide block as down", () => {
    const status = deriveModelStatus({ summary: summary({ errorRate: 0 }), lock: { state: "unavailable" } });
    expect(status.state).toBe("down");
  });

  it("carries the UI metadata for each state", () => {
    const status = deriveModelStatus({ summary: summary() });
    expect(status.label).toBe("Operational");
    expect(status.icon).toBe("check_circle");
    expect(status.tone).toBe("success");
  });
});