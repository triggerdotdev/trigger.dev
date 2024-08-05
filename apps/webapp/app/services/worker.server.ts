import { DeliverEmailSchema } from "@/../../packages/emails/src";
import { ScheduledPayloadSchema, addMissingVersionField } from "@trigger.dev/core";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { ZodWorker } from "~/platform/zodWorker.server";
import { MarqsConcurrencyMonitor } from "~/v3/marqs/concurrencyMonitor.server";
import { RequeueV2Message } from "~/v3/marqs/requeueV2Message.server";
import { RequeueTaskRunService } from "~/v3/requeueTaskRun.server";
import { DeliverAlertService } from "~/v3/services/alerts/deliverAlert.server";
import { PerformDeploymentAlertsService } from "~/v3/services/alerts/performDeploymentAlerts.server";
import { PerformTaskAttemptAlertsService } from "~/v3/services/alerts/performTaskAttemptAlerts.server";
import { PerformBulkActionService } from "~/v3/services/bulk/performBulkAction.server";
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
import { TriggerScheduledTaskService } from "~/v3/services/triggerScheduledTask.server";
import { GraphileMigrationHelperService } from "./db/graphileMigrationHelper.server";
import { ExpireDispatcherService } from "./dispatchers/expireDispatcher.server";
import { InvokeEphemeralDispatcherService } from "./dispatchers/invokeEphemeralEventDispatcher.server";
import { sendEmail } from "./email.server";
import { IndexEndpointService } from "./endpoints/indexEndpoint.server";
import { PerformEndpointIndexService } from "./endpoints/performEndpointIndexService";
import { ProbeEndpointService } from "./endpoints/probeEndpoint.server";
import { RecurringEndpointIndexService } from "./endpoints/recurringEndpointIndex.server";
import { DeliverEventService } from "./events/deliverEvent.server";
import { InvokeDispatcherService } from "./events/invokeDispatcher.server";
import { integrationAuthRepository } from "./externalApis/integrationAuthRepository.server";
import { IntegrationConnectionCreatedService } from "./externalApis/integrationConnectionCreated.server";
import { reportInvocationUsage } from "./platform.v3.server";
import { executionRateLimiter } from "./runExecutionRateLimiter.server";
import { DeliverRunSubscriptionService } from "./runs/deliverRunSubscription.server";
import { DeliverRunSubscriptionsService } from "./runs/deliverRunSubscriptions.server";
import { MissingConnectionCreatedService } from "./runs/missingConnectionCreated.server";
import { PerformRunExecutionV3Service } from "./runs/performRunExecutionV3.server";
import { ResumeRunService } from "./runs/resumeRun.server";
import { StartRunService } from "./runs/startRun.server";
import { DeliverScheduledEventService } from "./schedules/deliverScheduledEvent.server";
import { ActivateSourceService } from "./sources/activateSource.server";
import { DeliverHttpSourceRequestService } from "./sources/deliverHttpSourceRequest.server";
import { DeliverWebhookRequestService } from "./sources/deliverWebhookRequest.server";
import { PerformTaskOperationService } from "./tasks/performTaskOperation.server";
import { ProcessCallbackTimeoutService } from "./tasks/processCallbackTimeout.server";
import { ResumeTaskService } from "./tasks/resumeTask.server";

