import { ZodWorker } from "@internal/zod-worker";
import { DeliverEmailSchema } from "emails";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import {
  BatchProcessingOptions as RunEngineBatchProcessingOptions,
  RunEngineBatchTriggerService,
} from "~/runEngine/services/batchTrigger.server";
import { MarqsConcurrencyMonitor } from "~/v3/marqs/concurrencyMonitor.server";
import { scheduleEngine } from "~/v3/scheduleEngine.server";
import { DeliverAlertService } from "~/v3/services/alerts/deliverAlert.server";
import { PerformDeploymentAlertsService } from "~/v3/services/alerts/performDeploymentAlerts.server";
import { PerformTaskRunAlertsService } from "~/v3/services/alerts/performTaskRunAlerts.server";
import { BatchProcessingOptions, BatchTriggerV3Service } from "~/v3/services/batchTriggerV3.server";
import { PerformBulkActionService } from "~/v3/services/bulk/performBulkAction.server";
import {
  CancelDevSessionRunsService,
  CancelDevSessionRunsServiceOptions,
} from "~/v3/services/cancelDevSessionRuns.server";
import { CancelTaskAttemptDependenciesService } from "~/v3/services/cancelTaskAttemptDependencies.server";
import { EnqueueDelayedRunService } from "~/v3/services/enqueueDelayedRun.server";
import { ExecuteTasksWaitingForDeployService } from "~/v3/services/executeTasksWaitingForDeploy";
import { ExpireEnqueuedRunService } from "~/v3/services/expireEnqueuedRun.server";
import { IndexDeploymentService } from "~/v3/services/indexDeployment.server";
import { ResumeBatchRunService } from "~/v3/services/resumeBatchRun.server";
import { ResumeTaskDependencyService } from "~/v3/services/resumeTaskDependency.server";
import { ResumeTaskRunDependenciesService } from "~/v3/services/resumeTaskRunDependencies.server";
import { RetryAttemptService } from "~/v3/services/retryAttempt.server";
import { TimeoutDeploymentService } from "~/v3/services/timeoutDeployment.server";
import { GraphileMigrationHelperService } from "./db/graphileMigrationHelper.server";
import { sendEmail } from "./email.server";
import { logger } from "./logger.server";

const workerCatalog = {
  // @deprecated, moved to commonWorker.server.ts
  scheduleEmail: DeliverEmailSchema,
  // v3 tasks
  "v3.indexDeployment": z.object({
    id: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.resumeTaskRunDependencies": z.object({
    attemptId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.resumeBatchRun": z.object({
    batchRunId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.resumeTaskDependency": z.object({
    dependencyId: z.string(),
    sourceTaskAttemptId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.timeoutDeployment": z.object({
    deploymentId: z.string(),
    fromStatus: z.string(),
    errorMessage: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.executeTasksWaitingForDeploy": z.object({
    backgroundWorkerId: z.string(),
  }),
  // @deprecated, moved to ScheduleEngine
  "v3.triggerScheduledTask": z.object({
    instanceId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.performTaskRunAlerts": z.object({
    runId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.deliverAlert": z.object({
    alertId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.performDeploymentAlerts": z.object({
    deploymentId: z.string(),
  }),
  "v3.performBulkAction": z.object({
    bulkActionGroupId: z.string(),
  }),
  "v3.performBulkActionItem": z.object({
    bulkActionItemId: z.string(),
  }),
  // @deprecated, moved to legacyRunEngineWorker.server.ts
  "v3.requeueTaskRun": z.object({
    runId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.retryAttempt": z.object({
    runId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.enqueueDelayedRun": z.object({
    runId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.expireRun": z.object({
    runId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.cancelTaskAttemptDependencies": z.object({
    attemptId: z.string(),
  }),
  // @deprecated, moved to commonWorker.server.ts
  "v3.cancelDevSessionRuns": CancelDevSessionRunsServiceOptions,
  // @deprecated, moved to commonWorker.server.ts
  "v3.processBatchTaskRun": BatchProcessingOptions,
  // @deprecated, moved to commonWorker.server.ts
  "runengine.processBatchTaskRun": RunEngineBatchProcessingOptions,
};

let workerQueue: ZodWorker<typeof workerCatalog>;

declare global {
  var __worker__: ZodWorker<typeof workerCatalog>;
}

// this is needed because in development we don't want to restart
// the server with every change, but we want to make sure we don't
// create a new connection to the DB with every change either.
// in production we'll have a single connection to the DB.
if (env.NODE_ENV === "production") {
  workerQueue = getWorkerQueue();
} else {
  if (!global.__worker__) {
    global.__worker__ = getWorkerQueue();
  }
  workerQueue = global.__worker__;
}

