import { waitForRunStatus } from "@/utils.js";
import { logger, task } from "@trigger.dev/sdk/v3";
import assert from "assert";
import { genericChildTask } from "./helpers.js";

export const describeHeartbeats = task({
  id: "describe/heartbeats",
  retry: {
    maxAttempts: 1,
  },
  run: async (
    { visibilityTimeoutSeconds = 100 }: { visibilityTimeoutSeconds?: number },
    { ctx }
  ) => {
    await testHeartbeats.triggerAndWait({ visibilityTimeoutSeconds }).unwrap();
  },
});

export const testHeartbeats = task({
  id: "test/heartbeats",
  retry: {
    maxAttempts: 1,
  },
  run: async (
    { visibilityTimeoutSeconds = 100 }: { visibilityTimeoutSeconds?: number },
    { ctx }
  ) => {
    const run = await genericChildTask.trigger({
      delayMs: visibilityTimeoutSeconds * 1_000 + 5 * 1000,
    });

    await waitForRunStatus(run.id, ["EXECUTING"]);

    logger.info("Heartbeat test: run is executing");

    const completedRun = await waitForRunStatus(
      run.id,
      ["COMPLETED", "FAILED", "SYSTEM_FAILURE", "CRASHED"],
      visibilityTimeoutSeconds + 30,
      5_000
    );

    assert(completedRun.status === "COMPLETED", `Run failed with status ${completedRun.status}`);

    logger.info("Heartbeat test: run is completed");
  },
});
