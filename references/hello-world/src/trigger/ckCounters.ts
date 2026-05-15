import { logger, queue, task } from "@trigger.dev/sdk";
import { setTimeout } from "node:timers/promises";

async function tryCatch<T>(
  promise: Promise<T>
): Promise<[Error, undefined] | [undefined, T]> {
  try {
    return [undefined, await promise];
  } catch (err) {
    return [err instanceof Error ? err : new Error(String(err)), undefined];
  }
}

// Slow CK queue: concurrency=2 so only 2 run at a time, the rest pile up in the
// per-CK-variant zsets. The Tracked Lua scripts should keep the per-base-queue
// lengthCounter in sync; before the fix, the dashboard's "Queued" column and the
// `validateQueueLimits` cap would read 0 from the empty base zset.
const ckCountersQueue = queue({
  name: "ck-counters-test-queue",
  concurrencyLimit: 2,
});

// Slow worker — sleeps long enough to leave a backlog visible during inspection.
export const ckCountersWorker = task({
  id: "ck-counters-worker",
  queue: ckCountersQueue,
  retry: { maxAttempts: 1 },
  run: async (payload: { id: string; waitMs: number }) => {
    logger.info(`ck-counters-worker ${payload.id} started`);
    await setTimeout(payload.waitMs);
    logger.info(`ck-counters-worker ${payload.id} finished`);
    return { id: payload.id };
  },
});

// Drives a deterministic backlog:
//   2 CKs (alpha, beta), 5 runs per CK, waitMs configurable.
//   With concurrency=2, 2 of them run while ~8 sit in the CK-variant zsets.
//   Inspect Redis during the wait to verify counters.
export const ckCountersBacklog = task({
  id: "ck-counters-backlog",
  retry: { maxAttempts: 1 },
  maxDuration: 600,
  run: async (payload: {
    ckCount?: number;
    perCk?: number;
    waitMs?: number;
    inspectSeconds?: number;
  }) => {
    const ckCount = payload.ckCount ?? 2;
    const perCk = payload.perCk ?? 5;
    const waitMs = payload.waitMs ?? 30_000;
    const inspectSeconds = payload.inspectSeconds ?? 0;

    const total = ckCount * perCk;
    logger.info("ck-counters-backlog triggering child runs", {
      ckCount,
      perCk,
      waitMs,
      total,
    });

    let triggered = 0;
    let rejected = 0;
    const rejectionMessages: string[] = [];

    for (let c = 0; c < ckCount; c++) {
      const ck = `ck-${String.fromCharCode(97 + c)}`;
      for (let i = 0; i < perCk; i++) {
        const [err, handle] = await tryCatch(
          ckCountersWorker.trigger(
            { id: `${ck}-${i}`, waitMs },
            { concurrencyKey: ck }
          )
        );

        if (err) {
          rejected += 1;
          rejectionMessages.push(`${ck}-${i}: ${err.message}`);
          logger.warn(`Trigger rejected for ${ck}-${i}`, { error: err.message });
        } else {
          triggered += 1;
          logger.info(`Triggered ${ck}-${i}`, { runId: handle?.id });
        }
      }
    }

    logger.info("ck-counters-backlog done triggering", {
      triggered,
      rejected,
      rejectionMessages,
    });

    if (inspectSeconds > 0) {
      logger.info(`Holding parent open for ${inspectSeconds}s for inspection…`);
      await setTimeout(inspectSeconds * 1000);
    }

    return { triggered, rejected, rejectionMessages };
  },
});
