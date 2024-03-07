import { ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import {
  GetSocketCallbackSchema,
  GetSocketMessageSchema,
  GetSocketMessagesWithCallback,
  GetSocketMessagesWithoutCallback,
  ZodSocketMessageCatalogSchema,
  ZodSocketMessageHandler,
  ZodSocketMessageHandlers,
} from "./zodSocket";
import { z } from "zod";

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
  process:
    | ChildProcess
    | NodeJS.Process
    | {
        send?: (message: any) => any;
        on?: (event: "message", listener: (message: any) => void) => void;
      };
  handlers?: ZodSocketMessageHandlers<TListenCatalog>;
}

export class ZodIpcConnection<
  TListenCatalog extends ZodSocketMessageCatalogSchema,
  TEmitCatalog extends ZodSocketMessageCatalogSchema,
> {
  #sessionId?: string;
  #messageCounter: number = 0;

  #handler: ZodSocketMessageHandler<TListenCatalog>;

  #acks: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: any) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();

  #process:
    | ChildProcess
    | NodeJS.Process
    | {
        send?: (message: any) => any;
        on?: (event: "message", listener: (message: any) => void) => void;
      };

  constructor(private opts: ZodIpcConnectionOptions<TListenCatalog, TEmitCatalog>) {
    this.#process = opts.process;

    this.#handler = new ZodSocketMessageHandler({
      schema: opts.listenSchema,
      handlers: opts.handlers,
    });

    this.#registerHandlers();
    this.connect();
  }

  async #registerHandlers() {
    if (!this.#process.on) {
      return;
    }

    this.#process.on("message", async (message) => {
      this.#handlePacket(message);
    });
  }

  async connect() {
    this.#sendPacket({ type: "CONNECT" });
  }

  async #handlePacket(packet: Packet): Promise<void> {
    const parsedPacket = Packet.safeParse(packet);

    if (!parsedPacket.success) {
      console.error("dropping invalid packet", packet);
      return;
    }

    console.log("<-", packet);

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
          console.log("client connected:", id);

          return;
        }

        // This is a server replying to our connect message
        if (this.#sessionId) {
          // We're already connected
          return;
        }

        this.#sessionId = parsedPacket.data.sessionId;
        console.log("connected to server:", this.#sessionId);

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
    console.log("->", packet);
    await this.#process.send?.(packet);
  }

  async send<K extends GetSocketMessagesWithoutCallback<TEmitCatalog>>(
    type: K,
    payload: z.input<GetSocketMessageSchema<TEmitCatalog, K>>
  ): Promise<void> {
    const schema = this.opts.emitSchema[type]["message"];

    if (!schema) {
      throw new Error(`Unknown message type: ${type as string}`);
    }

    const parsedPayload = schema.safeParse(payload);

    if (!parsedPayload.success) {
      throw new Error(`Failed to parse message payload: ${JSON.stringify(parsedPayload.error)}`);
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
      // Timeout if the ACK takes too long to get back to us
      const timeout = setTimeout(() => {
        reject("timeout");
      }, timeoutInMs ?? 2000);

      this.#acks.set(currentId, { resolve, reject, timeout });

      const schema = this.opts.emitSchema[type]["message"];

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
