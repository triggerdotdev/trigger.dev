import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { createRedisClient, type RedisOptions } from "@internal/redis";
import { Decimal } from "@trigger.dev/database";
import { RunQueue } from "../../index.js";
import { FairQueueSelectionStrategy } from "../../fairQueueSelectionStrategy.js";
import { RunQueueFullKeyProducer } from "../../keyProducer.js";
import type { InputPayload } from "../../types.js";
import {
  computeMetrics,
  type DequeueEvent,
  type RunMetrics,
} from "../../fairness-spike/harness/metrics.js";
import {
  expandEvents,
  totalsOf,
  weightsOf,
  type WorkloadSpec,
} from "../../fairness-spike/harness/workload.js";
import { CkReader } from "../ckReader.js";
import { rescoreCkIndex } from "../ckRescorer.js";
import type { CkDiscipline } from "../disciplines.js";

const keys = new RunQueueFullKeyProducer();
const ORG = "o-ck";
const PROJECT = "p-ck";
const ENV = "e-ck";
const BASE_QUEUE = "task/base";

export type CkDriverConfig = {
  redis: RedisOptions;
  discipline: CkDiscipline;
  workload: WorkloadSpec;
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
 * Drives one workload across many concurrency keys under a single base queue.
 * The fairness group is the concurrency key (= workload groupId). For rescore
 * disciplines, the ckIndex scores are rewritten each round so the real
 * CK-dequeue Lua serves keys in discipline order; the baseline leaves them as
 * the Lua maintains them (production age order).
 */
export async function runCkScenario(config: CkDriverConfig): Promise<RunMetrics> {
  const maxLogicalMs = config.maxLogicalMs ?? 600_000;
  const limit = config.workload.envConcurrencyLimit;
  const env = authenticatedEnv(limit);

  const admin = createRedisClient(config.redis);
  await admin.flushdb();

  const queue = new RunQueue({
    name: "rq-ck",
    tracer: trace.getTracer("rq-ck"),
    logger: new Logger("RunQueueCk", "error"),
    defaultEnvConcurrency: limit,
    shardCount: 1,
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    keys,
    redis: config.redis,
    queueSelectionStrategy: new FairQueueSelectionStrategy({ redis: config.redis, keys }),
  });

  const reader = new CkReader(admin, keys, config.redis.keyPrefix ?? "");
  config.discipline.reset();

  const sorted = expandEvents(config.workload);
  const total = sorted.length;
  const holdByRun = new Map<string, number>();
  const enqueueByRun = new Map<string, number>();
  for (const e of sorted) {
    holdByRun.set(e.runId, e.holdMs);
    enqueueByRun.set(e.runId, e.enqueueAtMs);
  }

  const scoreBase = Date.now() - maxLogicalMs - 5_000;
  const events: DequeueEvent[] = [];
  const holding: Array<{ runId: string; releaseAtMs: number }> = [];
  let enqCursor = 0;
  let selectionRounds = 0;
  let t = 0;
  const startedAt = Date.now();

  try {
    while (events.length < total && t <= maxLogicalMs) {
      for (let i = holding.length - 1; i >= 0; i--) {
        if (holding[i].releaseAtMs <= t) {
          const [h] = holding.splice(i, 1);
          await queue.acknowledgeMessage(ORG, h.runId, { skipDequeueProcessing: true });
        }
      }

      while (enqCursor < sorted.length && sorted[enqCursor].enqueueAtMs <= t) {
        const e = sorted[enqCursor++];
        const message: InputPayload = {
          runId: e.runId,
          orgId: ORG,
          projectId: PROJECT,
          environmentId: ENV,
          environmentType: "PRODUCTION",
          queue: BASE_QUEUE,
          concurrencyKey: e.groupId,
          timestamp: scoreBase + e.enqueueAtMs,
          attempt: 0,
        };
        await queue.enqueueMessage({ env, message, workerQueue: ENV, skipDequeueProcessing: true });
      }

      let progressed = true;
      while (progressed) {
        if (config.discipline.rescore) {
          const active = await reader.readActiveCks(keys.queueKey(env, BASE_QUEUE, "any"));
          if (active.length > 0) {
            const order = config.discipline.order(active, scoreBase + t);
            await rescoreCkIndex(admin, keys, keys.queueKey(env, BASE_QUEUE, "any"), order, Date.now());
          }
        }

        const msgs = await queue.testDequeueFromMasterQueue(0, ENV, 1);
        selectionRounds++;
        progressed = msgs.length > 0;
        for (const m of msgs) {
          const ck = keys.descriptorFromQueue(m.message.queue).concurrencyKey ?? "__none__";
          const runId = m.messageId;
          events.push({
            groupId: ck,
            runId,
            enqueueAtMs: enqueueByRun.get(runId) ?? 0,
            dequeueAtMs: t,
          });
          config.discipline.onServiced(ck);
          holding.push({ runId, releaseAtMs: t + (holdByRun.get(runId) ?? 0) });
        }
      }

      const candidates: number[] = [];
      if (enqCursor < sorted.length) candidates.push(sorted[enqCursor].enqueueAtMs);
      if (holding.length > 0) candidates.push(Math.min(...holding.map((h) => h.releaseAtMs)));
      if (candidates.length === 0) break;
      t = Math.max(t + 1, Math.min(...candidates));
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
