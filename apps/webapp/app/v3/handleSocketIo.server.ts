import {
  CoordinatorToPlatformMessages,
  PlatformToCoordinatorMessages,
  PlatformToProviderMessages,
  ProviderToPlatformMessages,
  ZodNamespace,
  clientWebsocketMessages,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { Server } from "socket.io";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { SharedSocketConnection } from "./sharedSocketConnection";
import { CreateCheckpointService } from "./services/createCheckpoint.server";
import { sharedQueueTasks } from "./marqs/sharedQueueConsumer.server";
import { CompleteAttemptService } from "./services/completeAttempt.server";

export const socketIo = singleton("socketIo", initalizeIoServer);

function initalizeIoServer() {
  const io = new Server();

  io.on("connection", (socket) => {
    console.log(`[socket.io][${socket.id}] connection at url: ${socket.request.url}`);
  });

  const coordinatorNamespace = createCoordinatorNamespace(io);
  const providerNamespace = createProviderNamespace(io);
  const sharedQueueConsumerNamespace = createSharedQueueConsumerNamespace(io);

  return {
    io,
    coordinatorNamespace,
    providerNamespace,
    sharedQueueConsumerNamespace,
  };
}

function createCoordinatorNamespace(io: Server) {
  const coordinator = new ZodNamespace({
    io,
    name: "coordinator",
    authToken: env.COORDINATOR_SECRET,
    clientMessages: CoordinatorToPlatformMessages,
    serverMessages: PlatformToCoordinatorMessages,
    messageHandler: {
      READY_FOR_EXECUTION: async (message /*, callback */) => {
        const payload = await sharedQueueTasks.getExecutionPayloadFromAttempt(message.attemptId);

        if (!payload) {
          return { success: false };
        } else {
          return { success: true, payload };
        }
      },
      TASK_RUN_COMPLETED: async (message) => {
        const completeAttempt = new CompleteAttemptService();
        await completeAttempt.call(message.completion, message.execution);
      },
      TASK_HEARTBEAT: async (message) => {
        // TODO: handle RESUME message heartbeats
        await sharedQueueTasks.taskHeartbeat(message.attemptFriendlyId);
      },
      CHECKPOINT_CREATED: async (message) => {
        const createCheckpoint = new CreateCheckpointService();
        await createCheckpoint.call(message);
      },
      READY: async (message) => {
        return "foo"
      }
    },
  });

  return coordinator.namespace;
}

function createProviderNamespace(io: Server) {
  const provider = new ZodNamespace({
    io,
    name: "provider",
    authToken: env.PROVIDER_SECRET,
    clientMessages: ProviderToPlatformMessages,
    serverMessages: PlatformToProviderMessages,
    onConnection: async (socket, handler, sender, logger) => {
      sender.send("HEALTH", {});
    },
  });

  return provider.namespace;
}

function createSharedQueueConsumerNamespace(io: Server) {
  const sharedQueue = new ZodNamespace({
    io,
    name: "shared-queue",
    authToken: env.PROVIDER_SECRET,
    clientMessages: clientWebsocketMessages,
    serverMessages: serverWebsocketMessages,
    onConnection: async (socket, handler, sender, logger) => {
      const sharedSocketConnection = new SharedSocketConnection(
        sharedQueue.namespace,
        socket,
        logger
      );

      sharedSocketConnection.onClose.attach((closeEvent) => {
        logger("Socket closed", { closeEvent });
      });

      await sharedSocketConnection.initialize();
    },
  });

  return sharedQueue.namespace;
}
