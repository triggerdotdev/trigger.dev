import { describe, expect, it } from "vitest";
import type {
  WeightedWorkerQueueSubscription,
  WorkerQueueSubscription,
} from "@trigger.dev/core/v3/workers";
import {
  consumerRuntime,
  templateFallbackFor,
} from "~/runEngine/concerns/workerQueueDequeue.server";
import { createWorkerQueueConsumer } from "~/runEngine/concerns/workerQueueSubscriptions.server";
import type { WorkerGroupRegionRow } from "~/v3/workerRegions.server";

const group = (row: Partial<WorkerGroupRegionRow>): WorkerGroupRegionRow => ({
  id: "wg_us-east-1",
  masterQueue: "us-east-1",
  region: "us-east-1",
  workloadType: "CONTAINER",
  type: "MANAGED",
  projectId: null,
  hidden: false,
  enableFastPath: false,
  ...row,
});

const groups = () => [
  group({}),
  group({ masterQueue: "us-east-1-mvm", workloadType: "MICROVM", hidden: true }),
];

const lane = (
  compat: WeightedWorkerQueueSubscription["compat"]
): WeightedWorkerQueueSubscription => ({
  class: "ondemand",
  phase: "fresh",
  compat,
  channel: "canary",
  weight: 1,
});

const worker = (workloadType: "CONTAINER" | "MICROVM") => ({
  workerGroupId: "wg_test",
  workloadType,
});

const consumer = (
  workloadType: "CONTAINER" | "MICROVM",
  allowedSubscriptions: WorkerQueueSubscription[] = [],
  mixedRuntime = false
) =>
  createWorkerQueueConsumer({
    ...worker(workloadType),
    workerInstanceId: "instance",
    masterQueue: "us-east-1-mvm",
    region: "us-east-1",
    allowedSubscriptions,
    mixedRuntime,
  });

describe("consumer runtime", () => {
  it("comes from the runtime lane a consumer asks for, whatever its group is", () => {
    for (const workloadType of ["CONTAINER", "MICROVM"] as const) {
      expect(consumerRuntime(worker(workloadType), [lane("compute")])).toBe("compute");
      expect(consumerRuntime(worker(workloadType), [lane("container")])).toBe("container");
      expect(consumerRuntime(worker(workloadType), [lane("compute"), lane("any")])).toBe("compute");
      expect(consumerRuntime(worker(workloadType), [lane("container"), lane("any")])).toBe(
        "container"
      );
    }
  });

  it("refuses a consumer that asks for both runtimes", () => {
    expect(() =>
      consumerRuntime(worker("CONTAINER"), [lane("container"), lane("compute")])
    ).toThrow(/serves one runtime/);
  });

  it("follows the group's workloadType for any-only and legacy consumers", () => {
    expect(consumerRuntime(worker("CONTAINER"), [lane("any")])).toBe("container");
    expect(consumerRuntime(worker("MICROVM"), [lane("any")])).toBe("compute");
    expect(consumerRuntime(worker("CONTAINER"), undefined)).toBe("container");
    expect(consumerRuntime(worker("MICROVM"), undefined)).toBe("compute");
  });
});

describe("template fallback per consumer", () => {
  it("gives a compute consumer the fallback and a container consumer none", () => {
    const fallback = templateFallbackFor(consumer("CONTAINER"), "compute", groups);
    expect(fallback?.("us-east-1:v2:ondemand:fresh:compute:canary")).toBe(
      "us-east-1:v2:ondemand:fresh:container:stable"
    );
    expect(fallback?.("us-east-1:v2:ondemand:fresh:any:canary")).toBe(
      "us-east-1:v2:ondemand:fresh:container:stable"
    );
    expect(fallback?.("us-east-1-mvm")).toBe("us-east-1");
    expect(templateFallbackFor(consumer("CONTAINER"), "container", groups)).toBeUndefined();
  });

  it("uses the consumer's own container lane when its group is the region's only group", () => {
    const sole = () => [group({ masterQueue: "us-east-1-mvm", workloadType: "MICROVM" })];
    const containerStable: WorkerQueueSubscription = {
      class: "ondemand",
      phase: "fresh",
      compat: "container",
      channel: "stable",
    };
    const computeCanary: WorkerQueueSubscription = {
      ...containerStable,
      compat: "compute",
      channel: "canary",
    };

    const mixed = templateFallbackFor(
      consumer("MICROVM", [containerStable, computeCanary], true),
      "compute",
      sole
    );
    expect(mixed?.("us-east-1:v2:ondemand:fresh:compute:canary")).toBe(
      "us-east-1:v2:ondemand:fresh:container:stable"
    );
    expect(mixed?.("us-east-1:v2:ondemand:restore:compute:canary")).toBeUndefined();

    // A MICROVM group that is not marked mixed has its container lanes refused.
    const notMixed = templateFallbackFor(
      consumer("MICROVM", [containerStable, computeCanary]),
      "compute",
      sole
    );
    expect(notMixed?.("us-east-1:v2:ondemand:fresh:compute:canary")).toBeUndefined();
  });
});
