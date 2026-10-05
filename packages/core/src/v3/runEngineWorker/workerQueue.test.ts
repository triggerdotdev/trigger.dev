import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  formatWorkerQueue,
  parseWorkerQueue,
  scheduledWorkerQueue,
  WeightedWorkerQueueSubscriptions,
  WorkerQueueSubscription,
  type WorkerQueue,
} from "./workerQueue.js";
import { WorkerApiDequeueRequestBody } from "./supervisor/schemas.js";

const restoreSubscription = {
  class: "ondemand",
  phase: "restore",
  compat: "compute",
  channel: "canary",
} as const;

describe("worker queue names", () => {
  it.each<[string, WorkerQueue]>([
    ["us-east-1", { region: "us-east-1", version: "legacy", class: "ondemand" }],
    ["us-east-1:scheduled", { region: "us-east-1", version: "legacy", class: "scheduled" }],
    [
      "us-east-1:v2:ondemand:fresh:any:stable",
      {
        region: "us-east-1",
        version: "v2",
        class: "ondemand",
        phase: "fresh",
        compat: "any",
        channel: "stable",
      },
    ],
    [
      "us-east-1:v2:scheduled:fresh:container:stable",
      {
        region: "us-east-1",
        version: "v2",
        class: "scheduled",
        phase: "fresh",
        compat: "container",
        channel: "stable",
      },
    ],
    [
      "us-east-1:v2:ondemand:restore:compute:canary",
      { region: "us-east-1", version: "v2", ...restoreSubscription },
    ],
  ])("parses and formats %s", (name, queue) => {
    expect(parseWorkerQueue(name)).toEqual(queue);
    expect(formatWorkerQueue(queue)).toBe(name);
  });

  it.each([
    "",
    "us-east-1:v3:ondemand:fresh:any:stable",
    "us-east-1:v2:standard:fresh:any:stable",
    "us-east-1:v2:ondemand:fresh:any",
    "us-east-1:v2:ondemand:fresh:any:stable:extra",
    "us-east-1:v2:ondemand:fresh:any:unknown",
    "us-east-1:v2:ondemand :fresh:any:stable",
  ])("rejects an invalid name without falling back to legacy: %s", (name) => {
    expect(() => parseWorkerQueue(name)).toThrow();
  });

  it("changes only the class, including for restore queues", () => {
    expect(scheduledWorkerQueue("us-east-1:v2:ondemand:fresh:container:canary")).toBe(
      "us-east-1:v2:scheduled:fresh:container:canary"
    );
    expect(scheduledWorkerQueue("us-east-1:v2:ondemand:restore:container:canary")).toBe(
      "us-east-1:v2:scheduled:restore:container:canary"
    );
    expect(scheduledWorkerQueue("us-east-1:v2:scheduled:restore:container:canary")).toBe(
      "us-east-1:v2:scheduled:restore:container:canary"
    );
  });
});

describe("dequeue selection contract", () => {
  it("retains absent, default and scheduled legacy selection", () => {
    for (const body of [{}, { queueClass: "default" }, { queueClass: "scheduled" }]) {
      expect(WorkerApiDequeueRequestBody.parse(body)).toEqual(body);
    }
  });

  it("accepts weighted v2 subscriptions and defaults omitted weights semantically", () => {
    const body = {
      subscriptions: [
        { class: "ondemand", phase: "fresh", compat: "any", channel: "stable" },
        { ...restoreSubscription, weight: 0.25 },
      ],
    };
    expect(WorkerApiDequeueRequestBody.parse(body)).toEqual(body);
  });

  it("rejects duplicate identities and a subscription set with no positive weight", () => {
    expect(WeightedWorkerQueueSubscriptions.safeParse([]).success).toBe(false);
    expect(
      WeightedWorkerQueueSubscriptions.safeParse([
        restoreSubscription,
        { ...restoreSubscription, weight: 0.5 },
      ]).success
    ).toBe(false);
    expect(
      WeightedWorkerQueueSubscriptions.safeParse([
        { ...restoreSubscription, weight: 0 },
        {
          class: "scheduled",
          phase: "restore",
          compat: "compute",
          channel: "canary",
          weight: 0,
        },
      ]).success
    ).toBe(false);
  });

  it("rejects non-finite and out-of-range weights", () => {
    for (const weight of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      expect(
        WeightedWorkerQueueSubscriptions.safeParse([{ ...restoreSubscription, weight }]).success
      ).toBe(false);
    }
    expect(
      WeightedWorkerQueueSubscriptions.safeParse([
        { ...restoreSubscription, weight: Number.MIN_VALUE },
      ]).success
    ).toBe(true);
  });

  it("rejects empty subscriptions and mixed legacy/v2 selection", () => {
    expect(WorkerApiDequeueRequestBody.safeParse({ subscriptions: [] }).success).toBe(false);
    for (const queueClass of ["default", "scheduled"]) {
      expect(
        WorkerApiDequeueRequestBody.safeParse({ queueClass, subscriptions: [restoreSubscription] })
          .success
      ).toBe(false);
    }
  });

  it("enforces mutual exclusion in the compiled HTTP validator", () => {
    const schema = z.compile(WorkerApiDequeueRequestBody);
    expect(schema.safeParse({ subscriptions: [restoreSubscription] }).success).toBe(true);
    expect(
      schema.safeParse({ queueClass: "default", subscriptions: [restoreSubscription] }).success
    ).toBe(false);
  });

  it("leaves restore compatibility policy outside the queue schema", () => {
    const subscription = { ...restoreSubscription, compat: "any" } as const;
    expect(WorkerQueueSubscription.parse(subscription)).toEqual(subscription);
    for (const schema of [WorkerApiDequeueRequestBody, z.compile(WorkerApiDequeueRequestBody)]) {
      expect(schema.safeParse({ subscriptions: [subscription] }).success).toBe(true);
    }
    const queue = { region: "us-east-1", version: "v2", ...subscription } as const;
    expect(parseWorkerQueue(formatWorkerQueue(queue))).toEqual(queue);
  });

  it("rejects client-supplied region/version fields", () => {
    for (const subscription of [
      { ...restoreSubscription, region: "us-east-1" },
      { ...restoreSubscription, version: "v2" },
    ]) {
      expect(WorkerQueueSubscription.safeParse(subscription).success).toBe(false);
    }
  });
});
