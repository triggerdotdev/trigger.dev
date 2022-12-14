import { env } from "~/env.server";
import type {
  Message as PulsarMessage,
  Consumer as PulsarConsumer,
  Client as PulsarClient,
} from "pulsar-client";
import Pulsar from "pulsar-client";

let workflowsMetaConsumer: PulsarConsumer;
let pulsarClient: PulsarClient;

declare global {
  var __meta_consumer__: typeof workflowsMetaConsumer;
  var __pulsar_client__: typeof pulsarClient;
}

export async function init() {
  if (workflowsMetaConsumer) return;

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
    workflowsMetaConsumer = await createMetaConsumer();
  } else {
    if (!global.__meta_consumer__) {
      global.__meta_consumer__ = await createMetaConsumer();
    }
    workflowsMetaConsumer = global.__meta_consumer__;
  }
}

async function createMetaConsumer() {
  const workflowsMetaConsumer = await pulsarClient.subscribe({
    topic: "workflows-meta",
    subscription: "webapp",
    subscriptionType: "Shared",
    ackTimeoutMs: 30000,
    listener: async (msg, consumer) => {
      await receiveMetadata(msg, consumer);
    },
  });

  console.log("📡 Message Broker initialized");

  process.on("beforeExit", () => {
    workflowsMetaConsumer.close();

    console.log("📡 Message Broker closed");
  });

  return workflowsMetaConsumer;
}

function createClient() {
  console.log(`📡 Creating Pulsar client for ${env.PULSAR_URL}`);

  const client = new Pulsar.Client({
    serviceUrl: env.PULSAR_URL,
  });

  return client;
}

async function receiveMetadata(msg: PulsarMessage, consumer: PulsarConsumer) {
  const data = JSON.parse(msg.getData().toString());
  const properties = msg.getProperties();

  console.log("Received metadata", data, properties);

  await consumer.acknowledge(msg);
}
