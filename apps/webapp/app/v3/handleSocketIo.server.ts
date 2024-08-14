import {
  ClientToSharedQueueMessages,
  CoordinatorSocketData,
  CoordinatorToPlatformMessages,
  PlatformToCoordinatorMessages,
  PlatformToProviderMessages,
  ProviderToPlatformMessages,
  SharedQueueToClientMessages,
} from "@trigger.dev/core/v3";
import { ZodNamespace } from "@trigger.dev/core/v3/zodNamespace";
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
import { Redis } from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";
import { CrashTaskRunService } from "./services/crashTaskRun.server";
import { CreateTaskRunAttemptService } from "./services/createTaskRunAttempt.server";

export const socketIo = singleton("socketIo", initalizeIoServer);

function initalizeIoServer() {
  const io = initializeSocketIOServerInstance();

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

function initializeSocketIOServerInstance() {
  if (env.REDIS_HOST && env.REDIS_PORT) {
    const pubClient = new Redis({
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      // Force support for both IPv6 and IPv4, by default ioredis sets this to 4,
      // only allowing IPv4 connections:
      // https://github.com/redis/ioredis/issues/1576
      family: 0,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    });
    const subClient = pubClient.duplicate();

    const io = new Server({
      adapter: createAdapter(pubClient, subClient, {
        key: "tr:socket.io:",
        publishOnSpecificResponseChannel: true,
      }),
    });

    return io;
  }

  return new Server();
}

function createCoordinatorNamespace(io: Server) {
  const coordinator = new ZodNamespace({
    // @ts-ignore - for some reason the built ZodNamespace Server type is not compatible with the Server type here, but only when doing typechecking
    io,
    name: "coordinator",
    authToken: env.COORDINATOR_SECRET,
    clientMessages: CoordinatorToPlatformMessages,
    serverMessages: PlatformToCoordinatorMessages,
    socketData: CoordinatorSocketData,
    handlers: {
      READY_FOR_EXECUTION: async (message) => {
        const payload = await sharedQueueTasks.getLatestExecutionPayloadFromRun(
          message.runId,
          true,
          !!message.totalCompletions
        );

        if (!payload) {
          logger.error("Failed to retrieve execution payload", message);
          return { success: false };
        } else {
          return { success: true, payload };
        }
      },
      READY_FOR_LAZY_ATTEMPT: async (message) => {
        try {
          const payload = await sharedQueueTasks.getLazyAttemptPayload(
            message.envId,
            message.runId
          );

          if (!payload) {
            logger.error("Failed to retrieve lazy attempt payload", message);
            return { success: false, reason: "Failed to retrieve payload" };
          }

          return { success: true, lazyPayload: payload };
        } catch (error) {
          logger.error("Error while creating lazy attempt", {
            runId: message.runId,
            envId: message.envId,
            totalCompletions: message.totalCompletions,
            error,
          });
          return { success: false };
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
          supportsRetryCheckpoints: message.version === "v1",
        });
      },
      TASK_RUN_FAILED_TO_RUN: async (message) => {
        await sharedQueueTasks.taskRunFailed(message.completion);
      },
      TASK_HEARTBEAT: async (message) => {
        await sharedQueueTasks.taskHeartbeat(message.attemptFriendlyId);
      },
      TASK_RUN_HEARTBEAT: async (message) => {
        await sharedQueueTasks.taskRunHeartbeat(message.runId);
      },
      CHECKPOINT_CREATED: async (message) => {
        try {
          const createCheckpoint = new CreateCheckpointService();
          const result = await createCheckpoint.call(message);

          return { keepRunAlive: result?.keepRunAlive ?? false };
        } catch (error) {
          logger.error("Error while creating checkpoint", {
            rawMessage: message,
            error: error instanceof Error ? error.message : error,
          });

          return { keepRunAlive: false };
        }
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
            supportsLazyAttempts: message.version !== "v1" && message.supportsLazyAttempts,
          });

          return { success: !!worker };
        } catch (error) {
          logger.error("Error while creating worker", {
            error,
            envId: message.envId,
            projectRef: message.projectRef,
            deploymentId: message.deploymentId,
            version: message.version,
          });
          return { success: false };
        }
      },
      CREATE_TASK_RUN_ATTEMPT: async (message) => {
        try {
          const environment = await findEnvironmentById(message.envId);

          if (!environment) {
            logger.error("Environment not found", { id: message.envId });
            return { success: false, reason: "Environment not found" };
          }

          const service = new CreateTaskRunAttemptService();
          const { attempt } = await service.call(message.runId, environment, false);

          const payload = await sharedQueueTasks.getExecutionPayloadFromAttempt(attempt.id, true);

          if (!payload) {
            logger.error("Failed to retrieve payload after attempt creation", {
              id: message.envId,
            });
            return { success: false, reason: "Failed to retrieve payload" };
          }

          return { success: true, executionPayload: payload };
        } catch (error) {
          logger.error("Error while creating attempt", {
            runId: message.runId,
            error,
          });
          return { success: false };
        }
      },
      INDEXING_FAILED: async (message) => {
        try {
          const service = new DeploymentIndexFailed();

          await service.call(message.deploymentId, message.error);
        } catch (error) {
          logger.error("Error while processing index failure", {
            deploymentId: message.deploymentId,
            error,
          });
        }
      },
      RUN_CRASHED: async (message) => {
        try {
          const service = new CrashTaskRunService();

          await service.call(message.runId, {
            reason: `${message.error.name}: ${message.error.message}`,
            logs: message.error.stack,
          });
        } catch (error) {
          logger.error("Error while processing run failure", {
            runId: message.runId,
            error,
          });
        }
      },
    },
    onConnection: async (socket, handler, sender, logger) => {
      if (socket.data.supportsDynamicConfig) {
        socket.emit("DYNAMIC_CONFIG", {
          version: "v1",
          checkpointThresholdInMs: env.CHECKPOINT_THRESHOLD_IN_MS,
        });
      }
    },
    postAuth: async (socket, next, logger) => {
      function setSocketDataFromHeader(
        dataKey: keyof typeof socket.data,
        headerName: string,
        required: boolean = true
      ) {
        const value = socket.handshake.headers[headerName];

        if (value) {
          socket.data[dataKey] = Array.isArray(value) ? value[0] : value;
          return;
        }

        if (required) {
          logger.error("missing required header", { headerName });
          throw new Error("missing header");
        }
      }

      try {
        setSocketDataFromHeader("supportsDynamicConfig", "x-supports-dynamic-config", false);
      } catch (error) {
        logger.error("setSocketDataFromHeader error", { error });
        socket.disconnect(true);
        return;
      }

      logger.debug("success", socket.data);

      next();
    },
  });

  return coordinator.namespace;
}

