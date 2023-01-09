import { JsonSchema } from "@trigger.dev/common-schemas";
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
  ZodPublisher,
  ZodPubSub,
  ZodSubscriber,
} from "internal-platform";
import type { PulsarClient } from "internal-pulsar";
import { createPulsarClient, Topics } from "internal-pulsar";
import { z } from "zod";
import { env } from "~/env.server";
import { findIntegrationRequestById } from "~/models/integrationRequest.server";
import {
  completeWorkflowRun,
  failWorkflowRun,
  findWorklowRunById,
  logMessageInRun,
  startWorkflowRun,
  triggerEventInRun,
} from "~/models/workflowRun.server";
import { InitiateDelay } from "./delays/initiateDelay.server";
import { ResolveDelay } from "./delays/resolveDelay.server";
import { sendEmail } from "./email.server";
import { DispatchEvent } from "./events/dispatch.server";
import { HandleNewServiceConnection } from "./externalServices/handleNewConnection.server";
import { RegisterExternalSource } from "./externalSources/registerExternalSource.server";
import { CreateIntegrationRequest } from "./requests/createIntegrationRequest.server";
import { PerformIntegrationRequest } from "./requests/performIntegrationRequest.server";
import { StartIntegrationRequest } from "./requests/startIntegrationRequest.server";
import { WaitForConnection } from "./requests/waitForConnection.server";
import { WorkflowRunDisconnected } from "./runs/runDisconnected.server";

let pulsarClient: PulsarClient;
let triggerPublisher: ZodPublisher<TriggerCatalog>;
let commandResponsePublisher: ZodPublisher<CommandResponseCatalog>;
let commandSubscriber: ZodSubscriber<CommandCatalog>;
let taskQueue: ZodPubSub<typeof taskQueueCatalog>;
let requestTaskQueue: ZodPubSub<typeof RequestCatalog>;

declare global {
  var __pulsar_client__: typeof pulsarClient;
  var __trigger_publisher__: typeof triggerPublisher;
  var __command_subscriber__: typeof commandSubscriber;
  var __command_response_publisher__: typeof commandResponsePublisher;
  var __task_queue__: typeof taskQueue;
  var __request_task_queue__: typeof requestTaskQueue;
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

  await commandResponsePublisher.initialize();
  await triggerPublisher.initialize();
  await taskQueue.initialize();
  await requestTaskQueue.initialize();
  await commandSubscriber.initialize();
}

function createClient() {
  const client = createPulsarClient({
    serviceUrl: env.PULSAR_SERVICE_URL,
  });

  console.log(`📡 Connected to pulsar at ${env.PULSAR_SERVICE_URL}`);

  return client;
}

function createTriggerPublisher() {
  const producer = new ZodPublisher({
    client: pulsarClient,
    config: {
      topic: Topics.triggers,
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
          data.output,
          properties["x-workflow-run-id"],
          properties["x-api-key"],
          properties["x-timestamp"]
        );

        return true;
      },
      WORKFLOW_RUN_DISCONNECTED: async (id, data, properties) => {
        const service = new WorkflowRunDisconnected();

        const success = await service.call(data.id, properties["x-timestamp"]);

        return !!success;
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
    },
  });

  return subscriber;
}

function createCommandResponsePublisher() {
  const producer = new ZodPublisher({
    client: pulsarClient,
    config: {
      topic: Topics.runCommandResponses,
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
    },
  });

  return pubSub;
}

const taskQueueCatalog = {
  EVENT_CREATED: {
    data: z.object({ id: z.string() }),
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
  RESOLVE_DELAY: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  DELIVER_EMAIL: {
    data: DeliverEmailSchema,
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
      EXTERNAL_SOURCE_UPSERTED: async (id, data, properties) => {
        const service = new RegisterExternalSource();

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
          }
        );

        return true;
      },
      DELIVER_EMAIL: async (id, data, properties) => {
        await sendEmail(data);
        return true;
      },
    },
  });

  return taskQueue;
}

export { taskQueue, requestTaskQueue };
