import { DeliverEmailSchema } from "@/../../packages/emails/src";
import { ScheduledPayloadSchema, addMissingVersionField } from "@trigger.dev/core";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { RedisGraphileRateLimiter, ZodWorker } from "~/platform/zodWorker.server";
import { sendEmail } from "./email.server";
import { IndexEndpointService } from "./endpoints/indexEndpoint.server";
import { PerformEndpointIndexService } from "./endpoints/performEndpointIndexService";
import { RecurringEndpointIndexService } from "./endpoints/recurringEndpointIndex.server";
import { DeliverEventService } from "./events/deliverEvent.server";
import { InvokeDispatcherService } from "./events/invokeDispatcher.server";
import { integrationAuthRepository } from "./externalApis/integrationAuthRepository.server";
import { IntegrationConnectionCreatedService } from "./externalApis/integrationConnectionCreated.server";
import { MissingConnectionCreatedService } from "./runs/missingConnectionCreated.server";
import { PerformRunExecutionV3Service } from "./runs/performRunExecutionV3.server";
import { StartRunService } from "./runs/startRun.server";
import { DeliverScheduledEventService } from "./schedules/deliverScheduledEvent.server";
import { ActivateSourceService } from "./sources/activateSource.server";
import { DeliverHttpSourceRequestService } from "./sources/deliverHttpSourceRequest.server";
import { PerformTaskOperationService } from "./tasks/performTaskOperation.server";
import { ProcessCallbackTimeoutService } from "./tasks/processCallbackTimeout.server";
import { ProbeEndpointService } from "./endpoints/probeEndpoint.server";
import { DeliverRunSubscriptionService } from "./runs/deliverRunSubscription.server";
import { DeliverRunSubscriptionsService } from "./runs/deliverRunSubscriptions.server";
import { ResumeTaskService } from "./tasks/resumeTask.server";
import { ExpireDispatcherService } from "./dispatchers/expireDispatcher.server";
import { InvokeEphemeralDispatcherService } from "./dispatchers/invokeEphemeralEventDispatcher.server";
import { ResumeRunService } from "./runs/resumeRun.server";

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
  // const pgNotify = new PgNotifyService();
  // await pgNotify.call("trigger:graphile:migrate", { latestMigration: 10 });
  // await new Promise((resolve) => setTimeout(resolve, 10000))

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
    cleanup: {
      frequencyExpression: "13,27,43 * * * *",
      ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
      maxCount: 1000,
    },
    runnerOptions: {
      connectionString: env.DATABASE_URL,
      concurrency: env.WORKER_CONCURRENCY,
      pollInterval: env.WORKER_POLL_INTERVAL,
      noPreparedStatements: env.DATABASE_URL !== env.DIRECT_URL,
      schema: env.WORKER_SCHEMA,
      maxPoolSize: env.WORKER_CONCURRENCY,
    },
    shutdownTimeoutInMs: env.GRACEFUL_SHUTDOWN_TIMEOUT,
    schema: workerCatalog,
    recurringTasks: {
      // Run this every 5 minutes
      autoIndexProductionEndpoints: {
        pattern: "*/5 * * * *",
        handler: async (payload, job) => {
          const service = new RecurringEndpointIndexService();

          await service.call(payload.ts);
        },
      },
      // Run this every hour
      purgeOldIndexings: {
        pattern: "0 * * * *",
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
        maxAttempts: 5,
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
        priority: 10, // smaller number = higher priority
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
        priority: 1, // smaller number = higher priority
        maxAttempts: 14,
        queueName: (payload) => `sources:${payload.id}`,
        handler: async (payload, job) => {
          const service = new DeliverHttpSourceRequestService();

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
        priority: 100,
        maxAttempts: 3,
        handler: async (payload, job) => {
          await sendEmail(payload);
        },
      },
      indexEndpoint: {
        priority: 1, // smaller number = higher priority
        maxAttempts: 7,
        handler: async (payload, job) => {
          const service = new IndexEndpointService();
          await service.call(payload.id, payload.source, payload.reason, payload.sourceData);
        },
      },
      performEndpointIndexing: {
        priority: 1, // smaller number = higher priority
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
        priority: 8, // smaller number = higher priority
        maxAttempts: 7,
        handler: async (payload, job) => {
          await integrationAuthRepository.refreshConnection({
            connectionId: payload.connectionId,
          });
        },
      },
      probeEndpoint: {
        priority: 10,
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
        priority: 1, // smaller number = higher priority
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new DeliverRunSubscriptionsService();

          await service.call(payload.id);
        },
      },
      deliverRunSubscription: {
        priority: 1, // smaller number = higher priority
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
        priority: 10,
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
      maxPoolSize: env.EXECUTION_WORKER_CONCURRENCY,
    },
    shutdownTimeoutInMs: env.GRACEFUL_SHUTDOWN_TIMEOUT,
    schema: executionWorkerCatalog,
    rateLimiter: new RedisGraphileRateLimiter(),
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
      maxPoolSize: env.TASK_OPERATION_WORKER_CONCURRENCY,
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

export { executionWorker, workerQueue, taskOperationWorker };