function createProviderNamespace(io: Server) {
  const provider = new ZodNamespace({
    // @ts-ignore - for some reason the built ZodNamespace Server type is not compatible with the Server type here, but only when doing typechecking
    io,
    name: "provider",
    authToken: env.PROVIDER_SECRET,
    clientMessages: ProviderToPlatformMessages,
    serverMessages: PlatformToProviderMessages,
    handlers: {
      WORKER_CRASHED: async (message) => {
        try {
          const service = new CrashTaskRunService();

          await service.call(message.runId, {
            ...message,
          });
        } catch (error) {
          logger.error("Error while handling crashed worker", { error });
        }
      },
      INDEXING_FAILED: async (message) => {
        try {
          const service = new DeploymentIndexFailed();

          await service.call(message.deploymentId, message.error, message.overrideCompletion);
        } catch (e) {
          logger.error("Error while indexing", { error: e });
        }
      },
    },
  });

  return provider.namespace;
}

function createSharedQueueConsumerNamespace(io: Server) {
  const sharedQueue = new ZodNamespace({
    // @ts-ignore - for some reason the built ZodNamespace Server type is not compatible with the Server type here, but only when doing typechecking
    io,
    name: "shared-queue",
    authToken: env.PROVIDER_SECRET,
    clientMessages: ClientToSharedQueueMessages,
    serverMessages: SharedQueueToClientMessages,
    onConnection: async (socket, handler, sender, logger) => {
      const sharedSocketConnection = new SharedSocketConnection({
        // @ts-ignore - for some reason the built ZodNamespace Server type is not compatible with the Server type here, but only when doing typechecking
        namespace: sharedQueue.namespace,
        // @ts-ignore - for some reason the built ZodNamespace Server type is not compatible with the Server type here, but only when doing typechecking
        socket,
        logger,
        poolSize: env.SHARED_QUEUE_CONSUMER_POOL_SIZE,
      });

      sharedSocketConnection.onClose.attach((closeEvent) => {
        logger.info("Socket closed", { closeEvent });
      });

      await sharedSocketConnection.initialize();
    },
  });

  return sharedQueue.namespace;
}
