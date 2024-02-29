import { DisconnectReason, Namespace, Server, Socket } from "socket.io";
import {
  ZodMessageCatalogSchema,
  ZodMessageHandlerOptions,
  MessageCatalogToSocketIoEvents,
  ZodMessageHandler,
  ZodMessageSender,
} from "./zodMessageHandler";

interface ExtendedError extends Error {
  data?: any;
}

interface ZodNamespaceOptions<
  TClientMessages extends ZodMessageCatalogSchema,
  TServerMessages extends ZodMessageCatalogSchema,
> {
  io: Server;
  name: string;
  clientMessages: TClientMessages;
  serverMessages: TServerMessages;
  messageHandler?: ZodMessageHandlerOptions<TClientMessages>["messages"];
  authToken?: string;
  preAuth?: (
    socket: Socket<
      MessageCatalogToSocketIoEvents<TClientMessages>,
      MessageCatalogToSocketIoEvents<TServerMessages>
    >,
    next: (err?: ExtendedError) => void
  ) => void;
  postAuth?: (
    socket: Socket<
      MessageCatalogToSocketIoEvents<TClientMessages>,
      MessageCatalogToSocketIoEvents<TServerMessages>
    >,
    next: (err?: ExtendedError) => void
  ) => void;
  onConnection?: (
    socket: Socket<
      MessageCatalogToSocketIoEvents<TClientMessages>,
      MessageCatalogToSocketIoEvents<TServerMessages>
    >,
    handler: ZodMessageHandler<TClientMessages>,
    sender: ZodMessageSender<TServerMessages>,
    logger: (...args: any[]) => void
  ) => Promise<void>;
  onDisconnect?: (
    reason: DisconnectReason,
    description: any,
    logger: (...args: any[]) => void
  ) => Promise<void>;
  onError?: (err: Error, logger: (...args: any[]) => void) => Promise<void>;
}

export class ZodNamespace<
  TClientMessages extends ZodMessageCatalogSchema,
  TServerMessages extends ZodMessageCatalogSchema,
> {
  #handler: ZodMessageHandler<TClientMessages>;
  sender: ZodMessageSender<TServerMessages>;

  io: Server;
  namespace: Namespace<
    MessageCatalogToSocketIoEvents<TClientMessages>,
    MessageCatalogToSocketIoEvents<TServerMessages>
  >;

  constructor(opts: ZodNamespaceOptions<TClientMessages, TServerMessages>) {
    this.#handler = new ZodMessageHandler({
      schema: opts.clientMessages,
      messages: opts.messageHandler,
    });

    this.io = opts.io;

    this.namespace = this.io.of(opts.name);

    this.sender = new ZodMessageSender({
      schema: opts.serverMessages,
      sender: async (message) => {
        return new Promise((resolve, reject) => {
          try {
            // @ts-expect-error
            this.namespace.emit(message.type, message.payload);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      },
    });

    if (opts.preAuth) {
      this.namespace.use(opts.preAuth);
    }

    if (opts.authToken) {
      this.namespace.use((socket, next) => {
        const logger = createLogger(`[${opts.name}][${socket.id}][auth]`);

        const { auth } = socket.handshake;

        if (!("token" in auth)) {
          logger("no token");
          return socket.disconnect(true);
        }

        if (auth.token !== opts.authToken) {
          logger("invalid token");
          return socket.disconnect(true);
        }

        logger("success");

        next();
      });
    }

    if (opts.postAuth) {
      this.namespace.use(opts.postAuth);
    }

    this.namespace.on("connection", async (socket) => {
      const logger = createLogger(`[${opts.name}][${socket.id}]`);
      logger("connection");

      this.#handler.registerHandlers(socket, logger);

      socket.on("disconnect", async (reason, description) => {
        logger("disconnect", { reason, description });

        if (opts.onDisconnect) {
          await opts.onDisconnect(reason, description, logger);
        }
      });

      socket.on("error", async (error) => {
        logger("error", error);

        if (opts.onError) {
          await opts.onError(error, logger);
        }
      });

      if (opts.onConnection) {
        await opts.onConnection(socket, this.#handler, this.sender, logger);
      }
    });
  }
}

function createLogger(prefix: string) {
  return (...args: any[]) => console.log(prefix, ...args);
}
