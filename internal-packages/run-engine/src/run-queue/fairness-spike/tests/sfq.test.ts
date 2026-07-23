import { describe, it, expect } from "vitest";
import { SfqStrategy } from "../strategies/sfqStrategy.js";
import { descriptorFor, fakeRedis, keys, queueKeyFor } from "./support.js";

const parent = keys.masterQueueKeyForShard(0);

describe("SfqStrategy", () => {
  it("orders an under-served group ahead of an over-served one", async () => {
    const redis = fakeRedis([
      { name: "a~0", head: 100 },
      { name: "b~0", head: 100 },
    ]);
    const sfq = new SfqStrategy({ redis, keys });

    // serve group a ten times; b never
    for (let i = 0; i < 10; i++) sfq.onServiced(descriptorFor("a~0"));

    const order = await sfq.distributeFairQueuesFromParentQueue(parent, "e");
    expect(order).toHaveLength(1);
    expect(order[0].queues[0]).toBe(queueKeyFor("b~0"));
  });

  it("respects weight: a 3x-weighted group is serviceable more often", async () => {
    const redis = fakeRedis([
      { name: "a~0", head: 100 },
      { name: "b~0", head: 100 },
    ]);
    const weight = (g: string) => (g === "a" ? 3 : 1);
    const sfq = new SfqStrategy({ redis, keys, weight });

    let a = 0;
    let b = 0;
    for (let i = 0; i < 40; i++) {
      const order = await sfq.distributeFairQueuesFromParentQueue(parent, "e");
      const head = order[0].queues[0];
      if (head === queueKeyFor("a~0")) {
        a++;
        sfq.onServiced(descriptorFor("a~0"));
      } else {
        b++;
        sfq.onServiced(descriptorFor("b~0"));
      }
    }
    expect(a / b).toBeGreaterThan(2.3);
    expect(a / b).toBeLessThan(3.7);
  });
});
