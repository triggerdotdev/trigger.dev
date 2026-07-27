import { logger, queue, task } from "@trigger.dev/sdk";

// One shared base queue. Per-run concurrencyKey (set at trigger time) creates the
// concurrency-key variants whose dequeue ORDER the change under test governs.
//
// concurrencyLimit is the PER-KEY lane width. Set it to 1 so each key holds one
// slot at a time; cross-key contention is then forced by the ENVIRONMENT
// concurrency ceiling (pin RuntimeEnvironment.maximumConcurrencyLimit low, e.g.
// 5, on the prod env of the bench project). With N keys all wanting to run and
// only a few env slots, the CK dequeue decides who starts first: that ordering
// is exactly OFF (age) vs ON (virtual time).
export const ckBenchQueue = queue({
  name: "ck-bench",
  concurrencyLimit: 1,
});

export type CkBenchPayload = {
  // logical hold: how long the run occupies its slot, in ms
  holdMs: number;
  // carried through for grouping in analysis (also set as a tag by the loadgen)
  tenant: string;
  key: string;
  arm: "off" | "on";
  batch: string;
};

export const ckBenchTask = task({
  id: "ck-bench",
  queue: ckBenchQueue,
  run: async (payload: CkBenchPayload) => {
    logger.info("ck-bench start", {
      tenant: payload.tenant,
      key: payload.key,
      arm: payload.arm,
      batch: payload.batch,
    });
    // Occupy the slot for the hold so concurrency actually contends. A plain
    // timer is enough: this task exists only to hold a slot, not to do work.
    await new Promise((resolve) => setTimeout(resolve, payload.holdMs));
    return { tenant: payload.tenant, key: payload.key, arm: payload.arm };
  },
});
