import { Logger } from "@trigger.dev/core/logger";
import { Worker as RedisWorker } from "@trigger.dev/redis-worker";
import { DeliverEmailSchema } from "emails";
import { z } from "zod";
import { env } from "~/env.server";
import { RunEngineBatchTriggerService } from "~/runEngine/services/batchTrigger.server";
import { sendEmail } from "~/services/email.server";
import {
  AttioUserSyncSchema,
  AttioWorkspaceSyncSchema,
  runAttioUserSync,
  runAttioWorkspaceSync,
} from "~/services/attio.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { DeliverAlertService } from "./services/alerts/deliverAlert.server";
import { PerformDeploymentAlertsService } from "./services/alerts/performDeploymentAlerts.server";
import { PerformTaskRunAlertsService } from "./services/alerts/performTaskRunAlerts.server";
import { BatchTriggerV3Service } from "./services/batchTriggerV3.server";
import { TimeoutDeploymentService } from "./services/timeoutDeployment.server";
import { BulkActionService } from "./services/bulk/BulkActionV2.server";

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
      scheduleEmail: {
        schema: DeliverEmailSchema,
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 3,
        },
      },
      "attio.syncWorkspace": {
        schema: AttioWorkspaceSyncSchema,
        visibilityTimeoutMs: 30_000,
        retry: {
          maxAttempts: 3,
        },
      },
      "attio.syncUser": {
        schema: AttioUserSyncSchema,
        visibilityTimeoutMs: 30_000,
        retry: {
          maxAttempts: 3,
        },
      },
      "v3.timeoutDeployment": {
        schema: z.object({
          deploymentId: z.string(),
          fromStatus: z.string(),
          errorMessage: z.string(),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 5,
        },
      },
      // @deprecated, moved to batchTriggerWorker.server.ts
      "v3.processBatchTaskRun": {
        schema: z.object({
          batchId: z.string(),
          processingId: z.string(),
          range: z.object({ start: z.number().int(), count: z.number().int() }),
          attemptCount: z.number().int(),
          strategy: z.enum(["sequential", "parallel"]),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 5,
        },
      },
      // @deprecated, moved to batchTriggerWorker.server.ts
      "runengine.processBatchTaskRun": {
        schema: z.object({
          batchId: z.string(),
          processingId: z.string(),
          range: z.object({ start: z.number().int(), count: z.number().int() }),
          attemptCount: z.number().int(),
          strategy: z.enum(["sequential", "parallel"]),
          parentRunId: z.string().optional(),
          resumeParentOnCompletion: z.boolean().optional(),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 5,
        },
      },
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
      processBulkAction: {
        schema: z.object({
          bulkActionId: z.string(),
        }),
        visibilityTimeoutMs: 180_000,
        retry: {
          maxAttempts: 5,
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
    logger: new Logger("CommonWorker", env.COMMON_WORKER_LOG_LEVEL),
    jobs: {
      scheduleEmail: async ({ payload }) => {
        await sendEmail(payload);
      },
      "attio.syncWorkspace": async ({ payload }) => {
        await runAttioWorkspaceSync(payload);
      },
      "attio.syncUser": async ({ payload }) => {
        await runAttioUserSync(payload);
      },
      "v3.timeoutDeployment": async ({ payload }) => {
        const service = new TimeoutDeploymentService();
        await service.call(payload.deploymentId, payload.fromStatus, payload.errorMessage);
      },
      // @deprecated, moved to batchTriggerWorker.server.ts
      "v3.processBatchTaskRun": async ({ payload }) => {
        const service = new BatchTriggerV3Service(payload.strategy);
        await service.processBatchTaskRun(payload);
      },
      // @deprecated, moved to batchTriggerWorker.server.ts
      "runengine.processBatchTaskRun": async ({ payload }) => {
        const service = new RunEngineBatchTriggerService(payload.strategy);
        await service.processBatchTaskRun(payload);
      },
      // @deprecated, moved to alertsWorker.server.ts
      "v3.deliverAlert": async ({ payload }) => {
        const service = new DeliverAlertService();

        await service.call(payload.alertId);
      },
      // @deprecated, moved to alertsWorker.server.ts
      "v3.performDeploymentAlerts": async ({ payload }) => {
        const service = new PerformDeploymentAlertsService();

        await service.call(payload.deploymentId);
      },
      // @deprecated, moved to alertsWorker.server.ts
      "v3.performTaskRunAlerts": async ({ payload }) => {
        const service = new PerformTaskRunAlertsService();
        await service.call(payload.runId);
      },
      processBulkAction: async ({ payload }) => {
        const service = new BulkActionService();
        await service.process(payload.bulkActionId);
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
