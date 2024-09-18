import { randomUUID } from "crypto";
import {
  GetSocketCallbackSchema,
  GetSocketMessageSchema,
  GetSocketMessagesWithCallback,
  GetSocketMessagesWithoutCallback,
  MessagesFromSocketCatalog,
  SocketMessageHasCallback,
  ZodSocketMessageCatalogSchema,
} from "./zodSocket.js";
import { z } from "zod";
import { ZodSchemaParsedError } from "./zodMessageHandler.js";
import { inspect } from "node:util";
import {
  ExecutorToWorkerMessageCatalog,
  WorkerToExecutorMessageCatalog,
} from "./schemas/messages.js";

interface ZodIpcMessageSender<TEmitCatalog extends ZodSocketMessageCatalogSchema> {
  send<K extends GetSocketMessagesWithoutCallback<TEmitCatalog>>(
    type: K,
    payload: z.input<GetSocketMessageSchema<TEmitCatalog, K>>
  ): Promise<void>;

  sendWithAck<K extends GetSocketMessagesWithCallback<TEmitCatalog>>(
    type: K,
    payload: z.input<GetSocketMessageSchema<TEmitCatalog, K>>
  ): Promise<z.infer<GetSocketCallbackSchema<TEmitCatalog, K>>>;
}

type ZodIpcMessageHandlers<
  TListenCatalog extends ZodSocketMessageCatalogSchema,
  TEmitCatalog extends ZodSocketMessageCatalogSchema,
> = Partial<{
  [K in keyof TListenCatalog]: (
    payload: z.infer<GetSocketMessageSchema<TListenCatalog, K>>,
    sender: ZodIpcMessageSender<TEmitCatalog>
  ) => Promise<
    SocketMessageHasCallback<TListenCatalog, K> extends true
      ? z.input<GetSocketCallbackSchema<TListenCatalog, K>>
      : void
  >;
}>;

const messageSchema = z.object({
  version: z.literal("v1").default("v1"),
  type: z.string(),
  payload: z.unknown(),
});

type ZodIpcMessageHandlerOptions<
  TListenCatalog extends ZodSocketMessageCatalogSchema,
  TEmitCatalog extends ZodSocketMessageCatalogSchema,
> = {
  schema: TListenCatalog;
  handlers?: ZodIpcMessageHandlers<TListenCatalog, TEmitCatalog>;
  sender: ZodIpcMessageSender<TEmitCatalog>;
};

class ZodIpcMessageHandler<
  TListenCatalog extends ZodSocketMessageCatalogSchema,
  TEmitCatalog extends ZodSocketMessageCatalogSchema,
> {
  #schema: TListenCatalog;
  #handlers: ZodIpcMessageHandlers<TListenCatalog, TEmitCatalog> | undefined;
  #sender: ZodIpcMessageSender<TEmitCatalog>;

  constructor(options: ZodIpcMessageHandlerOptions<TListenCatalog, TEmitCatalog>) {
    this.#schema = options.schema;
    this.#handlers = options.handlers;
    this.#sender = options.sender;
  }

  public async handleMessage(message: unknown) {
    const parsedMessage = this.parseMessage(message);

    if (!this.#handlers) {
      throw new Error("No handlers provided");
    }

    const handler = this.#handlers[parsedMessage.type];

    if (!handler) {
      // console.error(`No handler for message type: ${String(parsedMessage.type)}`);
      return;
    }

    const ack = await handler(parsedMessage.payload, this.#sender);

    return ack;
  }

  public parseMessage(message: unknown): MessagesFromSocketCatalog<TListenCatalog> {
    const parsedMessage = messageSchema.safeParse(message);

    if (!parsedMessage.success) {
      throw new Error(`Failed to parse message: ${JSON.stringify(parsedMessage.error)}`);
    }
    const schema = this.#schema[parsedMessage.data.type]?.["message"];

    if (!schema) {
      throw new Error(`Unknown message type: ${parsedMessage.data.type}`);
    }

    const parsedPayload = schema.safeParse(parsedMessage.data.payload);

    if (!parsedPayload.success) {
      throw new Error(`Failed to parse message payload: ${JSON.stringify(parsedPayload.error)}`);
    }

    return {
      type: parsedMessage.data.type,
      payload: parsedPayload.data,
    };
  }
}

const Packet = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("CONNECT"),
    sessionId: z.string().optional(),
  }),
  z.object({
    type: z.literal("ACK"),
    message: z.any(),
    id: z.number(),
  }),
  z.object({
    type: z.literal("EVENT"),
    message: z.any(),
    id: z.number().optional(),
  }),
]);

type Packet = z.infer<typeof Packet>;

interface ZodIpcConnectionOptions<
  TListenCatalog extends ZodSocketMessageCatalogSchema,
  TEmitCatalog extends ZodSocketMessageCatalogSchema,
> {
  listenSchema: TListenCatalog;
  emitSchema: TEmitCatalog;
  process: {
    send?: (message: any) => any;
    on?: (event: "message", listener: (message: any) => void) => void;
  };
  handlers?: ZodIpcMessageHandlers<TListenCatalog, TEmitCatalog>;
}

