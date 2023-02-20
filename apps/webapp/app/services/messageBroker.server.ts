import type { FetchOutputSchema } from "@trigger.dev/common-schemas";
import {
  CustomEventSchema,
  JsonSchema,
  ScheduledEventPayloadSchema,
} from "@trigger.dev/common-schemas";
import { DeliverEmailSchema } from "emails";
import type {
  CommandCatalog,
  CommandResponseCatalog,
  TriggerCatalog,
} from "internal-platform";
import {
  commandCatalog,
  commandResponseCatalog,
  triggerCatalog,
  ZodEventPublisher,
  ZodEventSubscriber,
  ZodPublisher,
  ZodPubSub,
  ZodSubscriber,
} from "internal-platform";
import { Topics } from "internal-pulsar";
import { EventEmitter } from "stream";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { findFetchRequestById } from "~/models/fetchRequest.server";
import { findIntegrationRequestById } from "~/models/integrationRequest.server";
import {
  completeWorkflowRun,
  failWorkflowRun,
  findWorklowRunById,
  logMessageInRun,
  startWorkflowRun,
  triggerEventInRun,
} from "~/models/workflowRun.server";
import { findWorkflowStepById } from "~/models/workflowRunStep.server";
import { omit } from "~/utils/objects";
import { OrganizationCreatedEvent } from "./analyticsEvents/organizationCreated.server";
import { WorkflowCreatedEvent } from "./analyticsEvents/workflowCreated.server";
import { WorkflowRunCreatedEvent } from "./analyticsEvents/workflowRunCreated.server";
import { InitiateDelay } from "./delays/initiateDelay.server";
import { ResolveDelay } from "./delays/resolveDelay.server";
import { sendEmail } from "./email.server";
import { DispatchEvent } from "./events/dispatch.server";
import { IngestCustomEvent } from "./events/ingestCustomEvent.server";
import { HandleNewServiceConnection } from "./externalServices/handleNewConnection.server";
import { RegisterExternalSource } from "./externalSources/registerExternalSource.server";
import { CreateFetchRequest } from "./fetches/createFetchRequest.server";
import { PerformFetchRequest } from "./fetches/performFetchRequest.server";
import { StartFetchRequest } from "./fetches/startFetchRequest.server";
import { GithubRepositoryCreated } from "./github/repositoryCreated.server";
import type { PulsarClient } from "./pulsarClient.server";
import { createPulsarClient } from "./pulsarClient.server";
import { CreateIntegrationRequest } from "./requests/createIntegrationRequest.server";
import { PerformIntegrationRequest } from "./requests/performIntegrationRequest.server";
import { StartIntegrationRequest } from "./requests/startIntegrationRequest.server";
import { WaitForConnection } from "./requests/waitForConnection.server";
import { CompleteRunOnce } from "./runOnce/completeRunOnce.server";
import { InitializeRunOnce } from "./runOnce/initializeRunOnce.server";
import { WorkflowRunDisconnected } from "./runs/runDisconnected.server";
import { WorkflowRunTriggerTimeout } from "./runs/runTriggerTimeout.server";
import { DeliverScheduledEvent } from "./scheduler/deliverScheduledEvent.server";
import { RegisterSchedulerSource } from "./scheduler/registerSchedulerSource.server";
import { WorkflowCreated } from "./workflows/events/workflowCreated.server";

let pulsarClient: PulsarClient;
let triggerPublisher: ZodPublisher<TriggerCatalog>;
let commandResponsePublisher: ZodPublisher<CommandResponseCatalog>;
let commandSubscriber: ZodSubscriber<CommandCatalog>;
let taskQueue: ZodPubSub<typeof taskQueueCatalog>;
let requestTaskQueue: ZodPubSub<typeof RequestCatalog>;
let appEventPublisher: ZodEventPublisher;

declare global {
  var __pulsar_client__: typeof pulsarClient;
  var __trigger_publisher__: typeof triggerPublisher;
  var __command_subscriber__: typeof commandSubscriber;
  var __command_response_publisher__: typeof commandResponsePublisher;
  var __task_queue__: typeof taskQueue;
  var __request_task_queue__: typeof requestTaskQueue;
  var __app_event_publisher__: typeof appEventPublisher;
}

