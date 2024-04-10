import { Logger } from "@trigger.dev/core-backend";
import { ZodMessageCatalogSchema, ZodMessageHandler, ZodMessageSender } from "@trigger.dev/core/v3";
import { Evt } from "evt";
import Redis, { RedisOptions } from "ioredis";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { safeJsonParse } from "~/utils/json";

export type ZodPubSubOptions<TMessageCatalog extends ZodMessageCatalogSchema> = {
  redis: RedisOptions;
  schema: TMessageCatalog;
};

export interface ZodSubscriber<TMessageCatalog extends ZodMessageCatalogSchema> {
  on<K extends keyof TMessageCatalog>(
    eventName: K,
    listener: (payload: z.infer<TMessageCatalog[K]>) => Promise<void>
  ): void;

  stopListening(): Promise<void>;
}

class RedisZodSubscriber<TMessageCatalog extends ZodMessageCatalogSchema>
  implements ZodSubscriber<TMessageCatalog>
{
  private _subscriber: Redis;
  private _listeners: Map<string, (payload: unknown) => Promise<void>> = new Map();
  private _messageHandler: ZodMessageHandler<TMessageCatalog>;

  public onUnsubscribed: Evt<{
    pattern: string;
  }> = new Evt();

  constructor(
    private readonly _pattern: string,
    private readonly _options: ZodPubSubOptions<TMessageCatalog>,
    private readonly _logger: Logger
  ) {
    this._subscriber = new Redis(_options.redis);
    this._messageHandler = new ZodMessageHandler({
      schema: _options.schema,
    });
  }

  async initialize() {
    await this._subscriber.psubscribe(this._pattern);
    this._subscriber.on("pmessage", this.#onMessage.bind(this));
  }

  public on<K extends keyof TMessageCatalog>(
    eventName: K,
    listener: (payload: z.infer<TMessageCatalog[K]>) => Promise<void>
  ): void {
    this._listeners.set(eventName as string, listener);
  }

  public async stopListening(): Promise<void> {
    this._listeners.clear();
    await this._subscriber.punsubscribe();

    this.onUnsubscribed.post({ pattern: this._pattern });
  }

  async #onMessage(pattern: string, channel: string, serializedMessage: string) {
    if (pattern !== this._pattern) {
      return;
    }

    const parsedMessage = safeJsonParse(serializedMessage);

    if (!parsedMessage) {
      return;
    }

    const message = this._messageHandler.parseMessage(parsedMessage);

    if (typeof message.type !== "string") {
      return;
    }

    const listener = this._listeners.get(message.type);

    if (!listener) {
      this._logger.debug(`No listener for message type: ${message.type}`, { parsedMessage });

      return;
    }

    try {
      await listener(message.payload);
    } catch (error) {
      this._logger.error("Error handling message", { error, message });
    }
  }
}

export class ZodPubSub<TMessageCatalog extends ZodMessageCatalogSchema> {
  private _publisher: Redis;
  private _logger = logger.child({ module: "ZodPubSub" });
  private _subscriberCount = 0;

  get subscriberCount() {
    return this._subscriberCount;
  }

  constructor(private _options: ZodPubSubOptions<TMessageCatalog>) {
    this._publisher = new Redis(_options.redis);
  }

  public async publish<K extends keyof TMessageCatalog>(
    channel: string,
    type: K,
    payload: z.input<TMessageCatalog[K]>
  ): Promise<void> {
    try {
      await this._publisher.publish(channel, JSON.stringify({ type, payload, version: "v1" }));
    } catch (e) {
      logger.error("Failed to publish message", { channel, type, payload, error: e });
    }
  }

  public async subscribe(channel: string): Promise<ZodSubscriber<TMessageCatalog>> {
    const subscriber = new RedisZodSubscriber(channel, this._options, this._logger);

    await subscriber.initialize();

    this._subscriberCount++;

    subscriber.onUnsubscribed.attachOnce(({ pattern }) => {
      logger.debug("Subscriber unsubscribed", { pattern });

      this._subscriberCount--;
    });

    return subscriber;
  }
}