const workerCatalog = {
  indexEndpoint: z.object({
    id: z.string(),
    source: z.enum(["MANUAL", "API", "INTERNAL", "HOOK"]).optional(),
    sourceData: z.any().optional(),
    reason: z.string().optional(),
  }),
  performEndpointIndexing: z.object({
    id: z.string(),
  }),
  scheduleEmail: DeliverEmailSchema,
  startRun: z.object({ id: z.string() }),
  processCallbackTimeout: z.object({
    id: z.string(),
  }),
  deliverHttpSourceRequest: z.object({ id: z.string() }),
  deliverWebhookRequest: z.object({ id: z.string() }),
  refreshOAuthToken: z.object({
    organizationId: z.string(),
    connectionId: z.string(),
  }),
  activateSource: z.preprocess(
    addMissingVersionField,
    z.discriminatedUnion("version", [
      z.object({
        version: z.literal("1"),
        id: z.string(),
        orphanedEvents: z.array(z.string()).optional(),
      }),
      z.object({
        version: z.literal("2"),
        id: z.string(),
        orphanedOptions: z.record(z.string(), z.array(z.string())).optional(),
      }),
    ])
  ),
  deliverEvent: z.object({ id: z.string() }),
  "events.invokeDispatcher": z.object({
    id: z.string(),
    eventRecordId: z.string(),
  }),
  "events.deliverScheduled": z.object({
    id: z.string(),
    payload: ScheduledPayloadSchema,
  }),
  missingConnectionCreated: z.object({
    id: z.string(),
  }),
  connectionCreated: z.object({
    id: z.string(),
  }),
  probeEndpoint: z.object({
    id: z.string(),
  }),
  simulate: z.object({
    seconds: z.number(),
  }),
  deliverRunSubscriptions: z.object({
    id: z.string(),
  }),
  deliverRunSubscription: z.object({
    id: z.string(),
  }),
  resumeTask: z.object({
    id: z.string(),
  }),
  expireDispatcher: z.object({
    id: z.string(),
  }),
  resumeRun: z.object({
    id: z.string(),
  }),
  // v3 tasks
  "v3.indexDeployment": z.object({
    id: z.string(),
  }),
  "v3.resumeTaskRunDependencies": z.object({
    attemptId: z.string(),
  }),
  "v3.resumeBatchRun": z.object({
    batchRunId: z.string(),
    sourceTaskAttemptId: z.string(),
  }),
  "v3.resumeTaskDependency": z.object({
    dependencyId: z.string(),
    sourceTaskAttemptId: z.string(),
  }),
  "v3.timeoutDeployment": z.object({
    deploymentId: z.string(),
    fromStatus: z.string(),
    errorMessage: z.string(),
  }),
  "v3.executeTasksWaitingForDeploy": z.object({
    backgroundWorkerId: z.string(),
  }),
  "v3.triggerScheduledTask": z.object({
    instanceId: z.string(),
  }),
  "v3.performTaskAttemptAlerts": z.object({
    attemptId: z.string(),
  }),
  "v3.deliverAlert": z.object({
    alertId: z.string(),
  }),
  "v3.performDeploymentAlerts": z.object({
    deploymentId: z.string(),
  }),
  "v3.performBulkAction": z.object({
    bulkActionGroupId: z.string(),
  }),
  "v3.performBulkActionItem": z.object({
    bulkActionItemId: z.string(),
  }),
  "v3.requeueTaskRun": z.object({
    runId: z.string(),
  }),
  "v3.retryAttempt": z.object({
    runId: z.string(),
  }),
  "v2.requeueMessage": z.object({
    runId: z.string(),
  }),
  "v3.reportUsage": z.object({
    orgId: z.string(),
    data: z.object({
      costInCents: z.string(),
    }),
    additionalData: z.record(z.any()).optional(),
  }),
  "v3.enqueueDelayedRun": z.object({
    runId: z.string(),
  }),
  "v3.expireRun": z.object({
    runId: z.string(),
  }),
  "v3.cancelTaskAttemptDependencies": z.object({
    attemptId: z.string(),
  }),
};

const executionWorkerCatalog = {
  performRunExecutionV2: z.object({
    id: z.string(),
    reason: z.enum(["EXECUTE_JOB", "PREPROCESS"]),
    resumeTaskId: z.string().optional(),
    isRetry: z.boolean(),
  }),
  performRunExecutionV3: z.object({
    id: z.string(),
    reason: z.enum(["EXECUTE_JOB", "PREPROCESS"]),
  }),
};

const taskOperationWorkerCatalog = {
  performTaskOperation: z.object({
    id: z.string(),
  }),
  invokeEphemeralDispatcher: z.object({
    id: z.string(),
    eventRecordId: z.string(),
  }),
};

let workerQueue: ZodWorker<typeof workerCatalog>;
let executionWorker: ZodWorker<typeof executionWorkerCatalog>;
let taskOperationWorker: ZodWorker<typeof taskOperationWorkerCatalog>;

declare global {
  var __worker__: ZodWorker<typeof workerCatalog>;
  var __executionWorker__: ZodWorker<typeof executionWorkerCatalog>;
  var __taskOperationWorker__: ZodWorker<typeof taskOperationWorkerCatalog>;
}