export async function init() {
  if (!env.PULSAR_ENABLED) {
    console.log("📡 Message Broker disabled");
    return;
  }

  if (env.NODE_ENV === "production") {
    pulsarClient = createClient();
  } else {
    if (!global.__pulsar_client__) {
      global.__pulsar_client__ = createClient();
    }
    pulsarClient = global.__pulsar_client__;
  }

  if (env.NODE_ENV === "production") {
    triggerPublisher = createTriggerPublisher();
  } else {
    if (!global.__trigger_publisher__) {
      global.__trigger_publisher__ = createTriggerPublisher();
    }
    triggerPublisher = global.__trigger_publisher__;
  }

  if (env.NODE_ENV === "production") {
    commandSubscriber = createCommandSubscriber();
  } else {
    if (!global.__command_subscriber__) {
      global.__command_subscriber__ = createCommandSubscriber();
    }
    commandSubscriber = global.__command_subscriber__;
  }

  if (env.NODE_ENV === "production") {
    commandResponsePublisher = createCommandResponsePublisher();
  } else {
    if (!global.__command_response_publisher__) {
      global.__command_response_publisher__ = createCommandResponsePublisher();
    }
    commandResponsePublisher = global.__command_response_publisher__;
  }

  if (env.NODE_ENV === "production") {
    taskQueue = createTaskQueue();
  } else {
    if (!global.__task_queue__) {
      global.__task_queue__ = createTaskQueue();
    }
    taskQueue = global.__task_queue__;
  }

  if (env.NODE_ENV === "production") {
    requestTaskQueue = createRequestTaskQueue();
  } else {
    if (!global.__request_task_queue__) {
      global.__request_task_queue__ = createRequestTaskQueue();
    }
    requestTaskQueue = global.__request_task_queue__;
  }

  if (env.NODE_ENV === "production") {
    appEventPublisher = createAppEventPublisher();
  } else {
    if (!global.__app_event_publisher__) {
      global.__app_event_publisher__ = createAppEventPublisher();
    }
    appEventPublisher = global.__app_event_publisher__;
  }

  await commandResponsePublisher.initialize();
  await triggerPublisher.initialize();
  await taskQueue.initialize();
  await requestTaskQueue.initialize();
  await commandSubscriber.initialize();
  await appEventPublisher.initialize();
}

function createClient() {
  const client = createPulsarClient({
    serviceUrl: env.PULSAR_SERVICE_URL,
    ioThreads: 5,
    messageListenerThreads: 5,
    operationTimeoutSeconds: 30,
  });

  console.log(`📡 Connected to pulsar at ${env.PULSAR_SERVICE_URL}`);

  return client;
}

function createTriggerPublisher() {
  const producer = new ZodPublisher({
    client: pulsarClient,
    config: {
      topic: Topics.triggers,
      batchingEnabled: false,
    },
    schema: triggerCatalog,
  });

  return producer;
}

