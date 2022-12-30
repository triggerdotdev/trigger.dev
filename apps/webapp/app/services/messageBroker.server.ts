import { JsonSchema } from "@trigger.dev/common-schemas";
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
  initiateWaitInRun,
  logMessageInRun,
  startWorkflowRun,
  triggerEventInRun,
} from "~/models/workflowRun.server";
import { DispatchEvent } from "./events/dispatch.server";
import { RegisterExternalSource } from "./externalSources/registerExternalSource.server";
import { CreateIntegrationRequest } from "./requests/createIntegrationRequest.server";
import { PerformIntegrationRequest } from "./requests/performIntegrationRequest.server";
import { StartIntegrationRequest } from "./requests/startIntegrationRequest.server";
import { WaitForConnection } from "./requests/waitForConnection.server";

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
      subscriptionType: "Shared",
      subscriptionInitialPosition: "Earliest",
    },
    schema: coordinatorCatalog,
    handlers: {
      LOG_MESSAGE: async (id, data, properties) => {
        await logMessageInRun(data.id, data.log, properties["x-api-key"]);

        return true;
      },
      START_WORKFLOW_RUN: async (id, data, properties) => {
        await startWorkflowRun(data.id, properties["x-api-key"]);

        return true;
      },
      FAIL_WORKFLOW_RUN: async (id, data, properties) => {
        await failWorkflowRun(data.id, data.error, properties["x-api-key"]);

        return true;
      },
      SEND_INTEGRATION_REQUEST: async (id, data, properties) => {
        const service = new CreateIntegrationRequest();

        const integrationRequest = await service.call(
          properties["x-api-key"],
          properties["x-workflow-run-id"],
          data
        );

        internalPubSub.publish("INTEGRATION_REQUEST_CREATED", {
          id: integrationRequest.id,
        });

        return true;
      },
      COMPLETE_WORKFLOW_RUN: async (id, data, properties) => {
        await completeWorkflowRun(
          data.id,
          data.output,
          properties["x-api-key"]
        );

        return true;
      },
      TRIGGER_CUSTOM_EVENT: async (id, data, properties) => {
        await triggerEventInRun(data.id, data.event, properties["x-api-key"]);

        return true;
      },
      INITIATE_WAIT: async (id, data, properties) => {
        await initiateWaitInRun(data.id, data.wait, properties["x-api-key"]);

        return true;
      },
    },
  });

  await subscriber.initialize();

  return subscriber;
}

const InternalCatalog = {
  EVENT_CREATED: {
    data: z.object({ id: z.string() }),
    properties: z.object({}),
  },
  WORKFLOW_RUN_CREATED: {
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
};

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
      EXTERNAL_SOURCE_UPSERTED: async (id, data, properties) => {
        const service = new RegisterExternalSource();

        const isRegistered = await service.call(data.id);

        return isRegistered; // Returning true will mean we don't retry
      },
      EXTERNAL_SERVICE_UPSERTED: async (id, data, properties) => {
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
      WORKFLOW_RUN_CREATED: async (id, data, properties) => {
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
          }
        );

        return true;
      },
    },
  });

  await pubSub.initialize();

  return pubSub;
}

export { internalPubSub, requestPubSub };
