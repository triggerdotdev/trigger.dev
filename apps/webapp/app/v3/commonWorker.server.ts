import { Worker as RedisWorker } from "@trigger.dev/redis-worker";
import { Logger } from "@trigger.dev/core/logger";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { DeliverAlertService } from "./services/alerts/deliverAlert.server";
import { PerformDeploymentAlertsService } from "./services/alerts/performDeploymentAlerts.server";
import { PerformTaskRunAlertsService } from "./services/alerts/performTaskRunAlerts.server";
import { ExpireEnqueuedRunService } from "./services/expireEnqueuedRun.server";
import { EnqueueDelayedRunService } from "./services/enqueueDelayedRun.server";

function initializeWorker() {
  const redisOptions = {
    keyPrefix: "common:worker:",
    host: env.COMMON_WORKER_REDIS_HOST,
    port: env.COMMON_WORKER_REDIS_PORT,
    username: env.COMMON_WORKER_REDIS_USERNAME,
    password: env.COMMON_WORKER_REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.COMMON_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  };

  logger.debug(`👨‍🏭 Initializing common worker at host ${env.COMMON_WORKER_REDIS_HOST}`);

  const worker = new RedisWorker({
    name: "common-worker",
    redisOptions,
    catalog: {
      "v3.performTaskRunAlerts": {
        schema: z.object({
          runId: z.string(),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 3,
        },
      },
      "v3.performDeploymentAlerts": {
        schema: z.object({
          deploymentId: z.string(),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 3,
        },
      },
      "v3.deliverAlert": {
        schema: z.object({
          alertId: z.string(),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 3,
        },
      },
      "v3.expireRun": {
        schema: z.object({
          runId: z.string(),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 6,
        },
      },
      "v3.enqueueDelayedRun": {
        schema: z.object({
          runId: z.string(),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 6,
        },
      },
    },
    concurrency: {
      workers: env.COMMON_WORKER_CONCURRENCY_WORKERS,
      tasksPerWorker: env.COMMON_WORKER_CONCURRENCY_TASKS_PER_WORKER,
      limit: env.COMMON_WORKER_CONCURRENCY_LIMIT,
    },
    pollIntervalMs: env.COMMON_WORKER_POLL_INTERVAL,
    immediatePollIntervalMs: env.COMMON_WORKER_IMMEDIATE_POLL_INTERVAL,
    shutdownTimeoutMs: env.COMMON_WORKER_SHUTDOWN_TIMEOUT_MS,
    logger: new Logger("CommonWorker", "debug"),
    jobs: {
      "v3.deliverAlert": async ({ payload }) => {
        const service = new DeliverAlertService();

        await service.call(payload.alertId);
      },
      "v3.performDeploymentAlerts": async ({ payload }) => {
        const service = new PerformDeploymentAlertsService();

        await service.call(payload.deploymentId);
      },
      "v3.performTaskRunAlerts": async ({ payload }) => {
        const service = new PerformTaskRunAlertsService();
        await service.call(payload.runId);
      },
      "v3.expireRun": async ({ payload }) => {
        const service = new ExpireEnqueuedRunService();

        await service.call(payload.runId);
      },
      "v3.enqueueDelayedRun": async ({ payload }) => {
        const service = new EnqueueDelayedRunService();

        await service.call(payload.runId);
      },
    },
  });

  if (env.COMMON_WORKER_ENABLED === "true") {
    logger.debug(
      `👨‍🏭 Starting common worker at host ${env.COMMON_WORKER_REDIS_HOST}, pollInterval = ${env.COMMON_WORKER_POLL_INTERVAL}, immediatePollInterval = ${env.COMMON_WORKER_IMMEDIATE_POLL_INTERVAL}, workers = ${env.COMMON_WORKER_CONCURRENCY_WORKERS}, tasksPerWorker = ${env.COMMON_WORKER_CONCURRENCY_TASKS_PER_WORKER}, concurrencyLimit = ${env.COMMON_WORKER_CONCURRENCY_LIMIT}`
    );

    worker.start();
  }

  return worker;
}

export const commonWorker = singleton("commonWorker", initializeWorker);
