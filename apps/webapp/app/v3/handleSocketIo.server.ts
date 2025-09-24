import { EventBusEventArgs } from "@internal/run-engine";
import { createAdapter } from "@socket.io/redis-adapter";
import {
  ClientToSharedQueueMessages,
  CoordinatorSocketData,
  CoordinatorToPlatformMessages,
  PlatformToCoordinatorMessages,
  PlatformToProviderMessages,
  ProviderToPlatformMessages,
  SharedQueueToClientMessages,
} from "@trigger.dev/core/v3";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type {
  WorkerClientToServerEvents,
  WorkerServerToClientEvents,
} from "@trigger.dev/core/v3/workers";
import { ZodNamespace } from "@trigger.dev/core/v3/zodNamespace";
import { Redis } from "ioredis";
import { Namespace, Server, Socket } from "socket.io";
import { env } from "~/env.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { authenticateApiRequestWithFailure } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { recordRunDebugLog } from "./eventRepository/index.server";
import { sharedQueueTasks } from "./marqs/sharedQueueConsumer.server";
import { engine } from "./runEngine.server";
import { CompleteAttemptService } from "./services/completeAttempt.server";
import { CrashTaskRunService } from "./services/crashTaskRun.server";
import { CreateCheckpointService } from "./services/createCheckpoint.server";
import { CreateDeploymentBackgroundWorkerServiceV3 } from "./services/createDeploymentBackgroundWorkerV3.server";
import { CreateTaskRunAttemptService } from "./services/createTaskRunAttempt.server";
import { DeploymentIndexFailed } from "./services/deploymentIndexFailed.server";
import { ResumeAttemptService } from "./services/resumeAttempt.server";
import { UpdateFatalRunErrorService } from "./services/updateFatalRunError.server";
import { WorkerGroupTokenService } from "./services/worker/workerGroupTokenService.server";
import { SharedSocketConnection } from "./sharedSocketConnection";

export const socketIo = singleton("socketIo", initalizeIoServer);

