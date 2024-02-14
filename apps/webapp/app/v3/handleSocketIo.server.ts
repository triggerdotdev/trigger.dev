import { type Namespace, Server } from "socket.io";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

export const socketIo = singleton("socketIo", initalizeIoServer);

type VersionedMessage<TMessage> = { version: "v1" } & TMessage;

interface ProviderClientToServerEvents {
  LOG: (message: VersionedMessage<{ data: string }>) => void;
}

interface ProviderServerToClientEvents {
  INDEX: (message: VersionedMessage<{ imageTag: string; contentHash: string }>) => void;
  INDEX_COMPLETE: (message: VersionedMessage<{ imageTag: string; contentHash: string }>) => void;
}

interface ProviderInterServerEvents {
  ping: () => void;
}

interface ProviderSocketData {
  id: string;
}

function initalizeIoServer() {
  const io = new Server();

  io.on("connection", (socket) => {
    console.log(`[socket.io][${socket.id}] connection at url: ${socket.request.url}`);
  });

  const providerNamespace = createProviderNamespace(io);

  return { io, providerNamespace };
}

function createProviderNamespace(io: Server) {
  const providerNamespace: Namespace<
    ProviderClientToServerEvents,
    ProviderServerToClientEvents,
    ProviderInterServerEvents,
    ProviderSocketData
  > = io.of("/provider");

  providerNamespace.on("connection", async (socket) => {
    const logger = (...args: any[]) => console.log(`[provider][${socket.id}]`, ...args);

    logger("connected");

    socket.on("disconnect", (reason, description) => {
      logger("disconnect", { reason, description });
    });

    socket.on("error", (error) => {
      logger({ error });
    });

    socket.on("LOG", (message) => {
      logger("[LOG]", { message });
    });
  });

  // auth middleware
  providerNamespace.use((socket, next) => {
    const logger = (...args: any[]) => console.log(`[provider][${socket.id}][auth]`, ...args);

    const { auth } = socket.handshake;

    if (!("token" in auth)) {
      logger("no token");
      return socket.disconnect(true);
    }

    if (auth.token !== env.PROVIDER_SECRET) {
      logger("invalid token");
      return socket.disconnect(true);
    }

    logger("success");

    next();
  });

  return providerNamespace;
}
