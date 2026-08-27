import { describe, expect, it } from "vitest";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";

// A fork means the head is not what this write expected. Below the final dial position Postgres
// holds the authoritative chain, and the repair re-derives the head from it without a compare and
// set, which is exactly what a wrong or missing head needs. Leaving a fork unrepaired freezes that
// run's mirror for the rest of its life, and every later compare-and-set append forks too.
describe("a forked append asks for a repair", () => {
  it("enqueues one repair carrying the entry that could not land", async () => {
    const repairs: { runId: string; snapshotId: string; executionStatus: string }[] = [];
    const store = new TaskRunExecutionSnapshotStore({} as unknown as RunStore, {
      store: {} as never,
      mode: "dual-write",
      onAppendFailure: async (args) => {
        repairs.push(args);
      },
    });

    await store.recordOutcomeForTest(
      "lockRunToWorker",
      { runId: "run_1", id: "snap_2", executionStatus: "EXECUTING", organizationId: "org_1" },
      { outcome: "forked", actualCur: "stale_head" }
    );

    expect(repairs).toEqual([
      { runId: "run_1", snapshotId: "snap_2", executionStatus: "EXECUTING" },
    ]);
  });

  it("asks for nothing when the append landed", async () => {
    const repairs: unknown[] = [];
    const store = new TaskRunExecutionSnapshotStore({} as unknown as RunStore, {
      store: {} as never,
      mode: "dual-write",
      onAppendFailure: async () => {
        repairs.push(1);
      },
    });

    await store.recordOutcomeForTest(
      "lockRunToWorker",
      { runId: "run_1", id: "snap_2", executionStatus: "EXECUTING", organizationId: "org_1" },
      { outcome: "written", seq: 2, ttl: "none", cycleMismatch: false }
    );

    expect(repairs).toEqual([]);
  });
});
