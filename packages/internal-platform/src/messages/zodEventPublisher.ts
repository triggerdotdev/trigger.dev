import type {
  Client as PulsarClient,
  Producer as PulsarProducer,
  ProducerConfig as PulsarProducerConfig,
} from "pulsar-client";
import { ulid } from "ulid";
import { Logger } from "../logger";

import { ZodPubSubStatus } from "./types";

export type EventPublishOptions = {
  deliverAfter?: number;
  deliverAt?: number;
  partitionKey?: string;
  orderingKey?: string;
  id?: string;
  eventTimestamp?: number;
};

type PendingMessages = Array<{
  type: string;
  data: any;
  properties?: Record<string, string>;
  options: EventPublishOptions;
}>;

export type ZodEventPublisherOptions = {
  client: PulsarClient;
  config: PulsarProducerConfig;
};

export class ZodEventPublisher {
  #config: PulsarProducerConfig;
  #producer?: PulsarProducer;
  #client: PulsarClient;
  #status: ZodPubSubStatus = "waitingToConnect";
  #logger: Logger;
  #pendingMessages: PendingMessages = [];

  constructor(options: ZodEventPublisherOptions) {
    this.#config = options.config;
    this.#client = options.client;
    this.#logger = new Logger("trigger.dev event publisher");
  }

  public async initialize(): Promise<boolean> {
    if (this.#status !== "waitingToConnect") {
      return this.#status === "ready";
    }

    this.#status = "initializing";

    try {
      this.#logger.debug(
        `Initializing publisher with config ${JSON.stringify(this.#config)}`
      );

      this.#producer = await this.#client.createProducer(this.#config);

      this.#status = "ready";

      await this.#flushPendingMessages();

      return true;
    } catch (e) {
      this.#logger.error("Error initializing publisher", e);

      this.#status = "error";

      return false;
    }
  }

  async #flushPendingMessages() {
    if (this.#pendingMessages.length === 0) {
      return;
    }

    this.#logger.debug(
      `Publishing ${this.#pendingMessages.length} pending messages`
    );

    // Publish messages and remove them from #pendingMessages one at a time
    // so that if one fails, the rest will still be published
    for (let i = 0; i < this.#pendingMessages.length; i++) {
      const message = this.#pendingMessages[i];

      try {
        await this.publish(
          message.type,
          message.data,
          message.properties,
          message.options
        );
      } catch (error) {
        // If the publish fails, we don't want to remove the message from the array
        // So we just continue to the next iteration of the loop
        continue;
      }

      // If the publish was successful, we can remove the message from the array
      this.#pendingMessages.splice(i, 1);
      // Decrementing `i` here to account for the removed element
      if (i > 0) i--;
    }

    if (this.#pendingMessages.length > 0) {
      this.#logger.warn(
        `Failed to publish ${this.#pendingMessages.length} pending messages`
      );
    }
  }

  public async close() {
    if (this.#producer && this.#producer.isConnected()) {
      await this.#producer.close();
      this.#producer = undefined;
    }
  }

  public async publish(
    type: string,
    data: any,
    properties?: Record<string, string>,
    options?: EventPublishOptions
  ): Promise<string | undefined> {
    if (!this.#producer) {
      if (
        this.#status === "waitingToConnect" ||
        this.#status === "initializing"
      ) {
        const id = ulid();

        this.#logger.info(
          "Message published before connection, adding it to pending messages",
          {
            type,
            data,
            properties,
            id,
          }
        );

        this.#pendingMessages.push({
          type,
          data,
          properties,
          options: { id, ...(options ?? {}) },
        });

        return id;
      } else {
        throw new Error(
          `Cannot publish to ${
            this.#config.topic
          } because it is not connected and is in status ${this.#status}`
        );
      }
    }

    try {
      return this.#handlePublish(type, data, properties, options);
    } catch (e) {
      this.#logger.error("Error handling message", e);
    }
  }

  async #handlePublish(
    type: string,
    data: any,
    properties?: Record<string, string>,
    options?: EventPublishOptions
  ): Promise<string> {
    const id = (options ?? {}).id ?? ulid();

    this.#logger.debug("Publishing message", {
      topic: this.#config.topic,
      type,
      data,
      properties,
      options,
    });

    const message = JSON.stringify({
      id,
      type,
      data,
    });

    const response = await this.#producer!.send({
      data: Buffer.from(message),
      properties,
      deliverAfter: options?.deliverAfter,
      deliverAt: options?.deliverAt,
      partitionKey: options?.partitionKey,
      orderingKey: options?.orderingKey,
      eventTimestamp: options?.eventTimestamp,
    });

    return response.toString();
  }
}
