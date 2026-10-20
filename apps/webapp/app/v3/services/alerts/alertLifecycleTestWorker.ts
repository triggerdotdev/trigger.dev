import { Logger } from "@trigger.dev/core/logger";
import { CronSchema, Worker } from "@trigger.dev/redis-worker";
import type { RedisOptions } from "ioredis";
import { z } from "zod";
import { alertEvaluationJobs } from "./engine/evaluateAlertJob.server";

export function createWorker(redisOptions: RedisOptions) {
  return new Worker({
    name: "alert-lifecycle-test",
    redisOptions: { ...redisOptions, keyPrefix: "alerts:engine:" },
    catalog: {
      "alerts.evaluate": {
        schema: z.object({ alertId: z.string() }),
        visibilityTimeoutMs: 120_000,
        retry: { maxAttempts: 2 },
      },
      "alerts.reconcile": {
        schema: CronSchema,
        visibilityTimeoutMs: 300_000,
        retry: { maxAttempts: 1 },
      },
    },
    jobs: {
      "alerts.evaluate": async () => {},
      "alerts.reconcile": async () => {},
    },
    logger: new Logger("test", "error"),
  });
}

export function depsFor(worker: ReturnType<typeof createWorker>) {
  const jobs = alertEvaluationJobs(worker);
  return { enqueue: jobs.enqueue, ack: jobs.ack };
}