// this is needed because in development we don't want to restart
// the server with every change, but we want to make sure we don't
// create a new connection to the DB with every change either.
// in production we'll have a single connection to the DB.
if (env.NODE_ENV === "production") {
  workerQueue = getWorkerQueue();
  executionWorker = getExecutionWorkerQueue();
  taskOperationWorker = getTaskOperationWorkerQueue();
} else {
  if (!global.__worker__) {
    global.__worker__ = getWorkerQueue();
  }
  workerQueue = global.__worker__;

  if (!global.__executionWorker__) {
    global.__executionWorker__ = getExecutionWorkerQueue();
  }

  executionWorker = global.__executionWorker__;

  if (!global.__taskOperationWorker__) {
    global.__taskOperationWorker__ = getTaskOperationWorkerQueue();
  }

  taskOperationWorker = global.__taskOperationWorker__;
}

export async function init() {
  const migrationHelper = new GraphileMigrationHelperService();
  await migrationHelper.call();

  if (env.WORKER_ENABLED === "true") {
    await workerQueue.initialize();
  }

  if (env.EXECUTION_WORKER_ENABLED === "true") {
    await executionWorker.initialize();
  }

  if (env.TASK_OPERATION_WORKER_ENABLED === "true") {
    await taskOperationWorker.initialize();
  }
}

