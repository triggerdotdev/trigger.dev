import { env } from "~/env.server";
import type { PulsarMessage, PulsarConsumer } from "./pulsarClient.server";
import { pulsarClient } from "./pulsarClient.server";

let workflowsMetaConsumer: PulsarConsumer;

declare global {
  var __meta_consumer__: typeof workflowsMetaConsumer;
}

export async function init() {
  if (workflowsMetaConsumer) return;

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

async function receiveMetadata(msg: PulsarMessage, consumer: PulsarConsumer) {
  const data = JSON.parse(msg.getData().toString());
  const properties = msg.getProperties();

  console.log("Received metadata", data, properties);

  await consumer.acknowledge(msg);
}
