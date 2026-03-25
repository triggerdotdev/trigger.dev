import { Logger } from "@trigger.dev/core/logger";
import { Worker as RedisWorker } from "@trigger.dev/redis-worker";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { DeliverAlertService } from "./services/alerts/deliverAlert.server";
import { PerformDeploymentAlertsService } from "./services/alerts/performDeploymentAlerts.server";
import { PerformTaskRunAlertsService } from "./services/alerts/performTaskRunAlerts.server";

function initializeWorker() {
  const redisOptions = {
    keyPrefix: "alerts:worker:",
    host: env.ALERTS_WORKER_REDIS_HOST,
    port: env.ALERTS_WORKER_REDIS_PORT,
    username: env.ALERTS_WORKER_REDIS_USERNAME,
    password: env.ALERTS_WORKER_REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.ALERTS_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  };

  logger.debug(`👨‍🏭 Initializing alerts worker at host ${env.ALERTS_WORKER_REDIS_HOST}`);

  const worker = new RedisWorker({
    name: "alerts-worker",
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
        logErrors: false,
      },
      "v3.performDeploymentAlerts": {
        schema: z.object({
          deploymentId: z.string(),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 3,
        },
        logErrors: false,
      },
      "v3.deliverAlert": {
        schema: z.object({
          alertId: z.string(),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 3,
        },
        logErrors: false,
      },
    },
    concurrency: {
      workers: env.ALERTS_WORKER_CONCURRENCY_WORKERS,
      tasksPerWorker: env.ALERTS_WORKER_CONCURRENCY_TASKS_PER_WORKER,
      limit: env.ALERTS_WORKER_CONCURRENCY_LIMIT,
    },
    pollIntervalMs: env.ALERTS_WORKER_POLL_INTERVAL,
    immediatePollIntervalMs: env.ALERTS_WORKER_IMMEDIATE_POLL_INTERVAL,
    shutdownTimeoutMs: env.ALERTS_WORKER_SHUTDOWN_TIMEOUT_MS,
    logger: new Logger("AlertsWorker", env.ALERTS_WORKER_LOG_LEVEL),
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
    },
  });

  if (env.ALERTS_WORKER_ENABLED === "true") {
    logger.debug(
      `👨‍🏭 Starting alerts worker at host ${env.ALERTS_WORKER_REDIS_HOST}, pollInterval = ${env.ALERTS_WORKER_POLL_INTERVAL}, immediatePollInterval = ${env.ALERTS_WORKER_IMMEDIATE_POLL_INTERVAL}, workers = ${env.ALERTS_WORKER_CONCURRENCY_WORKERS}, tasksPerWorker = ${env.ALERTS_WORKER_CONCURRENCY_TASKS_PER_WORKER}, concurrencyLimit = ${env.ALERTS_WORKER_CONCURRENCY_LIMIT}`
    );

    worker.start();
  }

  return worker;
}

export const alertsWorker = singleton("alertsWorker", initializeWorker);
