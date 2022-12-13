import Pulsar from "pulsar-client";
import type {
  Producer as PulsarProducer,
  Consumer as PulsarConsumer,
  Message as PulsarMessage,
} from "pulsar-client";

import { env } from "~/env.server";

let pulsarClient: Pulsar.Client;

declare global {
  var __pulsarClient__: typeof pulsarClient;
}

if (env.NODE_ENV === "production") {
  pulsarClient = getClient();
} else {
  if (!global.__pulsarClient__) {
    global.__pulsarClient__ = getClient();
  }
  pulsarClient = global.__pulsarClient__;
}

function getClient() {
  const client = new Pulsar.Client({
    serviceUrl: env.PULSAR_URL,
  });

  return client;
}

export { pulsarClient };
export type { PulsarProducer, PulsarConsumer, PulsarMessage };