function createCommandSubscriber() {
  const subscriber = new ZodSubscriber({
    client: pulsarClient,
    config: {
      topic: Topics.runCommands,
      subscription: "webapp-commands",
      subscriptionType: "KeyShared",
      subscriptionInitialPosition: "Earliest",
    },
    schema: commandCatalog,
    handlers: {
      LOG_MESSAGE: async (id, data, properties) => {
        await logMessageInRun(
          data.key,
          data.log,
          properties["x-workflow-run-id"],
          properties["x-api-key"],
          properties["x-timestamp"]
        );

        return true;
      },
      WORKFLOW_RUN_STARTED: async (id, data, properties) => {
        await startWorkflowRun(data.id, properties["x-api-key"]);

        return true;
      },
      WORKFLOW_RUN_ERROR: async (id, data, properties) => {
        await failWorkflowRun(
          properties["x-workflow-run-id"],
          data.error,
          properties["x-api-key"]
        );

        return true;
      },
      WORKFLOW_RUN_COMPLETE: async (id, data, properties) => {
        await completeWorkflowRun(
          properties["x-workflow-run-id"],
          properties["x-api-key"],
          properties["x-timestamp"],
          data.output
        );

        return true;
      },
      WORKFLOW_RUN_DISCONNECTED: async (id, data, properties) => {
        const service = new WorkflowRunDisconnected();

        const success = await service.call(data.id, properties["x-timestamp"]);

        return !!success;
      },
      WORKFLOW_RUN_TRIGGER_TIMEOUT: async (id, data, properties) => {
        const service = new WorkflowRunTriggerTimeout();

        await service.call(data);

        return true;
      },
      SEND_INTEGRATION_REQUEST: async (id, data, properties) => {
        const service = new CreateIntegrationRequest();

        await service.call(
          data.key,
          properties["x-workflow-run-id"],
          properties["x-api-key"],
          properties["x-timestamp"],
          data.request
        );

        return true;
      },
      SEND_FETCH_REQUEST: async (id, data, properties) => {
        const service = new CreateFetchRequest();

        await service.call(
          data.key,
          properties["x-workflow-run-id"],
          properties["x-api-key"],
          properties["x-timestamp"],
          data.fetch
        );

        return true;
      },
      TRIGGER_CUSTOM_EVENT: async (id, data, properties) => {
        await triggerEventInRun(
          data.key,
          data.event,
          properties["x-workflow-run-id"],
          properties["x-api-key"],
          properties["x-timestamp"]
        );

        return true;
      },
      INITIALIZE_DELAY: async (id, data, properties) => {
        const service = new InitiateDelay();

        await service.call(
          properties["x-workflow-run-id"],
          properties["x-timestamp"],
          {
            key: data.key,
            wait: data.wait,
          }
        );

        return true;
      },
      INITIALIZE_RUN_ONCE: async (id, data, properties) => {
        const service = new InitializeRunOnce();

        await service.call(
          properties["x-workflow-run-id"],
          data.key,
          properties["x-timestamp"],
          data.runOnce
        );

        return true;
      },
      COMPLETE_RUN_ONCE: async (id, data, properties) => {
        const service = new CompleteRunOnce();

        await service.call(data.runOnce);

        return true;
      },
    },
  });

  return subscriber;
}

function createCommandResponsePublisher() {
  const producer = new ZodPublisher({
    client: pulsarClient,
    config: {
      topic: Topics.runCommandResponses,
      batchingEnabled: false,
    },
    schema: commandResponseCatalog,
  });

  return producer;
}

const RequestCatalog = {
  PERFORM_INTEGRATION_REQUEST: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  PERFORM_FETCH_REQUEST: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
};

function createRequestTaskQueue() {
  const pubSub = new ZodPubSub<typeof RequestCatalog>({
    client: pulsarClient,
    topic: Topics.integrationWorker,
    subscriberConfig: {
      subscription: "webapp-requests",
      subscriptionType: "Shared",
    },
    publisherConfig: {
      sendTimeoutMs: 1000,
    },
    schema: RequestCatalog,
    handlers: {
      PERFORM_INTEGRATION_REQUEST: async (id, data, properties) => {
        const service = new PerformIntegrationRequest();

        const response = await service.call(data.id);

        if (response.stop) {
          await taskQueue.publish("RESOLVE_INTEGRATION_REQUEST", {
            id: data.id,
          });

          return true;
        } else {
          await pubSub.publish(
            "PERFORM_INTEGRATION_REQUEST",
            {
              id: data.id,
            },
            {},
            { deliverAfter: response.retryInSeconds * 1000 }
          );

          return true;
        }
      },
      PERFORM_FETCH_REQUEST: async (id, data, properties) => {
        const service = new PerformFetchRequest();

        const response = await service.call(data.id);

        if (response.stop) {
          await taskQueue.publish("RESOLVE_FETCH_REQUEST", {
            id: data.id,
          });

          return true;
        } else {
          await pubSub.publish(
            "PERFORM_FETCH_REQUEST",
            {
              id: data.id,
            },
            {},
            { deliverAfter: response.retryInSeconds * 1000 }
          );

          return true;
        }
      },
    },
  });

  return pubSub;
}

