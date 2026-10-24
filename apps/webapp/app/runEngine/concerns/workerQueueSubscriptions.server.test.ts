import type { WorkerQueueSubscription } from "@trigger.dev/core/v3/workers";
import { describe, expect, it } from "vitest";
import {
  createWorkerQueueConsumer,
  refusedSubscriptions,
  resolveWorkerQueueSubscriptions,
  WorkerQueueSubscriptionPolicyEnv,
  workerServesQueue,
  type WorkerQueueConsumerOptions,
} from "~/runEngine/concerns/workerQueueSubscriptions.server";
import { ServiceValidationError } from "~/v3/services/common.server";

const stable: WorkerQueueSubscription = {
  class: "ondemand",
  phase: "fresh",
  compat: "container",
  channel: "stable",
};
const canary: WorkerQueueSubscription = { ...stable, channel: "canary" };
const restore: WorkerQueueSubscription = { ...stable, phase: "restore" };

const worker: WorkerQueueConsumerOptions = {
  workerGroupId: "group-container",
  workerInstanceId: "instance-container",
  masterQueue: "legacy-container-group",
  region: "us-east-1",
  workloadType: "CONTAINER",
  allowedSubscriptions: [],
};

describe("worker queue subscription authorization", () => {
  it("derives the geographic region, weights requests and deduplicates exact lanes", () => {
    const consumer = createWorkerQueueConsumer({
      ...worker,
      allowedSubscriptions: [stable, canary, restore],
    });
    expect(
      resolveWorkerQueueSubscriptions(consumer, [
        stable,
        { ...canary, weight: 0.25 },
        stable,
        restore,
      ])
    ).toEqual([
      { queue: "us-east-1:v2:ondemand:fresh:container:stable", weight: 1 },
      { queue: "us-east-1:v2:ondemand:fresh:container:canary", weight: 0.25 },
      { queue: "us-east-1:v2:ondemand:restore:container:stable", weight: 1 },
    ]);
    expect(resolveWorkerQueueSubscriptions(consumer, [{ ...canary, weight: 0.75 }])).toEqual([
      { queue: "us-east-1:v2:ondemand:fresh:container:canary", weight: 0.75 },
    ]);
  });

  it("denies unconfigured groups and rejects a mixed authorized/unauthorized request", () => {
    for (const allowedSubscriptions of [[], [stable]]) {
      const consumer = createWorkerQueueConsumer({ ...worker, allowedSubscriptions });
      try {
        resolveWorkerQueueSubscriptions(consumer, [stable, canary]);
        expect.fail("Unauthorized subscriptions must be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceValidationError);
        expect((error as ServiceValidationError).status).toBe(403);
      }
    }
  });

  it("lets a group's allowlist mix runtimes whatever the group's workloadType", () => {
    const compute: WorkerQueueSubscription = { ...restore, compat: "compute" };
    const mixed = { ...worker, allowedSubscriptions: [stable, compute], mixedRuntime: true };
    for (const workloadType of ["CONTAINER", "MICROVM"] as const) {
      const consumer = createWorkerQueueConsumer({ ...mixed, workloadType });
      expect(resolveWorkerQueueSubscriptions(consumer, [compute])).toEqual([
        { queue: "us-east-1:v2:ondemand:restore:compute:stable", weight: 1 },
      ]);
      expect(resolveWorkerQueueSubscriptions(consumer, [stable])).toEqual([
        { queue: "us-east-1:v2:ondemand:fresh:container:stable", weight: 1 },
      ]);
    }
  });

  it("refuses container lanes to a MICROVM group that is not marked mixed", () => {
    const compute: WorkerQueueSubscription = { ...restore, compat: "compute" };
    const options = {
      ...worker,
      workloadType: "MICROVM" as const,
      allowedSubscriptions: [stable, compute],
    };
    expect(refusedSubscriptions(options)).toEqual([stable]);
    expect(refusedSubscriptions({ ...options, mixedRuntime: true })).toEqual([]);
    expect(refusedSubscriptions({ ...options, workloadType: "CONTAINER" })).toEqual([]);

    const consumer = createWorkerQueueConsumer(options);
    expect(resolveWorkerQueueSubscriptions(consumer, [compute])).toEqual([
      { queue: "us-east-1:v2:ondemand:restore:compute:stable", weight: 1 },
    ]);
    try {
      resolveWorkerQueueSubscriptions(consumer, [stable]);
      expect.fail("A MICROVM group that is not mixed must not take container lanes");
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceValidationError);
      expect((error as ServiceValidationError).status).toBe(403);
    }
  });

  it("keeps a container-only group off compute lanes its allowlist doesn't name", () => {
    const compute: WorkerQueueSubscription = { ...stable, compat: "compute" };
    const consumer = createWorkerQueueConsumer({ ...worker, allowedSubscriptions: [stable] });
    expect(() => resolveWorkerQueueSubscriptions(consumer, [compute])).toThrow("not authorized");
    expect(() => resolveWorkerQueueSubscriptions(consumer, [stable, compute])).toThrow(
      "not authorized"
    );
  });

  it("treats any as a literal cold-start lane, not permission for concrete lanes", () => {
    const any: WorkerQueueSubscription = { ...stable, compat: "any" };
    const consumer = createWorkerQueueConsumer({
      ...worker,
      region: null,
      masterQueue: "us-east-1",
      allowedSubscriptions: [any],
    });
    expect(resolveWorkerQueueSubscriptions(consumer, [any])).toEqual([
      { queue: "us-east-1:v2:ondemand:fresh:any:stable", weight: 1 },
    ]);
    expect(() => resolveWorkerQueueSubscriptions(consumer, [stable])).toThrow("not authorized");
  });

  it("defers invalid legacy queue names until a v2 subscription is requested", () => {
    const consumer = createWorkerQueueConsumer({
      ...worker,
      region: null,
      masterQueue: "my workers",
      allowedSubscriptions: [stable],
    });

    try {
      resolveWorkerQueueSubscriptions(consumer, [stable]);
      expect.fail("The v2 request must reject an invalid derived region");
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceValidationError);
      expect((error as ServiceValidationError).status).toBe(422);
    }
  });

  it("keeps the cached worker's permissions fixed until a new worker context is built", () => {
    const allowedSubscriptions = [stable];
    const consumer = createWorkerQueueConsumer({ ...worker, allowedSubscriptions });
    allowedSubscriptions.push(canary);

    expect(resolveWorkerQueueSubscriptions(consumer, [stable])).toEqual([
      { queue: "us-east-1:v2:ondemand:fresh:container:stable", weight: 1 },
    ]);
    expect(() => resolveWorkerQueueSubscriptions(consumer, [canary])).toThrow("not authorized");
    const refreshed = createWorkerQueueConsumer({ ...worker, allowedSubscriptions });
    expect(resolveWorkerQueueSubscriptions(refreshed, [canary])).toEqual([
      { queue: "us-east-1:v2:ondemand:fresh:container:canary", weight: 1 },
    ]);
  });

  it("validates the unweighted default-deny policy at configuration time", () => {
    expect(WorkerQueueSubscriptionPolicyEnv.parse(undefined)).toEqual({});
    expect(
      WorkerQueueSubscriptionPolicyEnv.parse(JSON.stringify({ [worker.workerGroupId]: [stable] }))
    ).toEqual({ [worker.workerGroupId]: [stable] });

    for (const raw of [
      "not JSON",
      JSON.stringify({ [worker.workerGroupId]: [] }),
      JSON.stringify({ [worker.workerGroupId]: [{ ...restore, phase: "unknown" }] }),
      JSON.stringify({ [worker.workerGroupId]: [{ ...stable, region: "another-region" }] }),
      JSON.stringify({ [worker.workerGroupId]: [{ ...stable, weight: 0.5 }] }),
    ]) {
      expect(WorkerQueueSubscriptionPolicyEnv.safeParse(raw).success).toBe(false);
    }
  });
});

