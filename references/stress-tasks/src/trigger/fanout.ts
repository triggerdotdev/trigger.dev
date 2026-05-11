import { logger, task } from "@trigger.dev/sdk";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Minimal child task — the fan-out target. The body does nothing meaningful;
 * the cost we want to exercise lives in the trigger plumbing on the server.
 *
 * Optional `sleepMs` lets you keep the child run busy for a while (so concurrent
 * children pile up against worker concurrency limits). Optional `pad` is opaque
 * data — used by the parent tasks to inflate payload size.
 */
export const noopChildTask = task({
  id: "stress-noop-child",
  retry: { maxAttempts: 1 },
  run: async (payload: { index: number; sleepMs?: number; pad?: string }) => {
    if (payload.sleepMs && payload.sleepMs > 0) {
      await sleep(payload.sleepMs);
    }
    return { ok: true, index: payload.index };
  },
});

type TriggerOutcome =
  | { success: true }
  | { success: false; errorName: string; errorMessage: string };

/**
 * Run an async-task pool. Up to `concurrency` workers pull from a shared cursor.
 * Returns results in submission order. Used to cap simultaneous in-flight
 * triggers without sequentialising — closer to a real producer with a connection
 * pool than `Promise.all` over the full list (which fires everything immediately
 * and lets the runtime decide how to interleave).
 */
