import type { PulsarMessage, PulsarConsumer } from "./pulsarClient.server";
import { pulsarClient } from "./pulsarClient.server";

export async function init() {
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
}

async function receiveMetadata(msg: PulsarMessage, consumer: PulsarConsumer) {
  const data = JSON.parse(msg.getData().toString());
  const properties = msg.getProperties();

  console.log("Received metadata", data, properties);

  await consumer.acknowledge(msg);
}
