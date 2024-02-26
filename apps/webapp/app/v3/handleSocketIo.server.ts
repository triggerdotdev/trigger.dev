import {
  CoordinatorToPlatformEvents,
  MessageCatalogToSocketIoEvents,
  PlatformToCoordinatorEvents,
  ProviderClientToServerEvents,
  ProviderServerToClientEvents,
  ZodMessageSender,
  clientWebsocketMessages,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { type Namespace, Server } from "socket.io";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { SharedSocketConnection } from "./sharedSocketConnection";
import { SharedQueueTasks } from "./marqs/sharedQueueConsumer.server";

export const socketIo = singleton("socketIo", initalizeIoServer);
const sharedQueueTasks = singleton("sharedQueueTasks", () => new SharedQueueTasks());

function initalizeIoServer() {
  const io = new Server();

  io.on("connection", (socket) => {
    console.log(`[socket.io][${socket.id}] connection at url: ${socket.request.url}`);
  });

  const coordinatorNamespace = createCoordinatorNamespace(io);
  const providerNamespace = createProviderNamespace(io);
  const sharedQueueConsumerNamespace = createSharedQueueConsumerNamespace(io);

  return { io, providerNamespace };
}

function createLogger(prefix: string) {
  return (...args: any[]) => console.log(prefix, ...args);
}

function createCoordinatorNamespace(io: Server) {
  const coordinatorNamespace: Namespace<CoordinatorToPlatformEvents, PlatformToCoordinatorEvents> =
    io.of("/coordinator");

  coordinatorNamespace.on("connection", async (socket) => {
    const logger = createLogger(`[coordinator][${socket.id}]`);

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

    socket.on("READY_FOR_EXECUTION", async (message, callback) => {
      logger("[READY_FOR_EXECUTION]", { message });

      const payload = await sharedQueueTasks.getExecutionPayloadFromAttempt(message.attemptId);
      callback({ payload });
    });

    socket.on("TASK_RUN_COMPLETED", async (message) => {
      logger("[TASK_RUN_COMPLETED]", { runId: message.execution.run.id });

      await sharedQueueTasks.completeTaskRun(message.completion, message.execution);
    });

    socket.on("TASK_HEARTBEAT", async (message) => {
      logger("[TASK_HEARTBEAT]", { runId: message.runId });

      await sharedQueueTasks.taskHeartbeat(message.runId);
    });
  });

  // auth middleware
  coordinatorNamespace.use((socket, next) => {
    const logger = createLogger(`[coordinator][${socket.id}][auth]`);

    const { auth } = socket.handshake;

    if (!("token" in auth)) {
      logger("no token");
      return socket.disconnect(true);
    }

    if (auth.token !== env.COORDINATOR_SECRET) {
      logger("invalid token");
      return socket.disconnect(true);
    }

    logger("success");

    next();
  });

  return coordinatorNamespace;
}

function createProviderNamespace(io: Server) {
  const providerNamespace: Namespace<ProviderClientToServerEvents, ProviderServerToClientEvents> =
    io.of("/provider");

  providerNamespace.on("connection", async (socket) => {
    const logger = createLogger(`[provider][${socket.id}]`);

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
    const logger = createLogger(`[provider][${socket.id}][auth]`);

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

function createSharedQueueConsumerNamespace(io: Server) {
  const sharedQueueNamespace: Namespace<
    MessageCatalogToSocketIoEvents<typeof clientWebsocketMessages>,
    MessageCatalogToSocketIoEvents<typeof serverWebsocketMessages>
  > = io.of("/shared-queue");

  sharedQueueNamespace.on("connection", async (socket) => {
    const logger = createLogger(`[shared-queue][${socket.id}]`);

    logger("connected");

    const sharedSocketConnection = new SharedSocketConnection(sharedQueueNamespace, socket);

    sharedSocketConnection.onClose.attach((closeEvent) => {
      logger("Websocket closed", { closeEvent });
    });

    await sharedSocketConnection.initialize();
  });

  // auth middleware
  sharedQueueNamespace.use((socket, next) => {
    const logger = createLogger(`[shared-queue][${socket.id}][auth]`);

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

  return sharedQueueNamespace;
}
