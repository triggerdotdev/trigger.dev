import { containerTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { engineOptionsForSnapshotRepair } from "./helpers/snapshotRepairEngine.js";

containerTest(
  "a second repair for the same run enqueues no second job",
  async ({ prisma, redisOptions }) => {
    const engine = new RunEngine(engineOptionsForSnapshotRepair(prisma, redisOptions) as never);

    try {
      const payload = {
        runId: "run_repair_dedupe",
        snapshotId: "snap_1",
        executionStatus: "EXECUTING",
      };

      // The stall watchdog uses this same job id, so the two compensators must collapse to one.
      expect(await engine.enqueueSnapshotRepair(payload)).toBe(true);
      expect(await engine.enqueueSnapshotRepair({ ...payload, snapshotId: "snap_2" })).toBe(false);
    } finally {
      await engine.quit();
    }
  }
);

containerTest("a different run gets its own repair job", async ({ prisma, redisOptions }) => {
  const engine = new RunEngine(engineOptionsForSnapshotRepair(prisma, redisOptions) as never);

  try {
    expect(
      await engine.enqueueSnapshotRepair({
        runId: "run_a",
        snapshotId: "snap_a",
        executionStatus: "EXECUTING",
      })
    ).toBe(true);
    expect(
      await engine.enqueueSnapshotRepair({
        runId: "run_b",
        snapshotId: "snap_b",
        executionStatus: "EXECUTING",
      })
    ).toBe(true);
  } finally {
    await engine.quit();
  }
});
