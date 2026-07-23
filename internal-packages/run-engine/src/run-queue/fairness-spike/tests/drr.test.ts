import { describe, it, expect } from "vitest";
import { DrrStrategy } from "../strategies/drrStrategy.js";
import { descriptorFor, fakeRedis, keys, queueKeyFor } from "./support.js";

const parent = keys.masterQueueKeyForShard(0);

describe("DrrStrategy", () => {
  it("alternates evenly between two equal-weight groups", async () => {
    const redis = fakeRedis([
      { name: "a~0", head: 100 },
      { name: "b~0", head: 100 },
    ]);
    const drr = new DrrStrategy({ redis, keys });

    let a = 0;
    let b = 0;
    for (let i = 0; i < 10; i++) {
      const order = await drr.distributeFairQueuesFromParentQueue(parent, "e");
      const head = order[0].queues[0];
      if (head === queueKeyFor("a~0")) {
        a++;
        drr.onServiced(descriptorFor("a~0"));
      } else {
        b++;
        drr.onServiced(descriptorFor("b~0"));
      }
    }
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  });

  it("splits capacity by weight (3:1)", async () => {
    const redis = fakeRedis([
      { name: "a~0", head: 100 },
      { name: "b~0", head: 100 },
    ]);
    const weight = (g: string) => (g === "a" ? 3 : 1);
    const drr = new DrrStrategy({ redis, keys, weight });

    let a = 0;
    let b = 0;
    for (let i = 0; i < 80; i++) {
      const order = await drr.distributeFairQueuesFromParentQueue(parent, "e");
      const head = order[0].queues[0];
      if (head === queueKeyFor("a~0")) {
        a++;
        drr.onServiced(descriptorFor("a~0"));
      } else {
        b++;
        drr.onServiced(descriptorFor("b~0"));
      }
    }
    expect(a / b).toBeGreaterThan(2.3);
    expect(a / b).toBeLessThan(3.7);
  });
});