function getWorkerQueue() {
  return new ZodWorker({
    name: "workerQueue",
    prisma,
    runnerOptions: {
      connectionString: env.DATABASE_URL,
      concurrency: env.WORKER_CONCURRENCY,
      pollInterval: env.WORKER_POLL_INTERVAL,
      noPreparedStatements: env.DATABASE_URL !== env.DIRECT_URL,
      schema: env.WORKER_SCHEMA,
      maxPoolSize: env.WORKER_CONCURRENCY + 1,
    },
    shutdownTimeoutInMs: env.GRACEFUL_SHUTDOWN_TIMEOUT,
    schema: workerCatalog,
    recurringTasks: {
      // Run this every 5 minutes
      autoIndexProductionEndpoints: {
        match: "*/30 * * * *",
        handler: async (payload, job) => {
          const service = new RecurringEndpointIndexService();

          await service.call(payload.ts);
        },
      },
      scheduleImminentDeferredEvents: {
        match: "*/10 * * * *",
        handler: async (payload, job) => {
          await DeliverScheduledEventService.scheduleImminentDeferredEvents();
        },
      },
      // Run this every hour
      purgeOldIndexings: {
        match: "0 * * * *",
        handler: async (payload, job) => {
          // Delete indexings that are older than 7 days
          await prisma.endpointIndex.deleteMany({
            where: {
              createdAt: {
                lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
              },
            },
          });
        },
      },
      "marqs.v3.queueConcurrencyMonitor": {
        // run every 5 minutes
        match: "*/5 * * * *",
        handler: async (payload, job, helpers) => {
          await MarqsConcurrencyMonitor.initiateV3Monitoring(helpers.abortSignal);
        },
      },
      "marqs.v2.queueConcurrencyMonitor": {
        match: "*/5 * * * *", // run every 5 minutes
        handler: async (payload, job, helpers) => {
          await MarqsConcurrencyMonitor.initiateV2Monitoring(helpers.abortSignal);
        },
      },
    },
    tasks: {
      "events.invokeDispatcher": {
        priority: 0, // smaller number = higher priority
        maxAttempts: 6,
        handler: async (payload, job) => {
          const service = new InvokeDispatcherService();

          await service.call(payload.id, payload.eventRecordId);
        },
      },
      "events.deliverScheduled": {
        priority: 0, // smaller number = higher priority
        maxAttempts: 8,
        handler: async ({ id, payload }, job) => {
          const service = new DeliverScheduledEventService();

          await service.call(id, payload);
        },
      },
      connectionCreated: {
        priority: 10, // smaller number = higher priority
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new IntegrationConnectionCreatedService();

          await service.call(payload.id);
        },
      },
      missingConnectionCreated: {
        priority: 10, // smaller number = higher priority
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new MissingConnectionCreatedService();

          await service.call(payload.id);
        },
      },
      activateSource: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 3,
        handler: async (payload, graphileJob) => {
          const service = new ActivateSourceService();
          switch (payload.version) {
            case "1": {
              //change the input data to match the new schema
              await service.call(
                payload.id,
                graphileJob.id,
                payload.orphanedEvents
                  ? {
                      event: payload.orphanedEvents,
                    }
                  : undefined
              );
              break;
            }
            case "2": {
              await service.call(payload.id, graphileJob.id, payload.orphanedOptions);
              break;
            }
          }
        },
      },
      deliverHttpSourceRequest: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 14,
        handler: async (payload, job) => {
          const service = new DeliverHttpSourceRequestService();

          await service.call(payload.id);
        },
      },
      deliverWebhookRequest: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 14,
        handler: async (payload, job) => {
          const service = new DeliverWebhookRequestService();

          await service.call(payload.id);
        },
      },
      startRun: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 4,
        handler: async (payload, job) => {
          const service = new StartRunService();

          await service.call(payload.id);
        },
      },
      processCallbackTimeout: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new ProcessCallbackTimeoutService();

          await service.call(payload.id);
        },
      },
      scheduleEmail: {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          await sendEmail(payload);
        },
      },
      indexEndpoint: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 7,
        handler: async (payload, job) => {
          const service = new IndexEndpointService();
          await service.call(payload.id, payload.source, payload.reason, payload.sourceData);
        },
      },
      performEndpointIndexing: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 7,
        handler: async (payload, job) => {
          const service = new PerformEndpointIndexService();
          await service.call(payload.id);
        },
      },
      deliverEvent: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new DeliverEventService();

          await service.call(payload.id);
        },
      },
      refreshOAuthToken: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 7,
        handler: async (payload, job) => {
          await integrationAuthRepository.refreshConnection({
            connectionId: payload.connectionId,
          });
        },
      },
      probeEndpoint: {
        priority: 0,
        maxAttempts: 1,
        handler: async (payload, job) => {
          const service = new ProbeEndpointService();

          await service.call(payload.id);
        },
      },
      simulate: {
        maxAttempts: 5,
        handler: async (payload, job) => {
          await new Promise((resolve) => setTimeout(resolve, payload.seconds * 1000));
        },
      },
      deliverRunSubscriptions: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new DeliverRunSubscriptionsService();

          await service.call(payload.id);
        },
      },
      deliverRunSubscription: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 13,
        handler: async (payload, job) => {
          const service = new DeliverRunSubscriptionService();

          await service.call(payload.id);
        },
      },
      resumeTask: {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new ResumeTaskService();

          return await service.call(payload.id);
        },
      },
      expireDispatcher: {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload) => {
          const service = new ExpireDispatcherService();

          return await service.call(payload.id);
        },
      },
      resumeRun: {
        priority: 0,
        maxAttempts: 10,
        handler: async (payload, job) => {
          const service = new ResumeRunService();

          return await service.call(payload.id);
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
      "v3.resumeTaskRunDependencies": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new ResumeTaskRunDependenciesService();

          return await service.call(payload.attemptId);
        },
      },
      "v3.resumeBatchRun": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new ResumeBatchRunService();

          return await service.call(payload.batchRunId, payload.sourceTaskAttemptId);
        },
      },
      "v3.resumeTaskDependency": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new ResumeTaskDependencyService();

          return await service.call(payload.dependencyId, payload.sourceTaskAttemptId);
        },
      },
      "v3.timeoutDeployment": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new TimeoutDeploymentService();

          return await service.call(payload.deploymentId, payload.fromStatus, payload.errorMessage);
        },
      },
      "v3.executeTasksWaitingForDeploy": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new ExecuteTasksWaitingForDeployService();

          return await service.call(payload.backgroundWorkerId);
        },
      },
      "v3.triggerScheduledTask": {
        priority: 0,
        maxAttempts: 3, // total delay of 30 seconds
        handler: async (payload, job) => {
          const service = new TriggerScheduledTaskService();

          return await service.call(payload.instanceId, job.attempts === job.max_attempts);
        },
      },
      "v3.performTaskAttemptAlerts": {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new PerformTaskAttemptAlertsService();

          return await service.call(payload.attemptId);
        },
      },
      "v3.deliverAlert": {
        priority: 0,
        maxAttempts: 8,
        handler: async (payload, job) => {
          const service = new DeliverAlertService();

          return await service.call(payload.alertId);
        },
      },
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
        handler: async (payload, job) => {
          const service = new RequeueTaskRunService();

          await service.call(payload.runId);
        },
      },
      "v3.retryAttempt": {
        priority: 0,
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new RetryAttemptService();

          return await service.call(payload.runId);
        },
      },
      "v2.requeueMessage": {
        priority: 0,
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new RequeueV2Message();

          await service.call(payload.runId);
        },
      },
      "v3.reportUsage": {
        priority: 0,
        maxAttempts: 8,
        handler: async (payload, job) => {
          await reportInvocationUsage(
            payload.orgId,
            Number(payload.data.costInCents),
            payload.additionalData
          );
        },
      },
      "v3.enqueueDelayedRun": {
        priority: 0,
        maxAttempts: 8,
        handler: async (payload, job) => {
          const service = new EnqueueDelayedRunService();

          return await service.call(payload.runId);
        },
      },
      "v3.expireRun": {
        priority: 0,
        maxAttempts: 8,
        handler: async (payload, job) => {
          const service = new ExpireEnqueuedRunService();

          return await service.call(payload.runId);
        },
      },
      "v3.cancelTaskAttemptDependencies": {
        priority: 0,
        maxAttempts: 8,
        handler: async (payload, job) => {
          const service = new CancelTaskAttemptDependenciesService();

          return await service.call(payload.attemptId);
        },
      },
    },
  });
}

