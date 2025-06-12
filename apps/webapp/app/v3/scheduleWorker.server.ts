import { Worker as RedisWorker } from "@trigger.dev/redis-worker";
import { Logger } from "@trigger.dev/core/logger";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { TriggerScheduledTaskService } from "./services/triggerScheduledTask.server";
import { calculateDistributedExecutionTime as calculateDistributedExecutionTimeUtil } from "./utils/distributedScheduling.server";

function initializeWorker() {
  const redisOptions = {
    keyPrefix: "schedule:worker:",
    host: env.SCHEDULE_WORKER_REDIS_HOST,
    port: env.SCHEDULE_WORKER_REDIS_PORT,
    username: env.SCHEDULE_WORKER_REDIS_USERNAME,
    password: env.SCHEDULE_WORKER_REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.SCHEDULE_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  };

  logger.debug(`📅 Initializing schedule worker at host ${env.SCHEDULE_WORKER_REDIS_HOST}`);

  const worker = new RedisWorker({
    name: "schedule-worker",
    redisOptions,
    catalog: {
      "schedule.triggerScheduledTask": {
        schema: z.object({
          instanceId: z.string(),
          exactScheduleTime: z.coerce.date(),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 5,
        },
      },
    },
    concurrency: {
      workers: env.SCHEDULE_WORKER_CONCURRENCY_WORKERS,
      tasksPerWorker: env.SCHEDULE_WORKER_CONCURRENCY_TASKS_PER_WORKER,
      limit: env.SCHEDULE_WORKER_CONCURRENCY_LIMIT,
    },
    pollIntervalMs: env.SCHEDULE_WORKER_POLL_INTERVAL,
    immediatePollIntervalMs: env.SCHEDULE_WORKER_IMMEDIATE_POLL_INTERVAL,
    shutdownTimeoutMs: env.SCHEDULE_WORKER_SHUTDOWN_TIMEOUT_MS,
    logger: new Logger("ScheduleWorker", "debug"),
    jobs: {
      "schedule.triggerScheduledTask": async ({ payload }) => {
        const service = new TriggerScheduledTaskService();

        // Pass false for final attempt since Redis worker handles retries differently than graphile
        // The exactScheduleTime will be used as the queueTimestamp in the triggered task
        await service.call(payload.instanceId, false, payload.exactScheduleTime);
      },
    },
  });

  if (env.SCHEDULE_WORKER_ENABLED === "true") {
    logger.debug(
      `📅 Starting schedule worker at host ${env.SCHEDULE_WORKER_REDIS_HOST}, pollInterval = ${env.SCHEDULE_WORKER_POLL_INTERVAL}, immediatePollInterval = ${env.SCHEDULE_WORKER_IMMEDIATE_POLL_INTERVAL}, workers = ${env.SCHEDULE_WORKER_CONCURRENCY_WORKERS}, tasksPerWorker = ${env.SCHEDULE_WORKER_CONCURRENCY_TASKS_PER_WORKER}, concurrencyLimit = ${env.SCHEDULE_WORKER_CONCURRENCY_LIMIT}, distributionWindow = ${env.SCHEDULE_WORKER_DISTRIBUTION_WINDOW_SECONDS}s`
    );

    worker.start();
  }

  return worker;
}

export const scheduleWorker = singleton("scheduleWorker", initializeWorker);

/**
 * Calculates a distributed execution time within the configured distribution window
 * before the exact schedule time. This helps spread the load across time instead of
 * having all scheduled tasks execute at exactly the same moment.
 */
export function calculateDistributedExecutionTime(exactScheduleTime: Date): Date {
  return calculateDistributedExecutionTimeUtil(
    exactScheduleTime,
    env.SCHEDULE_WORKER_DISTRIBUTION_WINDOW_SECONDS
  );
}

/**
 * Enqueues a scheduled task to be executed at a distributed time before the exact schedule time,
 * but ensures the task is triggered with the correct exact schedule time.
 */
export async function enqueueScheduledTask(instanceId: string, exactScheduleTime: Date) {
  const distributedExecutionTime = calculateDistributedExecutionTime(exactScheduleTime);

  logger.debug("Enqueuing scheduled task with distributed execution", {
    instanceId,
    exactScheduleTime: exactScheduleTime.toISOString(),
    distributedExecutionTime: distributedExecutionTime.toISOString(),
    distributionOffsetMs: exactScheduleTime.getTime() - distributedExecutionTime.getTime(),
  });

  await scheduleWorker.enqueue({
    id: `scheduled-task-instance:${instanceId}`,
    job: "schedule.triggerScheduledTask",
    payload: {
      instanceId,
      exactScheduleTime,
    },
    availableAt: distributedExecutionTime,
  });
}
