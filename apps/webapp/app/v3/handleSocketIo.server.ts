import {
  ClientToSharedQueueMessages,
  CoordinatorToPlatformMessages,
  PlatformToCoordinatorMessages,
  PlatformToProviderMessages,
  ProviderToPlatformMessages,
  SharedQueueToClientMessages,
  ZodNamespace,
} from "@trigger.dev/core/v3";
import { Server } from "socket.io";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { SharedSocketConnection } from "./sharedSocketConnection";
import { CreateCheckpointService } from "./services/createCheckpoint.server";
import { sharedQueueTasks } from "./marqs/sharedQueueConsumer.server";
import { CompleteAttemptService } from "./services/completeAttempt.server";
import { logger } from "~/services/logger.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { CreateDeployedBackgroundWorkerService } from "./services/createDeployedBackgroundWorker.server";
import { ResumeAttemptService } from "./services/resumeAttempt.server";
import { DeploymentIndexFailed } from "./services/deploymentIndexFailed.server";

export const socketIo = singleton("socketIo", initalizeIoServer);

function initalizeIoServer() {
  const io = new Server();

  io.on("connection", (socket) => {
    logger.log(`[socket.io][${socket.id}] connection at url: ${socket.request.url}`);
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
    handlers: {
      READY_FOR_EXECUTION: async (message) => {
        const payload = await sharedQueueTasks.getLatestExecutionPayloadFromRun(
          message.runId,
          true,
          !!message.totalCompletions
        );

        if (!payload) {
          return { success: false };
        } else {
          return { success: true, payload };
        }
      },
      READY_FOR_RESUME: async (message) => {
        const resumeAttempt = new ResumeAttemptService();
        await resumeAttempt.call(message);
      },
      TASK_RUN_COMPLETED: async (message) => {
        const completeAttempt = new CompleteAttemptService();
        await completeAttempt.call({
          completion: message.completion,
          execution: message.execution,
          checkpoint: message.checkpoint,
        });
      },
      TASK_HEARTBEAT: async (message) => {
        await sharedQueueTasks.taskHeartbeat(message.attemptFriendlyId);
      },
      CHECKPOINT_CREATED: async (message) => {
        const createCheckpoint = new CreateCheckpointService();
        await createCheckpoint.call(message);
      },
      CREATE_WORKER: async (message) => {
        try {
          const environment = await findEnvironmentById(message.envId);

          if (!environment) {
            logger.error("Environment not found", { id: message.envId });
            return { success: false };
          }

          const service = new CreateDeployedBackgroundWorkerService();
          const worker = await service.call(message.projectRef, environment, message.deploymentId, {
            localOnly: false,
            metadata: message.metadata,
          });

          return { success: !!worker };
        } catch (error) {
          logger.error("Error while creating worker", { error });
          return { success: false };
        }
      },
      INDEXING_FAILED: async (message) => {
        try {
          const service = new DeploymentIndexFailed();

          await service.call(message.deploymentId, message.error);
        } catch (e) {
          logger.error("Error while indexing failed", { error: e });
        }
      },
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
  });

  return provider.namespace;
}

function createSharedQueueConsumerNamespace(io: Server) {
  const sharedQueue = new ZodNamespace({
    io,
    name: "shared-queue",
    authToken: env.PROVIDER_SECRET,
    clientMessages: ClientToSharedQueueMessages,
    serverMessages: SharedQueueToClientMessages,
    onConnection: async (socket, handler, sender, logger) => {
      const sharedSocketConnection = new SharedSocketConnection({
        namespace: sharedQueue.namespace,
        socket,
        logger,
      });

      sharedSocketConnection.onClose.attach((closeEvent) => {
        logger.info("Socket closed", { closeEvent });
      });

      await sharedSocketConnection.initialize();
    },
  });

  return sharedQueue.namespace;
}