function initalizeIoServer() {
  const io = initializeSocketIOServerInstance();

  io.on("connection", (socket) => {
    logger.log(`[socket.io][${socket.id}] connection at url: ${socket.request.url}`);
  });

  const coordinatorNamespace = createCoordinatorNamespace(io);
  const providerNamespace = createProviderNamespace(io);
  const sharedQueueConsumerNamespace = createSharedQueueConsumerNamespace(io);
  const workerNamespace = createWorkerNamespace({
    io,
    namespace: "/worker",
    authenticate: async (request) => {
      const tokenService = new WorkerGroupTokenService();
      const authenticatedInstance = await tokenService.authenticate(request);
      if (!authenticatedInstance) {
        return false;
      }
      return true;
    },
  });
  const devWorkerNamespace = createWorkerNamespace({
    io,
    namespace: "/dev-worker",
    authenticate: async (request) => {
      const authentication = await authenticateApiRequestWithFailure(request);
      if (!authentication.ok) {
        return false;
      }
      if (authentication.environment.type !== "DEVELOPMENT") {
        return false;
      }
      return true;
    },
  });

  return {
    io,
    coordinatorNamespace,
    providerNamespace,
    sharedQueueConsumerNamespace,
    workerNamespace,
    devWorkerNamespace,
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
            logger.error(
              "READY_FOR_LAZY_ATTEMPT: Failed to retrieve lazy attempt payload",
              message
            );
            return { success: false, reason: "READY_FOR_LAZY_ATTEMPT: Failed to retrieve payload" };
          }

          return { success: true, lazyPayload: payload };
        } catch (error) {
          logger.error("READY_FOR_LAZY_ATTEMPT: Error while creating lazy attempt", {
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
        const completeAttempt = new CompleteAttemptService({
          supportsRetryCheckpoints: message.version === "v1",
        });
        await completeAttempt.call({
          completion: message.completion,
          execution: message.execution,
          checkpoint: message.checkpoint,
        });
      },
      TASK_RUN_COMPLETED_WITH_ACK: async (message) => {
        try {
          const completeAttempt = new CompleteAttemptService({
            supportsRetryCheckpoints: message.version === "v1",
          });
          await completeAttempt.call({
            completion: message.completion,
            execution: message.execution,
            checkpoint: message.checkpoint,
          });

          return {
            success: true,
          };
        } catch (error) {
          const friendlyError =
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : {
                  name: "UnknownError",
                  message: String(error),
                };

          logger.error("Error while completing attempt with ack", {
            error: friendlyError,
            message,
          });

          return {
            success: false,
            error: friendlyError,
          };
        }
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

          const service = new CreateDeploymentBackgroundWorkerServiceV3();
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
            logger.error("CREATE_TASK_RUN_ATTEMPT: Environment not found", message);
            return { success: false, reason: "Environment not found" };
          }

          const service = new CreateTaskRunAttemptService();
          const { attempt } = await service.call({
            runId: message.runId,
            authenticatedEnv: environment,
            setToExecuting: false,
          });

          const payload = await sharedQueueTasks.getExecutionPayloadFromAttempt({
            id: attempt.id,
            setToExecuting: true,
            skipStatusChecks: true,
          });

          if (!payload) {
            logger.error(
              "CREATE_TASK_RUN_ATTEMPT: Failed to retrieve payload after attempt creation",
              message
            );
            return {
              success: false,
              reason: "CREATE_TASK_RUN_ATTEMPT: Failed to retrieve payload",
            };
          }

          return { success: true, executionPayload: payload };
        } catch (error) {
          logger.error("CREATE_TASK_RUN_ATTEMPT: Error while creating attempt", {
            ...message,
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
          if (message.overrideCompletion) {
            const updateErrorService = new UpdateFatalRunErrorService();
            await updateErrorService.call(message.runId, { ...message });
          } else {
            const crashRunService = new CrashTaskRunService();
            await crashRunService.call(message.runId, { ...message });
          }
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

function headersFromHandshake(handshake: Socket["handshake"]) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(handshake.headers)) {
    if (typeof value !== "string") continue;
    headers.append(key, value);
  }

  return headers;
}

function createWorkerNamespace({
  io,
  namespace,
  authenticate,
}: {
  io: Server;
  namespace: string;
  authenticate: (request: Request) => Promise<boolean>;
}) {
  const worker: Namespace<WorkerClientToServerEvents, WorkerServerToClientEvents> =
    io.of(namespace);

  worker.use(async (socket, next) => {
    try {
      const headers = headersFromHandshake(socket.handshake);

      logger.debug("Worker authentication", {
        namespace,
        socketId: socket.id,
        headers: Object.fromEntries(headers),
      });

      const request = new Request("https://example.com", {
        headers,
      });

      const success = await authenticate(request);

      if (!success) {
        throw new Error("unauthorized");
      }

      next();
    } catch (error) {
      logger.error("Worker authentication failed", {
        namespace,
        error: error instanceof Error ? error.message : error,
      });

      socket.disconnect(true);
    }
  });

  worker.on("connection", async (socket) => {
    logger.debug("worker connected", { namespace, socketId: socket.id });

    const rooms = new Set<string>();

    async function onNotification({
      time,
      run,
      snapshot,
    }: EventBusEventArgs<"workerNotification">[0]) {
      if (!env.RUN_ENGINE_DEBUG_WORKER_NOTIFICATIONS) {
        return;
      }

      logger.debug("[handleSocketIo] Received worker notification", {
        namespace,
        time,
        runId: run.id,
        snapshot,
      });

      // Record notification event
      await recordRunDebugLog(run.id, `run:notify workerNotification event`, {
        attributes: {
          properties: {
            snapshotId: snapshot.id,
            snapshotStatus: snapshot.executionStatus,
            rooms: Array.from(rooms),
          },
        },
        startTime: time,
      });
    }

    engine.eventBus.on("workerNotification", onNotification);

    const interval = setInterval(() => {
      logger.debug("Rooms for socket", {
        namespace,
        socketId: socket.id,
        rooms: Array.from(rooms),
      });
    }, 5000);

    socket.on("disconnect", (reason, description) => {
      logger.debug("worker disconnected", {
        namespace,
        socketId: socket.id,
        reason,
        description,
      });
      clearInterval(interval);

      engine.eventBus.off("workerNotification", onNotification);
    });

    socket.on("disconnecting", (reason, description) => {
      logger.debug("worker disconnecting", {
        namespace,
        socketId: socket.id,
        reason,
        description,
      });
      clearInterval(interval);
    });

    socket.on("error", (error) => {
      logger.error("worker error", {
        namespace,
        socketId: socket.id,
        error: JSON.parse(JSON.stringify(error)),
      });
      clearInterval(interval);
    });

    socket.on("run:subscribe", async ({ version, runFriendlyIds }) => {
      logger.debug("run:subscribe", { namespace, version, runFriendlyIds });

      const settledResult = await Promise.allSettled(
        runFriendlyIds.map(async (friendlyId) => {
          const room = roomFromFriendlyRunId(friendlyId);

          logger.debug("Joining room", { namespace, room });

          socket.join(room);
          rooms.add(room);

          await recordRunDebugLog(
            RunId.fromFriendlyId(friendlyId),
            "run:subscribe received by platform",
            {
              attributes: {
                properties: {
                  friendlyId,
                  runFriendlyIds,
                  room,
                },
              },
            }
          );
        })
      );

      for (const result of settledResult) {
        if (result.status === "rejected") {
          logger.error("Error joining room", {
            namespace,
            runFriendlyIds,
            error: result.reason instanceof Error ? result.reason.message : result.reason,
          });
        }
      }

      logger.debug("Rooms for socket after subscribe", {
        namespace,
        socketId: socket.id,
        rooms: Array.from(rooms),
      });
    });

    socket.on("run:unsubscribe", async ({ version, runFriendlyIds }) => {
      logger.debug("run:unsubscribe", { namespace, version, runFriendlyIds });

      const settledResult = await Promise.allSettled(
        runFriendlyIds.map(async (friendlyId) => {
          const room = roomFromFriendlyRunId(friendlyId);

          logger.debug("Leaving room", { namespace, room });

          socket.leave(room);
          rooms.delete(room);

          await recordRunDebugLog(
            RunId.fromFriendlyId(friendlyId),
            "run:unsubscribe received by platform",
            {
              attributes: {
                properties: {
                  friendlyId,
                  runFriendlyIds,
                  room,
                },
              },
            }
          );
        })
      );

      for (const result of settledResult) {
        if (result.status === "rejected") {
          logger.error("Error leaving room", {
            namespace,
            runFriendlyIds,
            error: result.reason instanceof Error ? result.reason.message : result.reason,
          });
        }
      }

      logger.debug("Rooms for socket after unsubscribe", {
        namespace,
        socketId: socket.id,
        rooms: Array.from(rooms),
      });
    });
  });

  return worker;
}

export function roomFromFriendlyRunId(id: string) {
  return `room:${id}`;
}