const taskQueueCatalog = {
  EVENT_CREATED: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  INGEST_DELAYED_EVENT: {
    data: z.object({
      id: z.string().optional(),
      apiKey: z.string(),
      event: CustomEventSchema.omit({ delay: true }),
    }),
    properties: z.object({}),
  },
  TRIGGER_WORKFLOW_RUN: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  EXTERNAL_SOURCE_UPSERTED: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  SCHEDULER_SOURCE_UPSERTED: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  EXTERNAL_SERVICE_UPSERTED: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  INTEGRATION_REQUEST_CREATED: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  RESOLVE_INTEGRATION_REQUEST: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  FETCH_REQUEST_CREATED: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  RESOLVE_FETCH_REQUEST: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  RESOLVE_DELAY: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  DELIVER_EMAIL: {
    data: DeliverEmailSchema,
    properties: z.object({}),
  },
  DELIVER_SCHEDULED_EVENT: {
    data: z.object({
      externalSourceId: z.string(),
      payload: ScheduledEventPayloadSchema,
    }),
    properties: z.object({}),
  },
  SEND_INTERNAL_EVENT: {
    data: CustomEventSchema.extend({ id: z.string() }),
    properties: z.object({}),
  },
  RESOLVE_RUN_ONCE: {
    data: z.object({ stepId: z.string(), hasRun: z.boolean() }),
    properties: z.object({}),
  },
  GITHUB_APP_INSTALLATION_DELETED: {
    data: z.object({ id: z.number() }),
    properties: z.object({}),
  },
  GITHUB_APP_REPOSITORY_CREATED: {
    data: z.object({ id: z.number() }),
    properties: z.object({}),
  },
  ORGANIZATION_CREATED: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  WORKFLOW_CREATED: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  WORKFLOW_RUN_CREATED: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  WORKFLOW_RUN_STARTED: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
};

