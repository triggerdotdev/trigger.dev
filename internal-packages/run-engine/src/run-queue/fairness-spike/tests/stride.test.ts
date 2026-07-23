import { describe, it, expect } from "vitest";
import { StrideStrategy } from "../strategies/strideStrategy.js";
import { descriptorFor, fakeRedis, keys, queueKeyFor } from "./support.js";

const parent = keys.masterQueueKeyForShard(0);

async function serviceRatio(weight: (g: string) => number, rounds: number) {
  const redis = fakeRedis([
    { name: "a~0", head: 100 },
    { name: "b~0", head: 100 },
  ]);
  const stride = new StrideStrategy({ redis, keys, weight });
  let a = 0;
  let b = 0;
  for (let i = 0; i < rounds; i++) {
    const order = await stride.distributeFairQueuesFromParentQueue(parent, "e");
    const head = order[0].queues[0];
    if (head === queueKeyFor("a~0")) {
      a++;
      stride.onServiced(descriptorFor("a~0"));
    } else {
      b++;
      stride.onServiced(descriptorFor("b~0"));
    }
  }
  return a / b;
}

describe("StrideStrategy", () => {
  it("services 3:1-weighted groups roughly 3:1", async () => {
    const ratio = await serviceRatio((g) => (g === "a" ? 3 : 1), 80);
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio).toBeLessThan(3.5);
  });

  it("services equal-weight groups roughly 1:1", async () => {
    const ratio = await serviceRatio(() => 1, 80);
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.2);
  });
});