describe("workerServesQueue", () => {
  const consumer = () => createWorkerQueueConsumer({ ...worker, allowedSubscriptions: [stable] });

  it("serves its group's legacy queue of either class, from any instance", () => {
    const restarted = { ...consumer(), workerInstanceId: "instance-container-2" };
    expect(workerServesQueue(restarted, "legacy-container-group")).toBe(true);
    expect(workerServesQueue(restarted, "legacy-container-group:scheduled")).toBe(true);
  });

  it("serves a v2 queue in its region that its subscriptions cover", () => {
    expect(workerServesQueue(consumer(), "us-east-1:v2:ondemand:fresh:container:stable")).toBe(
      true
    );
  });

  it("does not serve another group's queue", () => {
    for (const queue of [
      "legacy-other-group",
      "legacy-other-group:scheduled",
      "us-east-1:v2:ondemand:fresh:container:canary",
      "eu-west-1:v2:ondemand:fresh:container:stable",
      "not a queue",
    ]) {
      expect(workerServesQueue(consumer(), queue), queue).toBe(false);
    }
  });

  it("takes its region from the master queue when it has none", () => {
    const regionless = createWorkerQueueConsumer({
      ...worker,
      region: null,
      allowedSubscriptions: [stable],
    });
    expect(
      workerServesQueue(regionless, "legacy-container-group:v2:ondemand:fresh:container:stable")
    ).toBe(true);
  });
});