function createTaskQueue() {
  const taskQueue = new ZodPubSub({
    client: pulsarClient,
    topic: Topics.appTaskWorker,
    subscriberConfig: {
      subscription: "webapp-queue",
      subscriptionType: "Shared",
    },
    publisherConfig: {
      sendTimeoutMs: 1000,
    },
    schema: taskQueueCatalog,
    handlers: {
      RESOLVE_DELAY: async (id, data, properties) => {
        const service = new ResolveDelay();

        const { step } = await service.call(data.id);

        commandResponsePublisher.publish(
          "RESOLVE_DELAY",
          { id: data.id, key: step.idempotencyKey },
          {
            "x-workflow-run-id": step.run.id,
            "x-api-key": step.run.environment.apiKey,
            "x-org-id": step.run.environment.organizationId,
            "x-workflow-id": step.run.workflowId,
            "x-env": step.run.environment.slug,
          }
        );
        return true;
      },
      INTEGRATION_REQUEST_CREATED: async (id, data, properties) => {
        const integrationRequest = await findIntegrationRequestById(data.id);

        if (!integrationRequest) {
          return true;
        }

        if (!integrationRequest.externalService.connectionId) {
          const service = new WaitForConnection();
          await service.call(
            integrationRequest,
            integrationRequest.externalService,
            integrationRequest.step,
            integrationRequest.run
          );
          return true;
        } else {
          const service = new StartIntegrationRequest();
          await service.call(integrationRequest, integrationRequest.step);

          return true;
        }
      },
      RESOLVE_INTEGRATION_REQUEST: async (id, data, properties) => {
        const integrationRequest = await findIntegrationRequestById(data.id);

        if (!integrationRequest) {
          return true;
        }

        const run = await findWorklowRunById(integrationRequest.runId);

        if (!run) {
          return true;
        }

        if (
          integrationRequest.status !== "SUCCESS" &&
          integrationRequest.status !== "ERROR"
        ) {
          return true;
        }

        if (integrationRequest.status === "SUCCESS") {
          await commandResponsePublisher.publish(
            "RESOLVE_INTEGRATION_REQUEST",
            {
              id: integrationRequest.id,
              key: integrationRequest.step.idempotencyKey,
              output: integrationRequest.step.output as z.infer<
                typeof JsonSchema
              >,
            },
            {
              "x-workflow-run-id": run.id,
              "x-api-key": run.environment.apiKey,
              "x-org-id": run.environment.organizationId,
              "x-workflow-id": run.workflowId,
              "x-env": run.environment.slug,
            }
          );
        } else {
          await commandResponsePublisher.publish(
            "REJECT_INTEGRATION_REQUEST",
            {
              id: integrationRequest.id,
              key: integrationRequest.step.idempotencyKey,
              error: integrationRequest.step.output as z.infer<
                typeof JsonSchema
              >,
            },
            {
              "x-workflow-run-id": run.id,
              "x-api-key": run.environment.apiKey,
              "x-org-id": run.environment.organizationId,
              "x-workflow-id": run.workflowId,
              "x-env": run.environment.slug,
            }
          );
        }

        return true;
      },
      FETCH_REQUEST_CREATED: async (id, data, properties) => {
        const fetchRequest = await findFetchRequestById(data.id);

        if (!fetchRequest) {
          return true;
        }

        const service = new StartFetchRequest();
        await service.call(fetchRequest, fetchRequest.step);

        return true;
      },
      RESOLVE_FETCH_REQUEST: async (id, data, properties) => {
        const fetchRequest = await findFetchRequestById(data.id);

        if (!fetchRequest) {
          return true;
        }

        const run = await findWorklowRunById(fetchRequest.runId);

        if (!run) {
          return true;
        }

        if (
          fetchRequest.status !== "SUCCESS" &&
          fetchRequest.status !== "ERROR"
        ) {
          return true;
        }

        if (fetchRequest.status === "SUCCESS") {
          const output = fetchRequest.step.output as z.infer<
            typeof FetchOutputSchema
          >;

          await commandResponsePublisher.publish(
            "RESOLVE_FETCH_REQUEST",
            {
              id: fetchRequest.id,
              key: fetchRequest.step.idempotencyKey,
              output,
            },
            {
              "x-workflow-run-id": run.id,
              "x-api-key": run.environment.apiKey,
              "x-org-id": run.environment.organizationId,
              "x-workflow-id": run.workflowId,
              "x-env": run.environment.slug,
            }
          );
        } else {
          await commandResponsePublisher.publish(
            "REJECT_FETCH_REQUEST",
            {
              id: fetchRequest.id,
              key: fetchRequest.step.idempotencyKey,
              error: fetchRequest.step.output as z.infer<typeof JsonSchema>,
            },
            {
              "x-workflow-run-id": run.id,
              "x-api-key": run.environment.apiKey,
              "x-org-id": run.environment.organizationId,
              "x-workflow-id": run.workflowId,
              "x-env": run.environment.slug,
            }
          );
        }

        return true;
      },
      RESOLVE_RUN_ONCE: async (id, data, properties) => {
        const step = await findWorkflowStepById(data.stepId);

        if (!step) {
          return true;
        }

        const response = await commandResponsePublisher.publish(
          "RESOLVE_RUN_ONCE",
          {
            id: step.id,
            key: step.idempotencyKey,
            runOnce: {
              idempotencyKey: step.id,
              output: step.output
                ? JSON.parse(JSON.stringify(step.output))
                : undefined,
              hasRun: data.hasRun,
            },
          },
          {
            "x-workflow-run-id": step.run.id,
            "x-api-key": step.run.environment.apiKey,
            "x-org-id": step.run.environment.organizationId,
            "x-workflow-id": step.run.workflowId,
            "x-env": step.run.environment.slug,
          }
        );

        return !!response;
      },
      EXTERNAL_SOURCE_UPSERTED: async (id, data, properties) => {
        const service = new RegisterExternalSource();

        const isRegistered = await service.call(data.id);

        return isRegistered; // Returning true will mean we don't retry
      },
      SCHEDULER_SOURCE_UPSERTED: async (id, data, properties) => {
        const service = new RegisterSchedulerSource();

        const isRegistered = await service.call(data.id);

        return isRegistered; // Returning true will mean we don't retry
      },
      EXTERNAL_SERVICE_UPSERTED: async (id, data, properties) => {
        const service = new HandleNewServiceConnection();

        await service.call(data.id);

        return true;
      },
      EVENT_CREATED: async (id, data, properties) => {
        const service = new DispatchEvent();

        try {
          await service.call(data.id);
        } catch (error) {
          console.log(error);
          return false;
        }

        return true;
      },
      INGEST_DELAYED_EVENT: async (id, data, properties, attributes) => {
        if (attributes.redeliveryCount >= 4) {
          return true;
        }

        const ingestService = new IngestCustomEvent();

        await ingestService.call(data);

        return true;
      },
      TRIGGER_WORKFLOW_RUN: async (id, data, properties) => {
        const run = await findWorklowRunById(data.id);

        if (!run) {
          return true;
        }

        await triggerPublisher.publish(
          "TRIGGER_WORKFLOW",
          {
            id: run.id,
            input: JsonSchema.parse(run.event.payload),
            context: JsonSchema.parse(run.event.context),
          },
          {
            "x-api-key": run.environment.apiKey,
            "x-org-id": run.environment.organizationId,
            "x-workflow-id": run.workflowId,
            "x-env": run.environment.slug,
            "x-workflow-run-id": run.id,
            "x-ttl": run.workflow.triggerTtlInSeconds,
            "x-is-test": run.isTest ? "true" : "false",
            "x-app-origin": env.APP_ORIGIN,
          },
          {
            eventTimestamp: run.event.timestamp.getTime(),
          }
        );

        return true;
      },
      DELIVER_EMAIL: async (id, data, properties) => {
        await sendEmail(data);
        return true;
      },
      DELIVER_SCHEDULED_EVENT: async (id, data, properties) => {
        const service = new DeliverScheduledEvent();

        return service.call(data.externalSourceId, data.payload);
      },
      SEND_INTERNAL_EVENT: async (id, data, properties, attributes) => {
        if (attributes.redeliveryCount >= 4) {
          return true;
        }

        if (!env.INTERNAL_TRIGGER_API_KEY) {
          return true;
        }

        const service = new IngestCustomEvent();

        await service.call({
          id: data.id,
          event: omit(data, ["id"]),
          apiKey: env.INTERNAL_TRIGGER_API_KEY,
        });

        return true;
      },
      GITHUB_APP_INSTALLATION_DELETED: async (
        id,
        data,
        properties,
        attributes
      ) => {
        if (attributes.redeliveryCount >= 4) {
          return true;
        }

        await prisma.gitHubAppAuthorization.deleteMany({
          where: {
            installationId: data.id,
          },
        });

        return true;
      },
      GITHUB_APP_REPOSITORY_CREATED: async (
        id,
        data,
        properties,
        attributes
      ) => {
        if (attributes.redeliveryCount >= 4) {
          return true;
        }

        const service = new GithubRepositoryCreated();

        await service.call(data.id);

        return true;
      },
      ORGANIZATION_CREATED: async (id, data, properties, attributes) => {
        if (attributes.redeliveryCount >= 4) {
          return true;
        }

        const service = new OrganizationCreatedEvent();
        return service.call(data.id);
      },
      WORKFLOW_CREATED: async (id, data, properties, attributes) => {
        if (attributes.redeliveryCount >= 4) {
          return true;
        }

        const service = new WorkflowCreated();

        await service.call(data.id);

        const analyticsService = new WorkflowCreatedEvent();

        await analyticsService.call(data.id);

        return true;
      },
      WORKFLOW_RUN_CREATED: async (id, data, properties, attributes) => {
        return true;
      },
      WORKFLOW_RUN_STARTED: async (id, data, properties, attributes) => {
        if (attributes.redeliveryCount >= 4) {
          return true;
        }

        const service = new WorkflowRunCreatedEvent();
        return service.call(data.id);
      },
    },
  });

  return taskQueue;
}

function createAppEventPublisher() {
  return new ZodEventPublisher({
    client: pulsarClient,
    config: {
      topic: Topics.appEventQueue,
      batchingEnabled: false,
    },
  });
}

export { taskQueue, requestTaskQueue, appEventPublisher };

export async function createEventEmitter({
  id,
  filter,
}: {
  id: string;
  filter: Record<string, string>;
}) {
  const eventEmitter = new EventEmitter();

  const eventSubscriber = new ZodEventSubscriber({
    client: pulsarClient,
    config: {
      subscription: `webapp-${id}`,
      topic: Topics.appEventQueue,
    },
    handler: async (id, name, data, properties, attributes) => {
      if (attributes.redeliveryCount >= 4) {
        return true;
      }

      eventEmitter.emit(name, data);
      return true;
    },
    filter,
  });

  await eventSubscriber.initialize();

  eventEmitter.on("removeListener", async () => {
    await eventSubscriber.close();
  });

  return eventEmitter;
}
