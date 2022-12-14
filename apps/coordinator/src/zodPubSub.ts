import { Logger } from "internal-bridge/logger";
import { MessageCatalogSchema } from "internal-messages";
import {
  Producer as PulsarProducer,
  Consumer as PulsarConsumer,
  Message as PulsarMessage,
  ConsumerConfig as PulsarConsumerConfig,
  ProducerConfig as PulsarPublisherConfig,
  Client as PulsarClient,
} from "pulsar-client";

import { z, ZodError } from "zod";

const MessageDataSchema = z.object({
  data: z.any(),
  id: z.string(),
  type: z.string(),
});

type MessageData = z.infer<typeof MessageDataSchema>;

export type ZodSubscriberHandlers<
  TConsumerSchema extends MessageCatalogSchema
> = {
  [K in keyof TConsumerSchema]: (
    id: string,
    data: z.infer<TConsumerSchema[K]["data"]>,
    properties: z.infer<TConsumerSchema[K]["properties"]>
  ) => Promise<boolean>;
};

export type ZodPubSubOptions<
  SubscriberSchema extends MessageCatalogSchema,
  PublisherSchema extends MessageCatalogSchema
> = {
  client: PulsarClient;
  subscriberConfig: Omit<PulsarConsumerConfig, "listener">;
  publisherConfig: PulsarPublisherConfig;
  subscriberSchema: SubscriberSchema;
  publisherSchema: PublisherSchema;
  handlers: ZodSubscriberHandlers<SubscriberSchema>;
};

export class ZodPubSub<
  SubscriberSchema extends MessageCatalogSchema,
  PublisherSchema extends MessageCatalogSchema
> {
  #subscriberConfig: Omit<PulsarConsumerConfig, "listener">;
  #publisherConfig: PulsarPublisherConfig;
  #subscriberSchema: SubscriberSchema;
  #publisherSchema: PublisherSchema;
  #handlers: ZodSubscriberHandlers<SubscriberSchema>;

  #subscriber?: PulsarConsumer;
  #publisher?: PulsarProducer;
  #client: PulsarClient;

  #logger: Logger;

  constructor(options: ZodPubSubOptions<SubscriberSchema, PublisherSchema>) {
    this.#subscriberConfig = options.subscriberConfig;
    this.#publisherConfig = options.publisherConfig;
    this.#subscriberSchema = options.subscriberSchema;
    this.#publisherSchema = options.publisherSchema;
    this.#handlers = options.handlers;
    this.#client = options.client;
    this.#logger = new Logger("trigger.dev pubsub", "info");
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
    } catch (e) {
      this.#logger.error("Error initializing subscriber", e);

      return false;
    }

    try {
      this.#logger.debug(
        `Initializing publisher with config ${JSON.stringify(
          this.#publisherConfig
        )}`
      );

      this.#publisher = await this.#client.createProducer(
        this.#publisherConfig
      );
    } catch (e) {
      this.#logger.error("Error initializing publisher", e);

      return false;
    }

    return true;
  }

  public async close() {
    if (this.#subscriber) {
      await this.#subscriber.close();
      this.#subscriber = undefined;
    }

    if (this.#publisher) {
      await this.#publisher.close();
      this.#publisher = undefined;
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
          "[ZodPubSub] Received invalid message data or properties",
          messageData,
          properties
        );
      } else {
        console.error("[ZodPubSub] Error handling message", e);
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

    const message = messageSchema.data.parse(rawMessage.data);
    const properties = messageSchema.properties.parse(rawProperties);

    const handler = this.#handlers[typeName];

    const returnValue = await handler(rawMessage.id, message, properties);

    return returnValue;
  }

  public async publish<K extends keyof PublisherSchema>(
    id: string,
    type: K,
    data: z.infer<PublisherSchema[K]["data"]>,
    properties?: z.infer<PublisherSchema[K]["properties"]>
  ): Promise<string> {
    if (!this.#publisher) {
      throw new Error("Cannot publish before establishing connection");
    }

    const message = JSON.stringify({
      id,
      type,
      data,
    });

    const response = await this.#publisher.send({
      data: Buffer.from(message),
      properties,
    });

    return response.toString();
  }
}
