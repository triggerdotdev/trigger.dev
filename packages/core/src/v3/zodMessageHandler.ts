import { z } from "zod";

export interface ZodMessageCatalogSchema {
  [key: string]: z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;
}

export type ZodMessageHandlers<TCatalogSchema extends ZodMessageCatalogSchema> = {
  [K in keyof TCatalogSchema]: (payload: z.infer<TCatalogSchema[K]>) => Promise<void>;
};

export type ZodMessageHandlerOptions<TMessageCatalog extends ZodMessageCatalogSchema> = {
  schema: TMessageCatalog;
  messages: ZodMessageHandlers<TMessageCatalog>;
};

export class ZodMessageHandler<TMessageCatalog extends ZodMessageCatalogSchema> {
  #schema: TMessageCatalog;
  #handlers: ZodMessageHandlers<TMessageCatalog>;

  constructor(options: ZodMessageHandlerOptions<TMessageCatalog>) {
    this.#schema = options.schema;
    this.#handlers = options.messages;
  }

  public async handleMessage(message: unknown) {
    const parsedMessage = z
      .object({
        type: z.string(),
        payload: z.unknown(),
      })
      .safeParse(message);

    if (!parsedMessage.success) {
      throw new Error(`Failed to parse message: ${JSON.stringify(parsedMessage.error)}`);
    }

    const schema = this.#schema[parsedMessage.data.type];

    if (!schema) {
      throw new Error(`Unknown message type: ${parsedMessage.data.type}`);
    }

    const parsedPayload = schema.safeParse(parsedMessage.data.payload);

    if (!parsedPayload.success) {
      throw new Error(`Failed to parse message payload: ${JSON.stringify(parsedPayload.error)}`);
    }

    const handler = this.#handlers[parsedMessage.data.type];

    if (!handler) {
      throw new Error(`Unknown message type: ${parsedMessage.data.type}`);
    }

    await handler(parsedPayload.data);
  }
}

type ZodMessageSenderCallback<TMessageCatalog extends ZodMessageCatalogSchema> = (message: {
  type: keyof TMessageCatalog;
  payload: z.infer<TMessageCatalog[keyof TMessageCatalog]>;
}) => Promise<void>;

export type ZodMessageSenderOptions<TMessageCatalog extends ZodMessageCatalogSchema> = {
  schema: TMessageCatalog;
  sender: ZodMessageSenderCallback<TMessageCatalog>;
};

export class ZodMessageSender<TMessageCatalog extends ZodMessageCatalogSchema> {
  #schema: TMessageCatalog;
  #sender: ZodMessageSenderCallback<TMessageCatalog>;

  constructor(options: ZodMessageSenderOptions<TMessageCatalog>) {
    this.#schema = options.schema;
    this.#sender = options.sender;
  }

  public async send<K extends keyof TMessageCatalog>(
    type: K,
    payload: z.infer<TMessageCatalog[K]>
  ) {
    const schema = this.#schema[type];

    if (!schema) {
      throw new Error(`Unknown message type: ${type as string}`);
    }

    const parsedPayload = schema.safeParse(payload);

    if (!parsedPayload.success) {
      throw new Error(`Failed to parse message payload: ${JSON.stringify(parsedPayload.error)}`);
    }

    await this.#sender({ type, payload });
  }
}
