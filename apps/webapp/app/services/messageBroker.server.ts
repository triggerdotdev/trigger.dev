import { JsonSchema, PlatformCatalog } from "internal-platform";
import { platformCatalog, ZodPublisher, ZodPubSub } from "internal-platform";
import type { Client as PulsarClient } from "pulsar-client";
import Pulsar from "pulsar-client";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";

let pulsarClient: PulsarClient;
let triggerPublisher: ZodPublisher<PlatformCatalog>;
let internalPubSub: ZodPubSub<typeof InternalCatalog>;

declare global {
  var __pulsar_client__: typeof pulsarClient;
  var __trigger_publisher__: typeof triggerPublisher;
  var __internal_pub_sub__: typeof internalPubSub;
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
    internalPubSub = await createInternalPubSub();
  } else {
    if (!global.__internal_pub_sub__) {
      global.__internal_pub_sub__ = await createInternalPubSub();
    }
    internalPubSub = global.__internal_pub_sub__;
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

const CustomEventCreatedEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  payload: JsonSchema,
  context: JsonSchema,
  timestamp: z.string().datetime(),
  status: z.enum(["PENDING", "PROCESSED"]),
});

const CustomEventCreatedPropertiesSchema = z.object({
  "x-environment-id": z.string(),
});

const InternalCatalog = {
  CUSTOM_EVENT_CREATED: {
    data: CustomEventCreatedEventSchema,
    properties: CustomEventCreatedPropertiesSchema,
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
      CUSTOM_EVENT_CREATED: async (id, data, properties) => {
        console.log("CUSTOM_EVENT_CREATED", id, data, properties);

        const triggers = await prisma.workflowTrigger.findMany({
          where: {
            type: "CUSTOM_EVENT",
            environmentId: properties["x-environment-id"],
            config: {
              path: ["name"],
              equals: data.name,
            },
          },
          include: {
            workflow: true,
            environment: true,
          },
        });

        // For each trigger, we need to create a new workflow run
        // Which will trigger the workflow to run

        for (const trigger of triggers) {
          const run = await prisma.workflowRun.create({
            data: {
              workflow: {
                connect: {
                  id: trigger.workflowId,
                },
              },
              environment: {
                connect: {
                  id: trigger.environmentId,
                },
              },
              trigger: {
                connect: {
                  id: trigger.id,
                },
              },
              input: data.payload ?? {},
              context: data.context ?? undefined,
              timestamp: data.timestamp,
            },
          });

          await triggerPublisher.publish(
            run.id,
            "TRIGGER_WORKFLOW",
            {
              id: run.id,
              input: data.payload,
              context: data.context,
              timestamp: data.timestamp,
            },
            {
              "x-api-key": trigger.environment.apiKey,
              "x-org-id": trigger.environment.organizationId,
              "x-workflow-id": trigger.workflowId,
            }
          );
        }

        return true;
      },
    },
  });

  await pubSub.initialize();

  return pubSub;
}

export { internalPubSub };
