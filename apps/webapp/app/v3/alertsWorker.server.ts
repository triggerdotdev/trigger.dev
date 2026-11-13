import { Logger } from "@trigger.dev/core/logger";
import { Worker as RedisWorker } from "@trigger.dev/redis-worker";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { isAlertsConfigured } from "./services/alerts/alertsConfigured.server";
import { DeliverAlertService } from "./services/alerts/deliverAlert.server";
import { DeliverErrorGroupAlertService } from "./services/alerts/deliverErrorGroupAlert.server";
import { ErrorAlertEvaluator } from "./services/alerts/errorAlertEvaluator.server";
import { prisma } from "~/db.server";
import { DeliverAlertEventPayload } from "./services/alerts/delivery/deliverAlertEventPayload";
import { deliverAlertEvent } from "./services/alerts/delivery/deliverAlertEvent.server";
import { gateAlertJob } from "./services/alerts/engine/gateAlertJob";
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

  const alertsConfigured = isAlertsConfigured({
    alertsEnabled: env.ALERTS_ENABLED,
  });

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
      "v3.evaluateErrorAlerts": {
        schema: z.object({
          projectId: z.string(),
          scheduledAt: z.number(),
        }),
        visibilityTimeoutMs: 60_000 * 5,
        retry: {
          maxAttempts: 3,
        },
        logErrors: true,
      },
      "v3.deliverErrorGroupAlert": {
        schema: z.object({
          channelId: z.string(),
          projectId: z.string(),
          classification: z.enum(["new_issue", "regression", "unignored"]),
          error: z.object({
            fingerprint: z.string(),
            environmentId: z.string(),
            environmentSlug: z.string(),
            environmentName: z.string(),
            taskIdentifier: z.string(),
            errorType: z.string(),
            errorMessage: z.string(),
            sampleStackTrace: z.string(),
            firstSeen: z.string(),
            lastSeen: z.string(),
            occurrenceCount: z.number(),
          }),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 3,
        },
        logErrors: true,
      },
      // @deprecated, the legacy agent watch is gone; remove once the queue drains.
      "v3.deliverDashboardAgentWatchAlert": {
        schema: z.unknown(),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 1,
        },
      },
      "v3.deliverDashboardAgentWatchAlertChannel": {
        schema: z.unknown(),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 1,
        },
      },
      "v3.deliverAlertEvent": {
        schema: DeliverAlertEventPayload,
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 3,
        },
        logErrors: true,
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
      "v3.evaluateErrorAlerts": async ({ payload }) => {
        const evaluator = new ErrorAlertEvaluator();
        await evaluator.evaluate(payload.projectId, payload.scheduledAt);
      },
      "v3.deliverErrorGroupAlert": async ({ payload }) => {
        const service = new DeliverErrorGroupAlertService();
        await service.call(payload);
      },
      "v3.deliverDashboardAgentWatchAlert": async () => {},
      "v3.deliverDashboardAgentWatchAlertChannel": async () => {},
      "v3.deliverAlertEvent": gateAlertJob(alertsConfigured, async ({ payload }) => {
        await deliverAlertEvent(payload.eventId, payload.eventAt, { db: prisma });
      }),
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