function getExecutionWorkerQueue() {
  return new ZodWorker({
    name: "executionWorker",
    prisma,
    runnerOptions: {
      connectionString: env.DATABASE_URL,
      concurrency: env.EXECUTION_WORKER_CONCURRENCY,
      pollInterval: env.EXECUTION_WORKER_POLL_INTERVAL,
      noPreparedStatements: env.DATABASE_URL !== env.DIRECT_URL,
      schema: env.WORKER_SCHEMA,
      maxPoolSize: env.EXECUTION_WORKER_CONCURRENCY + 1,
    },
    shutdownTimeoutInMs: env.GRACEFUL_SHUTDOWN_TIMEOUT,
    schema: executionWorkerCatalog,
    rateLimiter: executionRateLimiter,
    tasks: {
      performRunExecutionV2: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 12,
        handler: async (payload, job) => {
          const service = new PerformRunExecutionV3Service();

          await service.call({
            id: payload.id,
            reason: payload.reason,
            resumeTaskId: payload.resumeTaskId,
            isRetry: payload.isRetry,
            lastAttempt: job.max_attempts === job.attempts,
          });
        },
      },
      performRunExecutionV3: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 12,
        handler: async (payload, job) => {
          const service = new PerformRunExecutionV3Service();

          const driftInMs = Date.now() - job.run_at.getTime();

          await service.call(
            {
              id: payload.id,
              reason: payload.reason,
              isRetry: false,
              lastAttempt: job.max_attempts === job.attempts,
            },
            driftInMs
          );
        },
      },
    },
  });
}

function getTaskOperationWorkerQueue() {
  return new ZodWorker({
    name: "taskOperationWorker",
    prisma,
    runnerOptions: {
      connectionString: env.DATABASE_URL,
      concurrency: env.TASK_OPERATION_WORKER_CONCURRENCY,
      pollInterval: env.TASK_OPERATION_WORKER_POLL_INTERVAL,
      noPreparedStatements: env.DATABASE_URL !== env.DIRECT_URL,
      schema: env.WORKER_SCHEMA,
      maxPoolSize: env.TASK_OPERATION_WORKER_CONCURRENCY + 1,
    },
    shutdownTimeoutInMs: env.GRACEFUL_SHUTDOWN_TIMEOUT,
    schema: taskOperationWorkerCatalog,
    tasks: {
      performTaskOperation: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new PerformTaskOperationService();

          await service.call(payload.id);
        },
      },
      invokeEphemeralDispatcher: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 10,
        handler: async (payload, job) => {
          const service = new InvokeEphemeralDispatcherService();

          await service.call(payload.id, payload.eventRecordId);
        },
      },
    },
  });
}

export { executionWorker, taskOperationWorker, workerQueue };
