import { GetJobResponseSchema } from "@/../../packages/internal/src";
import { z } from "zod";
import { env } from "~/env.server";
import { ZodWorker } from "~/platform/zodWorker.server";
import { EndpointRegisteredService } from "./endpoints/endpointRegistered.server";
import { PrepareJobInstanceService } from "./endpoints/prepareJobInstance.server";
import { DeliverEventService } from "./events/deliverEvent.server";
import { apiConnectionRepository } from "./externalApis/apiAuthenticationRepository.server";
import { RegisterJobService } from "./jobs/registerJob.server";
import { ResumeTaskService } from "./runs/resumeTask.server";
import { StartRunService } from "./runs/startRun.server";
import { DeliverHttpSourceRequestService } from "./sources/deliverHttpSourceRequest.server";
import { PrepareTriggerVariantService } from "./endpoints/prepareTriggerVariant.server";

const workerCatalog = {
  organizationCreated: z.object({ id: z.string() }),
  endpointRegistered: z.object({ id: z.string() }),
  deliverEvent: z.object({ id: z.string() }),
  deliverEmail: z.object({
    email: z.string(),
    to: z.string(),
    name: z.string().optional(),
  }),
  githubAppInstallationDeleted: z.object({ id: z.string() }),
  githubPush: z.object({
    branch: z.string(),
    commitSha: z.string(),
    repository: z.string(),
  }),
  stopVM: z.object({ id: z.string() }),
  startInitialProjectDeployment: z.object({ id: z.string() }),
  startRun: z.object({ id: z.string() }),
  resumeTask: z.object({ id: z.string() }),
  prepareJobInstance: z.object({ id: z.string() }),
  prepareTriggerVariant: z.object({ id: z.string() }),
  deliverHttpSourceRequest: z.object({ id: z.string() }),
  refreshOAuthToken: z.object({
    organizationId: z.string(),
    connectionId: z.string(),
  }),
  registerJob: z.object({
    endpointId: z.string(),
    job: GetJobResponseSchema,
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
    runnerOptions: {
      connectionString: env.DATABASE_URL,
      concurrency: 5,
      pollInterval: 1000,
      noHandleSignals: false,
    },
    schema: workerCatalog,
    tasks: {
      registerJob: {
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new RegisterJobService();

          await service.call(payload.endpointId, payload.job);
        },
      },
      deliverHttpSourceRequest: {
        maxAttempts: 5,
        handler: async (payload, job) => {
          const service = new DeliverHttpSourceRequestService();

          await service.call(payload.id);
        },
      },
      prepareJobInstance: {
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new PrepareJobInstanceService();

          await service.call(payload.id);
        },
      },
      prepareTriggerVariant: {
        maxAttempts: 3,
        handler: async (payload, job) => {
          const service = new PrepareTriggerVariantService();

          await service.call(payload.id);
        },
      },
      startRun: {
        queueName: "executions",
        maxAttempts: 13,
        handler: async (payload, job) => {
          const service = new StartRunService();

          await service.call(payload.id);
        },
      },
      resumeTask: {
        queueName: "executions",
        maxAttempts: 13,
        handler: async (payload, job) => {
          const service = new ResumeTaskService();

          await service.call(payload.id);
        },
      },
      deliverEmail: {
        queueName: "internal-queue",
        priority: 100,
        maxAttempts: 3,
        handler: async (payload, job) => {
          // TODO: implement
        },
      },
      startInitialProjectDeployment: {
        queueName: "internal-queue",
        priority: 50,
        maxAttempts: 3,
        handler: async (payload, job) => {
          // TODO: implement
        },
      },
      stopVM: {
        queueName: "internal-queue",
        priority: 50,
        maxAttempts: 3,
        handler: async (payload, job) => {
          // TODO: implement
        },
      },
      organizationCreated: {
        queueName: "internal-queue",
        priority: 50,
        maxAttempts: 3,
        handler: async (payload, job) => {
          // TODO: implement
        },
      },
      githubPush: {
        queueName: "internal-queue",
        priority: 50,
        maxAttempts: 3,
        handler: async (payload, job) => {
          // TODO: implement
        },
      },
      githubAppInstallationDeleted: {
        queueName: "internal-queue",
        priority: 50,
        maxAttempts: 3,
        handler: async (payload, job) => {
          // TODO: implement
        },
      },
      endpointRegistered: {
        queueName: "internal-queue",
        handler: async (payload, job) => {
          const service = new EndpointRegisteredService();

          await service.call(payload.id);
        },
      },
      deliverEvent: {
        queueName: "event-dispatcher",
        handler: async (payload, job) => {
          const service = new DeliverEventService();

          await service.call(payload.id);
        },
      },
      refreshOAuthToken: {
        queueName: "internal-queue",
        handler: async (payload, job) => {
          await apiConnectionRepository.refreshConnection({
            connectionId: payload.connectionId,
          });
        },
      },
    },
  });
}

export { workerQueue };