export async function init() {
  const migrationHelper = new GraphileMigrationHelperService();
  await migrationHelper.call();

  if (env.WORKER_ENABLED === "true") {
    await workerQueue.initialize();
  }
}

function getWorkerQueue() {
  return new ZodWorker({
    name: "workerQueue",
    prisma,
    replica: $replica,
    runnerOptions: {
      connectionString: env.DATABASE_URL,
      concurrency: env.WORKER_CONCURRENCY,
      pollInterval: env.WORKER_POLL_INTERVAL,
      noPreparedStatements: env.DATABASE_URL !== env.DIRECT_URL,
      schema: env.WORKER_SCHEMA,
      maxPoolSize: env.WORKER_CONCURRENCY + 1,
    },
    logger: logger,
    shutdownTimeoutInMs: env.GRACEFUL_SHUTDOWN_TIMEOUT,
    schema: workerCatalog,
    recurringTasks: {
      "marqs.v3.queueConcurrencyMonitor": {
        // run every 5 minutes
        match: "*/5 * * * *",
        handler: async (payload, job, helpers) => {
          await MarqsConcurrencyMonitor.initiateV3Monitoring(helpers.abortSignal);
        },
      },
    },
    tasks: {
      // @deprecated, moved to commonWorker.server.ts
      scheduleEmail: {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          await sendEmail(payload);
        },
      },
      // v3 tasks
      "v3.indexDeployment": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new IndexDeploymentService();

          return await service.call(payload.id);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.resumeTaskRunDependencies": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new ResumeTaskRunDependenciesService();

          return await service.call(payload.attemptId);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.resumeBatchRun": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new ResumeBatchRunService();

          await service.call(payload.batchRunId);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.resumeTaskDependency": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new ResumeTaskDependencyService();

          return await service.call(payload.dependencyId, payload.sourceTaskAttemptId);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.timeoutDeployment": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new TimeoutDeploymentService();

          return await service.call(payload.deploymentId, payload.fromStatus, payload.errorMessage);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.executeTasksWaitingForDeploy": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new ExecuteTasksWaitingForDeployService();

          return await service.call(payload.backgroundWorkerId);
        },
      },
      // @deprecated, moved to ScheduleEngine
      "v3.triggerScheduledTask": {
        priority: 0,
        maxAttempts: 3, // total delay of 30 seconds
        handler: async (payload, job) => {
          await scheduleEngine.triggerScheduledTask({
            instanceId: payload.instanceId,
            finalAttempt: job.attempts === job.max_attempts,
          });
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.performTaskRunAlerts": {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new PerformTaskRunAlertsService();
          return await service.call(payload.runId);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.deliverAlert": {
        priority: 0,
        maxAttempts: 8,
        handler: async (payload, job) => {
          const service = new DeliverAlertService();

          return await service.call(payload.alertId);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.performDeploymentAlerts": {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new PerformDeploymentAlertsService();

          return await service.call(payload.deploymentId);
        },
      },
      "v3.performBulkAction": {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new PerformBulkActionService();

          return await service.call(payload.bulkActionGroupId);
        },
      },
      "v3.performBulkActionItem": {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new PerformBulkActionService();

          await service.performBulkActionItem(payload.bulkActionItemId);
        },
      },
      "v3.requeueTaskRun": {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {}, // This is now handled by redisWorker
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.retryAttempt": {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new RetryAttemptService();

          return await service.call(payload.runId);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.enqueueDelayedRun": {
        priority: 0,
        maxAttempts: 8,
        handler: async (payload, job) => {
          const service = new EnqueueDelayedRunService();

          return await service.call(payload.runId);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.expireRun": {
        priority: 0,
        maxAttempts: 8,
        handler: async (payload, job) => {
          const service = new ExpireEnqueuedRunService();

          return await service.call(payload.runId);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.cancelTaskAttemptDependencies": {
        priority: 0,
        maxAttempts: 8,
        handler: async (payload, job) => {
          const service = new CancelTaskAttemptDependenciesService();

          return await service.call(payload.attemptId);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.cancelDevSessionRuns": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new CancelDevSessionRunsService();

          return await service.call(payload);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "v3.processBatchTaskRun": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new BatchTriggerV3Service(payload.strategy);

          await service.processBatchTaskRun(payload);
        },
      },
      // @deprecated, moved to commonWorker.server.ts
      "runengine.processBatchTaskRun": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new RunEngineBatchTriggerService(payload.strategy);

          await service.processBatchTaskRun(payload);
        },
      },
    },
  });
}
export { workerQueue };
