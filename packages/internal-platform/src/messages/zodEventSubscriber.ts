import type {
  Client as PulsarClient,
  Consumer as PulsarConsumer,
  ConsumerConfig as PulsarConsumerConfig,
  Message as PulsarMessage,
} from "pulsar-client";
import { Logger } from "../logger";
import { MessageData, MessageDataSchema } from "./messageCatalogSchema";
import { ZodPubSubStatus } from "./types";
import { SubscriberMessageAttributes } from "./zodSubscriber";

export type ZodEventSubscriberHandler = (
  id: string,
  name: string,
  data: any,
  properties: Record<string, string>,
  attributes: SubscriberMessageAttributes
) => Promise<boolean>;

export type ZodEventSubscriberOptions = {
  client: PulsarClient;
  config: Omit<PulsarConsumerConfig, "listener">;
  handler: ZodEventSubscriberHandler;
  filter?: Record<string, string>;
};

export class ZodEventSubscriber {
  #config: Omit<PulsarConsumerConfig, "listener">;
  #handler: ZodEventSubscriberHandler;
  #subscriber?: PulsarConsumer;
  #client: PulsarClient;
  #status: ZodPubSubStatus = "waitingToConnect";
  #filter: Record<string, string> = {};

  #logger: Logger;

  constructor(options: ZodEventSubscriberOptions) {
    this.#config = options.config;
    this.#handler = options.handler;
    this.#client = options.client;
    this.#filter = options.filter || {};
    this.#logger = new Logger("trigger.dev event subscriber");
  }

  public async initialize(): Promise<boolean> {
    if (this.#status !== "waitingToConnect") {
      return this.#status === "ready";
    }

    this.#status = "initializing";

    try {
      this.#logger.debug(
        `Initializing subscriber with config ${JSON.stringify(this.#config)}`
      );

      this.#subscriber = await this.#client.subscribe({
        ...this.#config,
        listener: this.#onMessage.bind(this),
      });

      this.#status = "ready";

      return true;
    } catch (e) {
      this.#status = "error";

      this.#logger.error("Error initializing subscriber", e);

      return false;
    }
  }

  public async close() {
    if (this.#subscriber && this.#subscriber.isConnected()) {
      this.#logger.debug(
        `Closing subscriber with config ${JSON.stringify(this.#config)}`
      );

      await this.#subscriber.unsubscribe();
      this.#subscriber = undefined;
    }
  }

  #getRawProperties(msg: PulsarMessage): Record<string, string> {
    const properties = msg.getProperties();

    if (Array.isArray(properties)) {
      return Object.keys(properties).reduce((acc, key) => {
        acc[key] = properties[key];

        return acc;
      }, {} as Record<string, string>);
    }

    return properties;
  }

  async #onMessage(msg: PulsarMessage, consumer: PulsarConsumer) {
    const messageData = MessageDataSchema.parse(
      JSON.parse(msg.getData().toString())
    );

    const properties = this.#getRawProperties(msg);

    if (this.#filter) {
      const filterKeys = Object.keys(this.#filter);

      for (const key of filterKeys) {
        if (properties[key] !== this.#filter[key]) {
          return;
        }
      }
    }

    const messageId = msg.getMessageId();
    const publishedTimestamp = msg.getPublishTimestamp();
    const eventTimestamp = msg.getEventTimestamp();
    const redeliveryCount = msg.getRedeliveryCount();

    this.#logger.debug("#onMessage", {
      messageId,
      publishedTimestamp,
      eventTimestamp,
      redeliveryCount,
    });

    const messageAttributes = {
      eventTimestamp:
        eventTimestamp === 0 ? undefined : new Date(eventTimestamp),
      messageId: messageId.toString(),
      publishedTimestamp: new Date(publishedTimestamp),
      redeliveryCount,
    };

    try {
      const wasHandled = await this.#handleMessage(
        messageData,
        properties,
        messageAttributes
      );

      if (wasHandled) {
        await consumer.acknowledge(msg);
      }
    } catch (e) {
      this.#logger.error("Error handling message", e);

      // TODO: Add support for dead letter queue
      await consumer.acknowledge(msg);
    }
  }

  async #handleMessage(
    rawMessage: MessageData,
    rawProperties: Record<string, string> = {},
    messageAttributes: SubscriberMessageAttributes
  ): Promise<boolean> {
    this.#logger.debug("Received message, calling handler", {
      topic: this.#config.topic,
      subscription: this.#config.subscription,
      type: rawMessage.type,
      message: rawMessage.data,
      properties: rawProperties,
    });

    const returnValue = await this.#handler(
      rawMessage.id,
      rawMessage.type,
      rawMessage.data,
      rawProperties,
      messageAttributes
    );

    return returnValue;
  }
}