export class ZodIpcConnection<
  TListenCatalog extends ZodSocketMessageCatalogSchema,
  TEmitCatalog extends ZodSocketMessageCatalogSchema,
> {
  #sessionId?: string;
  #messageCounter: number = 0;

  #handler: ZodIpcMessageHandler<TListenCatalog, TEmitCatalog>;

  #acks: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: any) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();

  constructor(private opts: ZodIpcConnectionOptions<TListenCatalog, TEmitCatalog>) {
    this.#handler = new ZodIpcMessageHandler({
      schema: opts.listenSchema,
      handlers: opts.handlers,
      sender: {
        send: this.send.bind(this),
        sendWithAck: this.sendWithAck.bind(this),
      },
    });

    this.#registerHandlers();
    // this.connect();
  }

  async #registerHandlers() {
    if (!this.opts.process.on) {
      return;
    }

    this.opts.process.on("message", async (message) => {
      this.#handlePacket(message);
    });
  }

  async connect() {
    this.#sendPacket({ type: "CONNECT" });
  }

  async #handlePacket(packet: Packet): Promise<void> {
    const parsedPacket = Packet.safeParse(packet);

    if (!parsedPacket.success) {
      return;
    }

    switch (parsedPacket.data.type) {
      case "ACK": {
        // Check our list of ACKs and resolve with the message
        const ack = this.#acks.get(parsedPacket.data.id);

        if (!ack) {
          return;
        }

        clearTimeout(ack.timeout);
        ack.resolve(parsedPacket.data.message);

        break;
      }
      case "CONNECT": {
        if (!parsedPacket.data.sessionId) {
          // This is a client trying to connect, so we generate and send back a session ID
          const id = randomUUID();

          await this.#sendPacket({ type: "CONNECT", sessionId: id });

          return;
        }

        // This is a server replying to our connect message
        if (this.#sessionId) {
          // We're already connected
          return;
        }

        this.#sessionId = parsedPacket.data.sessionId;

        break;
      }
      case "EVENT": {
        const result = await this.#handler.handleMessage(parsedPacket.data.message);

        if (typeof parsedPacket.data.id === "undefined") {
          return;
        }

        // There's an ID so we should ACK
        await this.#sendPacket({
          type: "ACK",
          id: parsedPacket.data.id,
          message: result,
        });

        break;
      }
      default: {
        break;
      }
    }
  }

  async #sendPacket(packet: Packet) {
    await this.opts.process.send?.(packet);
  }

  async send<K extends GetSocketMessagesWithoutCallback<TEmitCatalog>>(
    type: K,
    payload: z.input<GetSocketMessageSchema<TEmitCatalog, K>>
  ): Promise<void> {
    const schema = this.opts.emitSchema[type]?.["message"];

    if (!schema) {
      throw new Error(`Unknown message type: ${type as string}`);
    }

    const parsedPayload = schema.safeParse(payload);

    if (!parsedPayload.success) {
      throw new ZodSchemaParsedError(parsedPayload.error, payload);
    }

    await this.#sendPacket({
      type: "EVENT",
      message: {
        type,
        payload,
        version: "v1",
      },
    });
  }

  public async sendWithAck<K extends GetSocketMessagesWithCallback<TEmitCatalog>>(
    type: K,
    payload: z.input<GetSocketMessageSchema<TEmitCatalog, K>>,
    timeoutInMs?: number
  ): Promise<z.infer<GetSocketCallbackSchema<TEmitCatalog, K>>> {
    const currentId = this.#messageCounter++;

    return new Promise(async (resolve, reject) => {
      const defaultTimeoutInMs = 2000;

      // Timeout if the ACK takes too long to get back to us
      const timeout = setTimeout(() => {
        reject(
          JSON.stringify({
            reason: "sendWithAck() timeout",
            timeoutInMs: timeoutInMs ?? defaultTimeoutInMs,
            type,
            payload,
          })
        );
      }, timeoutInMs ?? defaultTimeoutInMs);

      this.#acks.set(currentId, { resolve, reject, timeout });

      const schema = this.opts.emitSchema[type]?.["message"];

      if (!schema) {
        clearTimeout(timeout);
        return reject(`Unknown message type: ${type as string}`);
      }

      const parsedPayload = schema.safeParse(payload);

      if (!parsedPayload.success) {
        clearTimeout(timeout);
        return reject(`Failed to parse message payload: ${JSON.stringify(parsedPayload.error)}`);
      }

      await this.#sendPacket({
        type: "EVENT",
        message: {
          type,
          payload,
          version: "v1",
        },
        id: currentId,
      });
    });
  }
}

export type WorkerToExecutorProcessConnection = ZodIpcConnection<
  typeof ExecutorToWorkerMessageCatalog,
  typeof WorkerToExecutorMessageCatalog
>;

export type ExecutorToWorkerProcessConnection = ZodIpcConnection<
  typeof WorkerToExecutorMessageCatalog,
  typeof ExecutorToWorkerMessageCatalog
>;
