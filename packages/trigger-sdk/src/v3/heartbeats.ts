import { heartbeats as coreHeartbeats } from "@trigger.dev/core/v3";

/**
 *
 * Yields to the Trigger.dev runtime to keep the task alive.
 *
 * This is a cooperative "heartbeat" that you can call as often as you like
 * inside long-running or CPU-heavy loops (e.g. parsing large files, processing
 * many records, or handling big Textract results).
 *
 * You don’t need to worry about over-calling it: the underlying implementation
 * automatically decides when to actually yield to the event loop and send a
 * heartbeat to the Trigger.dev runtime. Extra calls are effectively free.
 *
 * ### Example
 * ```ts
 * import { heartbeats } from "@trigger.dev/sdk/v3";
 *
 * for (const row of bigDataset) {
 *   process(row);
 *   await heartbeats.yield(); // safe to call every iteration
 * }
 * ```
 *
 * Using this regularly prevents `TASK_RUN_STALLED_EXECUTING` errors by ensuring
 * the run never appears idle, even during heavy synchronous work.
 *
 * This function is also safe to call from outside of a Trigger.dev task run, it will effectively be a no-op.
 */
async function heartbeatsYield() {
  await coreHeartbeats.yield();
}

/**
 * Returns the last heartbeat timestamp, for debugging purposes only. You probably don't need this.
 */
function heartbeatsGetLastHeartbeat() {
  return coreHeartbeats.lastHeartbeat;
}

export const heartbeats = {
  yield: heartbeatsYield,
  getLastHeartbeat: heartbeatsGetLastHeartbeat,
};
