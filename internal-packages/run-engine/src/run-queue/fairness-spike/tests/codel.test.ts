import { describe, it, expect } from "vitest";
import type { Redis } from "@internal/redis";
import { CodelWrapper } from "../strategies/codelWrapper.js";
import type { SpikeSelectionStrategy } from "../types.js";
import { keys, queueKeyFor } from "./support.js";

const parent = keys.masterQueueKeyForShard(0);

/** Base selector that always orders a~0 before b~0. */
const stubBase: SpikeSelectionStrategy = {
  name: "stub",
  async distributeFairQueuesFromParentQueue() {
    return [{ envId: "e", queues: [queueKeyFor("a~0"), queueKeyFor("b~0")] }];
  },
  onServiced() {},
};

/** Mutable fake redis whose queue heads can change between calls. */
function mutableRedis(state: { active: Array<{ name: string; head: number }> }): Redis {
  return {
    async zrange(_key: string, _s: number, _e: number, ws?: string): Promise<string[]> {
      if (ws) return state.active.flatMap((q) => [queueKeyFor(q.name), String(q.head)]);
      return state.active.map((q) => queueKeyFor(q.name));
    },
  } as unknown as Redis;
}

describe("CodelWrapper", () => {
  it("hoists a group whose sojourn exceeds target for a full interval, then reverts", async () => {
    const state = {
      active: [
        { name: "a~0", head: 1000 },
        { name: "b~0", head: 0 },
      ],
    };
    const codel = new CodelWrapper({
      base: stubBase,
      redis: mutableRedis(state),
      keys,
      targetMs: 50,
      intervalMs: 100,
    });

    // t=200: b sojourn = 200 > target, but interval not yet elapsed
    codel.setClock(200);
    let order = await codel.distributeFairQueuesFromParentQueue(parent, "e");
    expect(order[0].queues[0]).toBe(queueKeyFor("a~0"));

    // t=350: b has been above target for 150ms >= interval -> hoisted
    codel.setClock(350);
    order = await codel.distributeFairQueuesFromParentQueue(parent, "e");
    expect(order[0].queues[0]).toBe(queueKeyFor("b~0"));

    // b's oldest run is now fresh -> sojourn drops below target -> reverts
    state.active = [
      { name: "a~0", head: 1000 },
      { name: "b~0", head: 349 },
    ];
    order = await codel.distributeFairQueuesFromParentQueue(parent, "e");
    expect(order[0].queues[0]).toBe(queueKeyFor("a~0"));
  });
});
