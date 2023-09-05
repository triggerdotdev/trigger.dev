import { DeliverEmailSchema } from "@/../../packages/emails/src";
import { ScheduledPayloadSchema } from "@trigger.dev/core";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { ZodWorker } from "~/platform/zodWorker.server";
import { sendEmail } from "./email.server";
import { IndexEndpointService } from "./endpoints/indexEndpoint.server";
import { RecurringEndpointIndexService } from "./endpoints/recurringEndpointIndex.server";
import { DeliverEventService } from "./events/deliverEvent.server";
import { InvokeDispatcherService } from "./events/invokeDispatcher.server";
import { integrationAuthRepository } from "./externalApis/integrationAuthRepository.server";
import { IntegrationConnectionCreatedService } from "./externalApis/integrationConnectionCreated.server";
import { MissingConnectionCreatedService } from "./runs/missingConnectionCreated.server";
import { PerformRunExecutionV1Service } from "./runs/performRunExecutionV1.server";
import { PerformRunExecutionV2Service } from "./runs/performRunExecutionV2.server";
import { StartRunService } from "./runs/startRun.server";
import { DeliverScheduledEventService } from "./schedules/deliverScheduledEvent.server";
import { ActivateSourceService } from "./sources/activateSource.server";
import { DeliverHttpSourceRequestService } from "./sources/deliverHttpSourceRequest.server";
import { PerformTaskOperationService } from "./tasks/performTaskOperation.server";

const workerCatalog = {
  indexEndpoint: z.object({
    id: z.string(),
    source: z.enum(["MANUAL", "API", "INTERNAL", "HOOK"]).optional(),
    sourceData: z.any().optional(),
    reason: z.string().optional(),
  }),
  scheduleEmail: DeliverEmailSchema,
  startRun: z.object({ id: z.string() }),
  performTaskOperation: z.object({
    id: z.string(),
  }),
  deliverHttpSourceRequest: z.object({ id: z.string() }),
  refreshOAuthToken: z.object({
    organizationId: z.string(),
    connectionId: z.string(),
  }),
  activateSource: z.object({
    id: z.string(),
    orphanedEvents: z.array(z.string()).optional(),
  }),

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
};

const executionWorkerCatalog = {
  performRunExecution: z.object({
    id: z.string(),
  }),
  performRunExecutionV2: z.object({
    id: z.string(),
    reason: z.enum(["EXECUTE_JOB", "PREPROCESS"]),
    resumeTaskId: z.string().optional(),
    isRetry: z.boolean(),
  }),
};

let workerQueue: ZodWorker<typeof workerCatalog>;
let executionWorker: ZodWorker<typeof executionWorkerCatalog>;

declare global {
  var __worker__: ZodWorker<typeof workerCatalog>;
  var __executionWorker__: ZodWorker<typeof executionWorkerCatalog>;
}

// this is needed because in development we don't want to restart
// the server with every change, but we want to make sure we don't
// create a new connection to the DB with every change either.
// in production we'll have a single connection to the DB.
if (env.NODE_ENV === "production") {
  workerQueue = getWorkerQueue();
  executionWorker = getExecutionWorkerQueue();
} else {
  if (!global.__worker__) {
    global.__worker__ = getWorkerQueue();
  }
  workerQueue = global.__worker__;

  if (!global.__executionWorker__) {
    global.__executionWorker__ = getExecutionWorkerQueue();
  }

  executionWorker = global.__executionWorker__;
}

export async function init() {
  if (env.WORKER_ENABLED === "true") {
    await workerQueue.initialize();
  }

  if (env.EXECUTION_WORKER_ENABLED === "true") {
    await executionWorker.initialize();
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
      maxPoolSize: env.WORKER_CONCURRENCY,
    },
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
        maxAttempts: 3,
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
        handler: async (payload, job) => {
          const service = new ActivateSourceService();

          await service.call(payload.id, job.id, payload.orphanedEvents);
        },
      },
      deliverHttpSourceRequest: {
        priority: 1, // smaller number = higher priority
        maxAttempts: 14,
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
      performTaskOperation: {
        priority: 0, // smaller number = higher priority
        queueName: (payload) => `tasks:${payload.id}`,
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new PerformTaskOperationService();

          await service.call(payload.id);
        },
      },
      scheduleEmail: {
        queueName: "internal-queue",
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
        queueName: "internal-queue",
        maxAttempts: 7,
        handler: async (payload, job) => {
          await integrationAuthRepository.refreshConnection({
            connectionId: payload.connectionId,
          });
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
    schema: executionWorkerCatalog,
    tasks: {
      performRunExecution: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 1,
        handler: async (payload, job) => {
          // This is a legacy task that we don't use anymore, but needs to be here for backwards compatibility
          // TODO: remove this once all performRunExecution tasks have been processed
          const service = new PerformRunExecutionV1Service();

          await service.call(payload.id);
        },
      },
      performRunExecutionV2: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 12,
        handler: async (payload, job) => {
          const service = new PerformRunExecutionV2Service();

          await service.call({
            id: payload.id,
            reason: payload.reason,
            resumeTaskId: payload.resumeTaskId,
            isRetry: payload.isRetry,
          });
        },
      },
    },
  });
}

export { executionWorker, workerQueue };
