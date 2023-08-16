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
import { PerformRunExecutionService } from "./runs/performRunExecution.server";
import { StartQueuedRunsService } from "./runs/startQueuedRuns.server";
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
  performRunExecution: z.object({
    id: z.string(),
  }),
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
  startQueuedRuns: z.object({ id: z.string() }),
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
  await workerQueue.initialize();
}

function getWorkerQueue() {
  return new ZodWorker({
    prisma,
    runnerOptions: {
      connectionString: env.DATABASE_URL,
      concurrency: env.WORKER_CONCURRENCY,
      pollInterval: env.WORKER_POLL_INTERVAL,
      noPreparedStatements: env.DATABASE_URL !== env.DIRECT_URL,
      schema: env.WORKER_SCHEMA,
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
      startQueuedRuns: {
        priority: 1, // smaller number = higher priority
        maxAttempts: 3,
        jobKeyMode: "replace",
        jobKey: (payload) => `startQueuedRuns:${payload.id}`,
        handler: async (payload, job) => {
          const service = new StartQueuedRunsService();

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
        maxAttempts: 25,
        handler: async (payload, job) => {
          const service = new DeliverHttpSourceRequestService();

          await service.call(payload.id);
        },
      },
      startRun: {
        priority: 0, // smaller number = higher priority
        maxAttempts: 8,
        handler: async (payload, job) => {
          const service = new StartRunService();

          await service.call(payload.id);
        },
      },
      performRunExecution: {
        priority: 0, // smaller number = higher priority
        queueName: (payload) => `runs:${payload.id}`,
        maxAttempts: 1,
        handler: async (payload, job) => {
          const service = new PerformRunExecutionService();

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
        handler: async (payload, job) => {
          const service = new IndexEndpointService();

          await service.call(payload.id, payload.source, payload.reason, payload.sourceData);
        },
      },
      deliverEvent: {
        priority: 0, // smaller number = higher priority
        handler: async (payload, job) => {
          const service = new DeliverEventService();

          await service.call(payload.id);
        },
      },
      refreshOAuthToken: {
        priority: 8, // smaller number = higher priority
        queueName: "internal-queue",
        maxAttempts: 10,
        handler: async (payload, job) => {
          await integrationAuthRepository.refreshConnection({
            connectionId: payload.connectionId,
          });
        },
      },
    },
  });
}

export { workerQueue };
