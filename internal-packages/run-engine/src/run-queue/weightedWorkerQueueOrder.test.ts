import { describe, expect, it } from "vitest";
import { weightedWorkerQueueOrder } from "./weightedWorkerQueueOrder.js";

describe("weightedWorkerQueueOrder", () => {
  it("uses an exponential race and excludes zero-weight queues", () => {
    const randomValues = [0.5, 0.25];
    const order = weightedWorkerQueueOrder(
      [
        { queue: "standard", weight: 1 },
        { queue: "canary", weight: 0.25 },
        { queue: "disabled", weight: 0 },
      ],
      () => randomValues.shift()!
    );

    expect(order).toEqual(["standard", "canary"]);
  });

  it("orders equal Number.MIN_VALUE weights without overflow", () => {
    const randomValues = [0.75, 0.25];
    expect(
      weightedWorkerQueueOrder(
        [
          { queue: "first", weight: Number.MIN_VALUE },
          { queue: "second", weight: Number.MIN_VALUE },
        ],
        () => randomValues.shift()!
      )
    ).toEqual(["second", "first"]);
  });
});
