import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { createRedisClient } from "@internal/redis";
import { Decimal } from "@trigger.dev/database";
import { RunQueue } from "../../index.js";
import { RunQueueFullKeyProducer } from "../../keyProducer.js";
import type { InputPayload, RunQueueSelectionStrategy } from "../../types.js";
import { groupIdFromQueueName, type SpikeSelectionStrategy } from "../types.js";
import { computeMetrics, type DequeueEvent, type RunMetrics } from "./metrics.js";
import { expandEvents, totalsOf, weightsOf, type WorkloadSpec } from "./workload.js";

const keys = new RunQueueFullKeyProducer();

const ORG = "o-spike";
const PROJECT = "p-spike";
const ENV = "e-spike";

export type DriverConfig = {
  redis: { host: string; port: number; keyPrefix: string };
  strategy: RunQueueSelectionStrategy &
    Partial<Pick<SpikeSelectionStrategy, "onServiced" | "reset" | "setClock">>;
  workload: WorkloadSpec;
  /** ceiling on logical time (ms); the loop is event-driven so this only guards runaway starvation */
  maxLogicalMs?: number;
};

function authenticatedEnv(limit: number) {
  return {
    id: ENV,
    type: "PRODUCTION" as const,
    maximumConcurrencyLimit: limit,
    concurrencyLimitBurstFactor: new Decimal(1.0),
    project: { id: PROJECT },
    organization: { id: ORG },
  };
}

/**
 * Runs one workload through a real RunQueue against Redis and returns fairness /
 * latency / cost metrics. Deterministic: a logical clock drives arrivals and
 * concurrency-slot releases, and the loop jumps straight to the next event
 * rather than ticking through idle time.
 *
 * The RunQueue's background worker is disabled and acks skip dequeue processing,
 * so the ONLY thing that moves runs out of the queue is the driver's explicit
 * `testDequeueFromMasterQueue` call. Otherwise the internal worker would drain
 * runs through the normal worker-queue path behind the driver's back.
 */
export async function runScenario(config: DriverConfig): Promise<RunMetrics> {
  const maxLogicalMs = config.maxLogicalMs ?? 600_000;
  const limit = config.workload.envConcurrencyLimit;
  const env = authenticatedEnv(limit);

  const admin = createRedisClient(config.redis);
  // NOTE: flushes the whole Redis DB, ignoring keyPrefix. Safe against the
  // dedicated testcontainer this spike runs on; do not point config.redis at a
  // shared instance.
  await admin.flushdb();

  const queue = new RunQueue({
    name: "rq-spike",
    tracer: trace.getTracer("rq-spike"),
    logger: new Logger("RunQueueSpike", "error"),
    defaultEnvConcurrency: limit,
    shardCount: 1,
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    keys,
    redis: config.redis,
    queueSelectionStrategy: config.strategy,
  });

  await config.strategy.reset?.();

  const sorted = expandEvents(config.workload);
  const total = sorted.length;
  const holdByRun = new Map<string, number>();
  const enqueueByRun = new Map<string, number>();
  for (const e of sorted) {
    holdByRun.set(e.runId, e.holdMs);
    enqueueByRun.set(e.runId, e.enqueueAtMs);
  }

  // Anchor message scores in the past so the dequeue Lua's `score <= now` filter
  // always passes; arrival timing is enforced by the driver, not the score.
  const scoreBase = Date.now() - maxLogicalMs - 5_000;

  const events: DequeueEvent[] = [];
  const holding: Array<{ runId: string; releaseAtMs: number }> = [];
  let enqCursor = 0;
  let selectionRounds = 0;
  let t = 0;
  const startedAt = Date.now();

  try {
    while (events.length < total && t <= maxLogicalMs) {
      // (a) release concurrency for holds that have expired by t
      for (let i = holding.length - 1; i >= 0; i--) {
        if (holding[i].releaseAtMs <= t) {
          const [h] = holding.splice(i, 1);
          await queue.acknowledgeMessage(ORG, h.runId, { skipDequeueProcessing: true });
        }
      }

      // (b) enqueue all arrivals up to t
      while (enqCursor < sorted.length && sorted[enqCursor].enqueueAtMs <= t) {
        const e = sorted[enqCursor++];
        const message: InputPayload = {
          runId: e.runId,
          orgId: ORG,
          projectId: PROJECT,
          environmentId: ENV,
          environmentType: "PRODUCTION",
          queue: e.queueName,
          timestamp: scoreBase + e.enqueueAtMs,
          attempt: 0,
        };
        await queue.enqueueMessage({
          env,
          message,
          workerQueue: ENV,
          skipDequeueProcessing: true,
        });
      }

      // (c) drain available env capacity at this instant, one run per queue per
      // round, re-running the strategy each round so stateful selectors react.
      config.strategy.setClock?.(scoreBase + t);
      let progressed = true;
      while (progressed) {
        const msgs = await queue.testDequeueFromMasterQueue(0, ENV, 1);
        selectionRounds++;
        progressed = msgs.length > 0;
        for (const m of msgs) {
          const descriptor = keys.descriptorFromQueue(m.message.queue);
          const runId = m.messageId;
          events.push({
            groupId: groupIdFromQueueName(descriptor.queue),
            runId,
            enqueueAtMs: enqueueByRun.get(runId) ?? 0,
            dequeueAtMs: t,
          });
          await config.strategy.onServiced?.(descriptor, t);
          holding.push({ runId, releaseAtMs: t + (holdByRun.get(runId) ?? 0) });
        }
      }

      // advance to the next event (next arrival or next release)
      const candidates: number[] = [];
      if (enqCursor < sorted.length) candidates.push(sorted[enqCursor].enqueueAtMs);
      if (holding.length > 0) candidates.push(Math.min(...holding.map((h) => h.releaseAtMs)));
      if (candidates.length === 0) break;
      const next = Math.min(...candidates);
      t = Math.max(t + 1, next);
    }

    return computeMetrics({
      events,
      weights: weightsOf(config.workload),
      totals: totalsOf(config.workload),
      redisOps: selectionRounds,
      wallClockMs: Date.now() - startedAt,
    });
  } finally {
    for (const h of holding) {
      await queue.acknowledgeMessage(ORG, h.runId, { skipDequeueProcessing: true }).catch(() => {});
    }
    await admin.quit();
    await queue.quit();
  }
}
