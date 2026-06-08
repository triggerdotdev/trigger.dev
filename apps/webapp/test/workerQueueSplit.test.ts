import { describe, expect, it } from "vitest";
import {
  resolveScheduledQueueSplitEnabled,
  workerQueueForRun,
  workerQueueForClass,
  SCHEDULED_WORKER_QUEUE_SUFFIX,
} from "~/runEngine/concerns/workerQueueSplit.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";

const FLAG = FEATURE_FLAG.workerQueueScheduledSplitEnabled;

describe("resolveScheduledQueueSplitEnabled", () => {
  it("falls back to the global default when the org has no override", () => {
    expect(resolveScheduledQueueSplitEnabled({ orgFeatureFlags: null, globalDefault: false })).toBe(
      false
    );
    expect(
      resolveScheduledQueueSplitEnabled({ orgFeatureFlags: undefined, globalDefault: true })
    ).toBe(true);
    expect(resolveScheduledQueueSplitEnabled({ orgFeatureFlags: {}, globalDefault: true })).toBe(
      true
    );
  });

  it("per-org true overrides a global default of false (beta opt-in)", () => {
    expect(
      resolveScheduledQueueSplitEnabled({
        orgFeatureFlags: { [FLAG]: true },
        globalDefault: false,
      })
    ).toBe(true);
  });

  it("per-org false overrides a global default of true (escape hatch)", () => {
    expect(
      resolveScheduledQueueSplitEnabled({
        orgFeatureFlags: { [FLAG]: false },
        globalDefault: true,
      })
    ).toBe(false);
  });

  it("ignores unrelated org flags", () => {
    expect(
      resolveScheduledQueueSplitEnabled({
        orgFeatureFlags: { somethingElse: true },
        globalDefault: false,
      })
    ).toBe(false);
  });

  it("coerces a present override to boolean (z.coerce.boolean semantics)", () => {
    // The catalog type is z.coerce.boolean(), matching the mollifier flag, so any
    // present value is coerced rather than rejected. The admin routes validate
    // against the same catalog on write, so stored values are real JSON booleans;
    // this just documents that a present override always wins over the default.
    expect(
      resolveScheduledQueueSplitEnabled({
        orgFeatureFlags: { [FLAG]: 0 as unknown as boolean },
        globalDefault: true,
      })
    ).toBe(false);
  });
});

describe("workerQueueForRun", () => {
  const region = "us-nyc-3";
  const scheduled = `${region}${SCHEDULED_WORKER_QUEUE_SUFFIX}`;

  it("suffixes scheduled-lineage runs when the split is enabled", () => {
    expect(
      workerQueueForRun({ workerQueue: region, rootTriggerSource: "schedule", splitEnabled: true })
    ).toBe(scheduled);
  });

  it("leaves standard/agent runs on the base queue", () => {
    for (const rootTriggerSource of ["api", "sdk", "dashboard", "cli", "mcp", undefined]) {
      expect(
        workerQueueForRun({ workerQueue: region, rootTriggerSource, splitEnabled: true })
      ).toBe(region);
    }
  });

  it("never suffixes when the split is disabled, even for scheduled runs", () => {
    expect(
      workerQueueForRun({ workerQueue: region, rootTriggerSource: "schedule", splitEnabled: false })
    ).toBe(region);
  });

  it("is idempotent — does not double-suffix an already-scheduled queue", () => {
    expect(
      workerQueueForRun({
        workerQueue: scheduled,
        rootTriggerSource: "schedule",
        splitEnabled: true,
      })
    ).toBe(scheduled);
  });
});

describe("workerQueueForClass", () => {
  const region = "us-nyc-3";
  const scheduled = `${region}${SCHEDULED_WORKER_QUEUE_SUFFIX}`;

  it("returns the base queue for the default class or no class", () => {
    expect(workerQueueForClass(region, "default")).toBe(region);
    expect(workerQueueForClass(region, undefined)).toBe(region);
  });

  it("returns the suffixed queue for the scheduled class", () => {
    expect(workerQueueForClass(region, "scheduled")).toBe(scheduled);
  });

  it("is idempotent — does not double-suffix", () => {
    expect(workerQueueForClass(scheduled, "scheduled")).toBe(scheduled);
  });

  it("round-trips with workerQueueForRun: a scheduled run lands on the queue its class targets", () => {
    const enqueued = workerQueueForRun({
      workerQueue: region,
      rootTriggerSource: "schedule",
      splitEnabled: true,
    });
    expect(workerQueueForClass(region, "scheduled")).toBe(enqueued);
  });
});
