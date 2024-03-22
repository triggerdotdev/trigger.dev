import { DisconnectReason, Namespace, Server, Socket } from "socket.io";
import { ZodMessageSender } from "./zodMessageHandler";
import {
  ZodMessageCatalogToSocketIoEvents,
  ZodSocketMessageCatalogSchema,
  ZodSocketMessageHandler,
  ZodSocketMessageHandlers,
} from "./zodSocket";
import { DefaultEventsMap, EventsMap } from "socket.io/dist/typed-events";
import { z } from "zod";

interface ExtendedError extends Error {
  data?: any;
}

export type ZodNamespaceSocket<
  TClientMessages extends ZodSocketMessageCatalogSchema,
  TServerMessages extends ZodSocketMessageCatalogSchema,
  TServerSideEvents extends EventsMap = DefaultEventsMap,
  TSocketData extends z.ZodObject<any, any, any> = any,
> = Socket<
  ZodMessageCatalogToSocketIoEvents<TClientMessages>,
  ZodMessageCatalogToSocketIoEvents<TServerMessages>,
  TServerSideEvents,
  z.infer<TSocketData>
>;

interface ZodNamespaceOptions<
  TClientMessages extends ZodSocketMessageCatalogSchema,
  TServerMessages extends ZodSocketMessageCatalogSchema,
  TServerSideEvents extends EventsMap = DefaultEventsMap,
  TSocketData extends z.ZodObject<any, any, any> = any,
> {
  io: Server;
  name: string;
  clientMessages: TClientMessages;
  serverMessages: TServerMessages;
  socketData?: TSocketData;
  handlers?: ZodSocketMessageHandlers<TClientMessages>;
  authToken?: string;
  preAuth?: (
    socket: ZodNamespaceSocket<TClientMessages, TServerMessages, TServerSideEvents, TSocketData>,
    next: (err?: ExtendedError) => void,
    logger: (...args: any[]) => void
  ) => Promise<void>;
  postAuth?: (
    socket: ZodNamespaceSocket<TClientMessages, TServerMessages, TServerSideEvents, TSocketData>,
    next: (err?: ExtendedError) => void,
    logger: (...args: any[]) => void
  ) => Promise<void>;
  onConnection?: (
    socket: ZodNamespaceSocket<TClientMessages, TServerMessages, TServerSideEvents, TSocketData>,
    handler: ZodSocketMessageHandler<TClientMessages>,
    sender: ZodMessageSender<TServerMessages>,
    logger: (...args: any[]) => void
  ) => Promise<void>;
  onDisconnect?: (
    socket: ZodNamespaceSocket<TClientMessages, TServerMessages, TServerSideEvents, TSocketData>,
    reason: DisconnectReason,
    description: any,
    logger: (...args: any[]) => void
  ) => Promise<void>;
  onError?: (
    socket: ZodNamespaceSocket<TClientMessages, TServerMessages, TServerSideEvents, TSocketData>,
    err: Error,
    logger: (...args: any[]) => void
  ) => Promise<void>;
}

export class ZodNamespace<
  TClientMessages extends ZodSocketMessageCatalogSchema,
  TServerMessages extends ZodSocketMessageCatalogSchema,
  TSocketData extends z.ZodObject<any, any, any> = any,
  TServerSideEvents extends EventsMap = DefaultEventsMap,
> {
  #handler: ZodSocketMessageHandler<TClientMessages>;
  sender: ZodMessageSender<TServerMessages>;

  io: Server;
  namespace: Namespace<
    ZodMessageCatalogToSocketIoEvents<TClientMessages>,
    ZodMessageCatalogToSocketIoEvents<TServerMessages>,
    TServerSideEvents,
    z.infer<TSocketData>
  >;

  constructor(
    opts: ZodNamespaceOptions<TClientMessages, TServerMessages, TServerSideEvents, TSocketData>
  ) {
    this.#handler = new ZodSocketMessageHandler({
      schema: opts.clientMessages,
      handlers: opts.handlers,
    });

    this.io = opts.io;

    this.namespace = this.io.of(opts.name);

    // FIXME: There's a bug here, this sender should not accept Socket schemas with callbacks
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
      this.namespace.use(async (socket, next) => {
        const logger = createLogger(`[${opts.name}][${socket.id}][preAuth]`);

        if (typeof opts.preAuth === "function") {
          await opts.preAuth(socket, next, logger);
        }
      });
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
      this.namespace.use(async (socket, next) => {
        const logger = createLogger(`[${opts.name}][${socket.id}][postAuth]`);

        if (typeof opts.postAuth === "function") {
          await opts.postAuth(socket, next, logger);
        }
      });
    }

    this.namespace.on("connection", async (socket) => {
      const logger = createLogger(`[${opts.name}][${socket.id}]`);
      logger("connection");

      this.#handler.registerHandlers(socket, logger);

      socket.on("disconnect", async (reason, description) => {
        logger("disconnect", { reason, description });

        if (opts.onDisconnect) {
          await opts.onDisconnect(socket, reason, description, logger);
        }
      });

      socket.on("error", async (error) => {
        logger("error", error);

        if (opts.onError) {
          await opts.onError(socket, error, logger);
        }
      });

      if (opts.onConnection) {
        await opts.onConnection(socket, this.#handler, this.sender, logger);
      }
    });
  }

  fetchSockets() {
    return this.namespace.fetchSockets();
  }
}

function createLogger(prefix: string) {
  return (...args: any[]) => console.log(prefix, ...args);
}
