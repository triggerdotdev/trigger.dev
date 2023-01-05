import { JsonSchema } from "@trigger.dev/common-schemas";
import { DeliverEmailSchema } from "emails";
import type { CoordinatorCatalog, PlatformCatalog } from "internal-platform";
import {
  coordinatorCatalog,
  platformCatalog,
  ZodPublisher,
  ZodPubSub,
  ZodSubscriber,
} from "internal-platform";
import type { Client as PulsarClient } from "pulsar-client";
import Pulsar from "pulsar-client";
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
import { WorkflowRunDisconnected } from "./runs/runDisconnected";

let pulsarClient: PulsarClient;
let triggerPublisher: ZodPublisher<PlatformCatalog>;
let triggerSubscriber: ZodSubscriber<CoordinatorCatalog>;
let internalPubSub: ZodPubSub<typeof InternalCatalog>;
let requestPubSub: ZodPubSub<typeof RequestCatalog>;

declare global {
  var __pulsar_client__: typeof pulsarClient;
  var __trigger_publisher__: typeof triggerPublisher;
  var __trigger_subscriber__: typeof triggerSubscriber;
  var __internal_pub_sub__: typeof internalPubSub;
  var __request_pub_sub__: typeof requestPubSub;
}

export async function init() {
  if (pulsarClient) {
    return;
  }

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
    triggerPublisher = await createTriggerPublisher();
  } else {
    if (!global.__trigger_publisher__) {
      global.__trigger_publisher__ = await createTriggerPublisher();
    }
    triggerPublisher = global.__trigger_publisher__;
  }

  if (env.NODE_ENV === "production") {
    triggerSubscriber = await createTriggerSubscriber();
  } else {
    if (!global.__trigger_subscriber__) {
      global.__trigger_subscriber__ = await createTriggerSubscriber();
    }
    triggerSubscriber = global.__trigger_subscriber__;
  }

  if (env.NODE_ENV === "production") {
    internalPubSub = await createInternalPubSub();
  } else {
    if (!global.__internal_pub_sub__) {
      global.__internal_pub_sub__ = await createInternalPubSub();
    }
    internalPubSub = global.__internal_pub_sub__;
  }

  if (env.NODE_ENV === "production") {
    requestPubSub = await createRequestPubSub();
  } else {
    if (!global.__request_pub_sub__) {
      global.__request_pub_sub__ = await createRequestPubSub();
    }
    requestPubSub = global.__request_pub_sub__;
  }
}

function createClient() {
  const client = new Pulsar.Client({
    serviceUrl: env.PULSAR_URL,
  });

  console.log(`📡 Connected to pulsar at ${env.PULSAR_URL}`);

  return client;
}

async function createTriggerPublisher() {
  const producer = new ZodPublisher<PlatformCatalog>({
    client: pulsarClient,
    config: {
      topic: "persistent://public/default/workflow-triggers",
    },
    schema: platformCatalog,
  });

  await producer.initialize();

  return producer;
}

async function createTriggerSubscriber() {
  const subscriber = new ZodSubscriber<CoordinatorCatalog>({
    client: pulsarClient,
    config: {
      topic: "persistent://public/default/coordinator-events",
      subscription: "webapp",
      subscriptionType: "KeyShared",
      subscriptionInitialPosition: "Earliest",
    },
    schema: coordinatorCatalog,
    handlers: {
      LOG_MESSAGE: async (id, data, properties) => {
        await logMessageInRun(
          data.key,
          data.log,
          properties["x-workflow-run-id"],
          properties["x-api-key"]
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
          properties["x-api-key"]
        );

        return true;
      },
      WORKFLOW_RUN_DISCONNECTED: async (id, data, properties) => {
        const service = new WorkflowRunDisconnected();

        const success = await service.call(data.id);

        return !!success;
      },
      SEND_INTEGRATION_REQUEST: async (id, data, properties) => {
        const service = new CreateIntegrationRequest();

        await service.call(
          data.key,
          properties["x-workflow-run-id"],
          properties["x-api-key"],
          data.request
        );

        return true;
      },
      TRIGGER_CUSTOM_EVENT: async (id, data, properties) => {
        await triggerEventInRun(
          data.key,
          data.event,
          properties["x-workflow-run-id"],
          properties["x-api-key"]
        );

        return true;
      },
      INITIALIZE_DELAY: async (id, data, properties) => {
        const service = new InitiateDelay();

        await service.call(properties["x-workflow-run-id"], {
          key: data.key,
          wait: data.wait,
        });

        return true;
      },
    },
  });

  await subscriber.initialize();

  return subscriber;
}

const RequestCatalog = {
  PERFORM_INTEGRATION_REQUEST: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
};

async function createRequestPubSub() {
  const pubSub = new ZodPubSub<typeof RequestCatalog>({
    client: pulsarClient,
    topic: "persistent://public/default/internal-requests",
    subscriberConfig: {
      subscription: "webapp",
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
          await internalPubSub.publish("RESOLVE_INTEGRATION_REQUEST", {
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

  await pubSub.initialize();

  return pubSub;
}

const InternalCatalog = {
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

async function createInternalPubSub() {
  const pubSub = new ZodPubSub<typeof InternalCatalog>({
    client: pulsarClient,
    topic: "persistent://public/default/internal-messaging",
    subscriberConfig: {
      subscription: "webapp",
      subscriptionType: "Shared",
    },
    publisherConfig: {
      sendTimeoutMs: 1000,
    },
    schema: InternalCatalog,
    handlers: {
      RESOLVE_DELAY: async (id, data, properties) => {
        const service = new ResolveDelay();

        const { step } = await service.call(data.id);

        triggerPublisher.publish(
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
          await triggerPublisher.publish(
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
          await triggerPublisher.publish(
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

  await pubSub.initialize();

  return pubSub;
}

export { internalPubSub, requestPubSub };
