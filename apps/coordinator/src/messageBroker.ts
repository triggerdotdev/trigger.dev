import {
  Producer as PulsarProducer,
  Consumer as PulsarConsumer,
  Message as PulsarMessage,
} from "pulsar-client";
import { pulsarClient } from "./pulsarClient";

import type { MetadataMessages, WorkflowMetadata } from "internal-messages";
export type { WorkflowMetadata };
import { z } from "zod";
import { Logger } from "internal-bridge/logger";

export type WorkflowMessageBrokerConfig = {
  id: string;
};

export class WorkflowMessageBroker {
  #workflowsMetaProducer?: PulsarProducer;
  #workflowsMetaConsumer?: PulsarConsumer;
  #config: WorkflowMessageBrokerConfig;
  #logger: Logger;

  constructor(config: WorkflowMessageBrokerConfig) {
    this.#config = config;
    this.#logger = new Logger("trigger.dev", "info");
  }

  async initialize(data: WorkflowMetadata) {
    this.#logger.debug("Creating workflows-meta-from-host producer");

    this.#workflowsMetaProducer = await pulsarClient.createProducer({
      topic: "workflows-meta-from-host",
    });

    this.#logger.debug("Creating workflows-meta-to-host consumer");

    this.#workflowsMetaConsumer = await pulsarClient.subscribe({
      topic: "workflows-meta-to-host",
      subscription: `workflows-meta-${this.#config.id}`,
      subscriptionType: "Shared",
      ackTimeoutMs: 30000,
      listener: async (msg, consumer) => {
        await this.#receiveMessage(msg, consumer);
      },
    });

    await this.#sendMetadata("INITIALIZE_WORKFLOW", data);
  }

  async #receiveMessage(msg: PulsarMessage, consumer: PulsarConsumer) {
    console.log("Received message", msg.getData());

    await consumer.acknowledge(msg);
  }

  async #sendMetadata<K extends keyof MetadataMessages>(
    type: K,
    data: z.infer<MetadataMessages[K]["data"]>
  ) {
    if (!this.#workflowsMetaProducer) {
      throw new Error("Cannot send message without a producer");
    }

    this.#logger.debug("Sending metadata message", type, data);

    await this.#workflowsMetaProducer.send({
      data: Buffer.from(
        JSON.stringify({
          type,
          data,
        })
      ),
      properties: {
        "x-workflow-id": this.#config.id,
      },
    });
  }
}