async function asyncPool<T>(
  concurrency: number,
  total: number,
  produce: (index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(total);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, total));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= total) return;
      results[i] = await produce(i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Fan-out via N concurrent `.trigger()` calls in a single trace.
 *
 * This mirrors the production failure mode catalogued in
 * `prisma-connection-investigation-results.md` — a single trace fans out
 * N HTTP triggers against the webapp api. Run against a local
 * `pnpm run dev --filter webapp` to reproduce `prisma:engine:connection`
 * acquire-wait spikes and the P2024 / "Can't reach database server" surface.
 *
 * Parameters:
 *   count              total triggers to fire (default 1000)
 *   concurrency        max simultaneous in-flight triggers (default = count, i.e. all at once)
 *   childSleepMs       sleep duration the child should observe in its body (default 0)
 *   childPayloadBytes  pad each child payload with this many bytes of opaque data (default 0)
 *   tags               tags applied to every child trigger (default [])
 *
 * Example payloads (copy-paste into the test UI):
 *
 * @example  Smoke test — 10 triggers, all defaults
 * { "count": 10 }
 *
 * @example  Reproduce the prod fan-out — 1,000 all at once, single trace
 * { "count": 1000 }
 *
 * @example  Bounded producer — 1,000 triggers but only 100 in-flight at any time
 * { "count": 1000, "concurrency": 100 }
 *
 * @example  Exercise the `runTags ||` row-lock contention path (events 3, 4, 5, 7)
 * { "count": 1000, "tags": ["stress-test", "burst-2026-05-08"] }
 *
 * @example  Children doing real work — 500 triggers, 2s child sleep, 200 in-flight
 * { "count": 500, "concurrency": 200, "childSleepMs": 2000 }
 *
 * @example  Large payloads — 200 triggers, 50KB pad each (marshalling pressure)
 * { "count": 200, "childPayloadBytes": 50000 }
 *
 * @example  Combined contention — fan-out + tags + child work
 * { "count": 1000, "concurrency": 250, "childSleepMs": 500, "tags": ["combined"] }
 */
export const fanOutTriggerTask = task({
  id: "stress-fan-out-trigger",
  maxDuration: 600,
  retry: { maxAttempts: 1 },
  run: async (payload: {
    count?: number;
    concurrency?: number;
    childSleepMs?: number;
    childPayloadBytes?: number;
    tags?: string[];
  }) => {
    const count = payload.count ?? 1000;
    const concurrency = payload.concurrency ?? count;
    const childSleepMs = payload.childSleepMs ?? 0;
    const childPayloadBytes = payload.childPayloadBytes ?? 0;
    const tags = payload.tags ?? [];

    const pad = childPayloadBytes > 0 ? "x".repeat(childPayloadBytes) : undefined;
    const triggerOptions = tags.length > 0 ? { tags } : undefined;

    logger.info("Starting fan-out via individual triggers", {
      count,
      concurrency,
      childSleepMs,
      childPayloadBytes,
      tags,
    });
    const start = Date.now();

    const results = await asyncPool<TriggerOutcome>(concurrency, count, async (index) => {
      try {
        await noopChildTask.trigger(
          { index, sleepMs: childSleepMs, pad },
          triggerOptions,
        );
        return { success: true };
      } catch (err) {
        const e = err as Error;
        return {
          success: false,
          errorName: e?.constructor?.name ?? "Unknown",
          errorMessage: e?.message ?? String(err),
        };
      }
    });

    const fulfilled = results.filter((r) => r.success).length;
    const failures = results.filter(
      (r): r is Extract<TriggerOutcome, { success: false }> => !r.success,
    );

    const errorCounts: Record<string, number> = {};
    for (const f of failures) {
      errorCounts[f.errorName] = (errorCounts[f.errorName] ?? 0) + 1;
    }

    const durationMs = Date.now() - start;
    const summary = {
      count,
      concurrency,
      childSleepMs,
      childPayloadBytes,
      fulfilled,
      rejected: failures.length,
      durationMs,
      triggersPerSecond:
        durationMs > 0 ? Math.round((fulfilled / durationMs) * 1000) : 0,
      errorCounts,
      sampleErrors: failures.slice(0, 5).map((f) => ({
        name: f.errorName,
        message: f.errorMessage,
      })),
    };

    logger.info("Fan-out complete", summary);
    return summary;
  },
});

/**
 * Fan-out via `batchTrigger`, chunked into `batchSize`-payload calls.
 *
 * Different server-side code path from `fanOutTriggerTask`: one HTTP
 * request per chunk and a server-side bulk insert, vs. N individual API
 * round-trips. Useful contrast for understanding whether pool pressure
 * is specific to the N-trigger path or shows up here too.
 *
 * Parameters:
 *   count              total triggers to fire (default 1000)
 *   batchSize          payloads per batchTrigger call (default 500, the SDK default cap)
 *   chunkConcurrency   max simultaneous in-flight batchTrigger calls (default 1, sequential)
 *   childSleepMs       sleep duration the child should observe in its body (default 0)
 *   childPayloadBytes  pad each child payload with this many bytes of opaque data (default 0)
 *   tags               tags applied to every child trigger (default [])
 *
 * Example payloads (copy-paste into the test UI):
 *
 * @example  Smoke test — single small batch
 * { "count": 10, "batchSize": 10 }
 *
 * @example  Default — 1,000 triggers across two sequential 500-payload batches
 * { "count": 1000 }
 *
 * @example  Parallel batches — same volume, two batchTrigger calls in flight
 * { "count": 1000, "chunkConcurrency": 2 }
 *
 * @example  Many small batches — 100 chunks of 10, sequential
 * { "count": 1000, "batchSize": 10 }
 *
 * @example  Many small batches in parallel — 100 chunks of 10, 8 in flight
 * { "count": 1000, "batchSize": 10, "chunkConcurrency": 8 }
 *
 * @example  With tags — exercise `runTags ||` contention via the batch path
 * { "count": 1000, "tags": ["stress-batch"] }
 *
 * @example  Children doing real work
 * { "count": 500, "batchSize": 100, "chunkConcurrency": 5, "childSleepMs": 2000 }
 */
export const fanOutBatchTask = task({
  id: "stress-fan-out-batch",
  maxDuration: 600,
  retry: { maxAttempts: 1 },
  run: async (payload: {
    count?: number;
    batchSize?: number;
    chunkConcurrency?: number;
    childSleepMs?: number;
    childPayloadBytes?: number;
    tags?: string[];
  }) => {
    const count = payload.count ?? 1000;
    const batchSize = payload.batchSize ?? 500;
    const chunkConcurrency = payload.chunkConcurrency ?? 1;
    const childSleepMs = payload.childSleepMs ?? 0;
    const childPayloadBytes = payload.childPayloadBytes ?? 0;
    const tags = payload.tags ?? [];

    const pad = childPayloadBytes > 0 ? "x".repeat(childPayloadBytes) : undefined;
    const itemOptions = tags.length > 0 ? { tags } : undefined;

    logger.info("Starting fan-out via batchTrigger", {
      count,
      batchSize,
      chunkConcurrency,
      childSleepMs,
      childPayloadBytes,
      tags,
    });
    const start = Date.now();

    const chunkCount = Math.ceil(count / batchSize);
    const chunks = Array.from({ length: chunkCount }, (_, chunkIndex) => {
      const startIdx = chunkIndex * batchSize;
      const endIdx = Math.min(startIdx + batchSize, count);
      return Array.from({ length: endIdx - startIdx }, (_, k) => ({
        payload: { index: startIdx + k, sleepMs: childSleepMs, pad },
        ...(itemOptions ? { options: itemOptions } : {}),
      }));
    });

    const chunkResults = await asyncPool(
      chunkConcurrency,
      chunkCount,
      async (i) => noopChildTask.batchTrigger(chunks[i]),
    );

    const totalCreated = chunkResults.reduce((sum, r) => sum + r.runCount, 0);
    const durationMs = Date.now() - start;
    const summary = {
      count,
      batchSize,
      chunkConcurrency,
      chunkCount,
      totalCreated,
      durationMs,
      triggersPerSecond:
        durationMs > 0 ? Math.round((totalCreated / durationMs) * 1000) : 0,
    };
    logger.info("Batch fan-out complete", summary);
    return summary;
  },
});
