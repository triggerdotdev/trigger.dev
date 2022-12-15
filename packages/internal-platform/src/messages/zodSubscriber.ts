import {
  Client as PulsarClient,
  Consumer as PulsarConsumer,
  ConsumerConfig as PulsarConsumerConfig,
  Message as PulsarMessage,
} from "pulsar-client";
import { Logger } from "../logger";
import {
  MessageCatalogSchema,
  MessageData,
  MessageDataSchema,
} from "./messageCatalogSchema";

import { z, ZodError } from "zod";

export type ZodSubscriberHandlers<
  TConsumerSchema extends MessageCatalogSchema
> = {
  [K in keyof TConsumerSchema]: (
    id: string,
    data: z.infer<TConsumerSchema[K]["data"]>,
    properties: z.infer<TConsumerSchema[K]["properties"]>
  ) => Promise<boolean>;
};

export type ZodSubscriberOptions<
  SubscriberSchema extends MessageCatalogSchema
> = {
  client: PulsarClient;
  subscriberConfig: Omit<PulsarConsumerConfig, "listener">;
  subscriberSchema: SubscriberSchema;
  handlers: ZodSubscriberHandlers<SubscriberSchema>;
};

export class ZodSubscriber<SubscriberSchema extends MessageCatalogSchema> {
  #subscriberConfig: Omit<PulsarConsumerConfig, "listener">;
  #subscriberSchema: SubscriberSchema;
  #handlers: ZodSubscriberHandlers<SubscriberSchema>;

  #subscriber?: PulsarConsumer;
  #client: PulsarClient;

  #logger: Logger;

  constructor(options: ZodSubscriberOptions<SubscriberSchema>) {
    this.#subscriberConfig = options.subscriberConfig;
    this.#subscriberSchema = options.subscriberSchema;
    this.#handlers = options.handlers;
    this.#client = options.client;
    this.#logger = new Logger("trigger.dev subscriber", "info");
  }

  public async initialize(): Promise<boolean> {
    try {
      this.#logger.debug(
        `Initializing subscriber with config ${JSON.stringify(
          this.#subscriberConfig
        )}`
      );

      this.#subscriber = await this.#client.subscribe({
        ...this.#subscriberConfig,
        listener: this.#onMessage.bind(this),
      });

      return true;
    } catch (e) {
      this.#logger.error("Error initializing subscriber", e);

      return false;
    }
  }

  public async close() {
    if (this.#subscriber) {
      await this.#subscriber.close();
      this.#subscriber = undefined;
    }
  }

  async #onMessage(msg: PulsarMessage, consumer: PulsarConsumer) {
    const messageData = MessageDataSchema.parse(
      JSON.parse(msg.getData().toString())
    );

    const properties = msg.getProperties();

    try {
      const wasHandled = await this.#handleMessage(messageData, properties);

      if (wasHandled) {
        await consumer.acknowledge(msg);
      }
    } catch (e) {
      if (e instanceof ZodError) {
        console.error(
          "[ZodSubscriber] Received invalid message data or properties",
          messageData,
          properties
        );
      } else {
        console.error("[ZodSubscriber] Error handling message", e);
      }

      consumer.negativeAcknowledge(msg);
    }
  }

  async #handleMessage<K extends keyof SubscriberSchema>(
    rawMessage: MessageData,
    rawProperties: Record<string, string> = {}
  ): Promise<boolean> {
    const subscriberSchema = this.#subscriberSchema;
    type TypeKeys = keyof typeof subscriberSchema;
    const typeName = rawMessage.type as TypeKeys;

    const messageSchema: SubscriberSchema[TypeKeys] | undefined =
      subscriberSchema[typeName];

    if (!messageSchema) {
      throw new Error(`Unknown message type: ${rawMessage.type}`);
    }

    this.#logger.info(
      `Handling message of type ${rawMessage.type}, parsing data and properties`,
      rawMessage.data,
      rawProperties
    );

    const message = messageSchema.data.parse(rawMessage.data);
    const properties = messageSchema.properties.parse(rawProperties);

    const handler = this.#handlers[typeName];

    const returnValue = await handler(rawMessage.id, message, properties);

    return returnValue;
  }
}
