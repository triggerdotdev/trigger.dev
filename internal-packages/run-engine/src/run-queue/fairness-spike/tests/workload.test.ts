import { describe, it, expect } from "vitest";
import { buildWorkload, expandEvents, type WorkloadConfig } from "../harness/workload.js";
import { groupIdFromQueueName } from "../types.js";

const cfg: WorkloadConfig = {
  seed: "spike-test",
  envConcurrencyLimit: 5,
  tenants: [
    { tenantId: "a", runCount: 6, queueCount: 3, arrival: "immediate" },
    { tenantId: "b", runCount: 3, arrival: "poisson", ratePerSec: 50, holdMsMean: 20 },
  ],
};

describe("workload generator", () => {
  it("is deterministic for a given seed", () => {
    const a = expandEvents(buildWorkload(cfg));
    const b = expandEvents(buildWorkload(cfg));
    expect(a).toEqual(b);
  });

  it("produces one event per run", () => {
    const events = expandEvents(buildWorkload(cfg));
    expect(events).toHaveLength(9);
  });

  it("spreads a tenant's runs across its queueCount queues", () => {
    const events = expandEvents(buildWorkload(cfg)).filter((e) => e.groupId === "a");
    const distinctQueues = new Set(events.map((e) => e.queueName));
    expect(distinctQueues.size).toBe(3);
    expect(events.every((e) => groupIdFromQueueName(e.queueName) === "a")).toBe(true);
  });

  it("immediate arrivals all enqueue at startAt", () => {
    const events = expandEvents(buildWorkload(cfg)).filter((e) => e.groupId === "a");
    expect(events.every((e) => e.enqueueAtMs === 0)).toBe(true);
  });

  it("poisson arrivals are non-decreasing in time", () => {
    const events = expandEvents(buildWorkload(cfg)).filter((e) => e.groupId === "b");
    for (let i = 1; i < events.length; i++) {
      expect(events[i].enqueueAtMs).toBeGreaterThanOrEqual(events[i - 1].enqueueAtMs);
    }
  });

  it("assigns a positive hold to every run", () => {
    const events = expandEvents(buildWorkload(cfg));
    expect(events.every((e) => e.holdMs >= 1)).toBe(true);
  });
});
