import { createServer } from "node:http";
import { Server } from "socket.io";
import {
  CoordinatorToPlatformMessages,
  CoordinatorToProdWorkerMessages,
  omit,
  PlatformToCoordinatorMessages,
  ProdWorkerSocketData,
  ProdWorkerToCoordinatorMessages,
  WaitReason,
} from "@trigger.dev/core/v3";
import { ZodNamespace } from "@trigger.dev/core/v3/zodNamespace";
import { ZodSocketConnection } from "@trigger.dev/core/v3/zodSocket";
import { ExponentialBackoff, HttpReply, getTextBody } from "@trigger.dev/core/v3/apps";
import { ChaosMonkey } from "./chaosMonkey";
import { Checkpointer } from "./checkpointer";
import { boolFromEnv, numFromEnv, safeJsonParse } from "./util";

import { collectDefaultMetrics, register, Gauge } from "prom-client";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
collectDefaultMetrics();

const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || 8020);
const NODE_NAME = process.env.NODE_NAME || "coordinator";
const DEFAULT_RETRY_DELAY_THRESHOLD_IN_MS = 30_000;

const PLATFORM_ENABLED = ["1", "true"].includes(process.env.PLATFORM_ENABLED ?? "true");
const PLATFORM_HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PLATFORM_WS_PORT = process.env.PLATFORM_WS_PORT || 3030;
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || "coordinator-secret";
const SECURE_CONNECTION = ["1", "true"].includes(process.env.SECURE_CONNECTION ?? "false");

const TASK_RUN_COMPLETED_WITH_ACK_TIMEOUT_MS =
  parseInt(process.env.TASK_RUN_COMPLETED_WITH_ACK_TIMEOUT_MS || "") || 30_000;
const TASK_RUN_COMPLETED_WITH_ACK_MAX_RETRIES =
  parseInt(process.env.TASK_RUN_COMPLETED_WITH_ACK_MAX_RETRIES || "") || 7;

const WAIT_FOR_TASK_CHECKPOINT_DELAY_MS =
  parseInt(process.env.WAIT_FOR_TASK_CHECKPOINT_DELAY_MS || "") || 0;
const WAIT_FOR_BATCH_CHECKPOINT_DELAY_MS =
  parseInt(process.env.WAIT_FOR_BATCH_CHECKPOINT_DELAY_MS || "") || 0;

const logger = new SimpleStructuredLogger("coordinator", undefined, { nodeName: NODE_NAME });
const chaosMonkey = new ChaosMonkey(
  !!process.env.CHAOS_MONKEY_ENABLED,
  !!process.env.CHAOS_MONKEY_DISABLE_ERRORS,
  !!process.env.CHAOS_MONKEY_DISABLE_DELAYS
);

class CheckpointReadinessTimeoutError extends Error {}
class CheckpointCancelError extends Error {}

class TaskCoordinator {
  #httpServer: ReturnType<typeof createServer>;
  #internalHttpServer: ReturnType<typeof createServer>;

  #checkpointer = new Checkpointer({
    dockerMode: !process.env.KUBERNETES_PORT,
    forceSimulate: boolFromEnv("FORCE_CHECKPOINT_SIMULATION", false),
    heartbeat: this.#sendRunHeartbeat.bind(this),
    registryHost: process.env.REGISTRY_HOST,
    registryNamespace: process.env.REGISTRY_NAMESPACE,
    registryTlsVerify: boolFromEnv("REGISTRY_TLS_VERIFY", true),
    disableCheckpointSupport: boolFromEnv("DISABLE_CHECKPOINT_SUPPORT", false),
    simulatePushFailure: boolFromEnv("SIMULATE_PUSH_FAILURE", false),
    simulatePushFailureSeconds: numFromEnv("SIMULATE_PUSH_FAILURE_SECONDS", 300),
    simulateCheckpointFailure: boolFromEnv("SIMULATE_CHECKPOINT_FAILURE", false),
    simulateCheckpointFailureSeconds: numFromEnv("SIMULATE_CHECKPOINT_FAILURE_SECONDS", 300),
    chaosMonkey,
  });

  #prodWorkerNamespace?: ZodNamespace<
    typeof ProdWorkerToCoordinatorMessages,
    typeof CoordinatorToProdWorkerMessages,
    typeof ProdWorkerSocketData
  >;
  #platformSocket?: ZodSocketConnection<
    typeof CoordinatorToPlatformMessages,
    typeof PlatformToCoordinatorMessages
  >;

  #checkpointableTasks = new Map<
    string,
    { resolve: (value: void) => void; reject: (err?: any) => void }
  >();

  #delayThresholdInMs: number = DEFAULT_RETRY_DELAY_THRESHOLD_IN_MS;

  constructor(
    private port: number,
    private host = "0.0.0.0"
  ) {
    this.#httpServer = this.#createHttpServer();
    this.#internalHttpServer = this.#createInternalHttpServer();

    this.#checkpointer.init();
    this.#platformSocket = this.#createPlatformSocket();

    const connectedTasksTotal = new Gauge({
      name: "daemon_connected_tasks_total", // don't change this without updating dashboard config
      help: "The number of tasks currently connected.",
      collect: () => {
        connectedTasksTotal.set(this.#prodWorkerNamespace?.namespace.sockets.size ?? 0);
      },
    });
    register.registerMetric(connectedTasksTotal);
  }

  #returnValidatedExtraHeaders(headers: Record<string, string>) {
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) {
        throw new Error(`Extra header is undefined: ${key}`);
      }
    }

    return headers;
  }

  // MARK: SOCKET: PLATFORM
  #createPlatformSocket() {
    if (!PLATFORM_ENABLED) {
      logger.log("INFO: platform connection disabled");
      return;
    }

    const extraHeaders = this.#returnValidatedExtraHeaders({
      "x-supports-dynamic-config": "yes",
    });

    const host = PLATFORM_HOST;
    const port = Number(PLATFORM_WS_PORT);

    const platformLogger = new SimpleStructuredLogger("socket-platform", undefined, {
      namespace: "coordinator",
    });

    platformLogger.log("connecting", { host, port });
    platformLogger.debug("connecting with extra headers", { extraHeaders });

    const platformConnection = new ZodSocketConnection({
      namespace: "coordinator",
      host,
      port,
      secure: SECURE_CONNECTION,
      extraHeaders,
      clientMessages: CoordinatorToPlatformMessages,
      serverMessages: PlatformToCoordinatorMessages,
      authToken: PLATFORM_SECRET,
      logHandlerPayloads: false,
      handlers: {
        // This is used by resumeAttempt
        RESUME_AFTER_DEPENDENCY: async (message) => {
          const log = platformLogger.child({
            eventName: "RESUME_AFTER_DEPENDENCY",
            ...omit(message, "completions", "executions"),
            completions: message.completions.map((c) => ({
              id: c.id,
              ok: c.ok,
            })),
            executions: message.executions.length,
          });

          log.log("Handling RESUME_AFTER_DEPENDENCY");

          const taskSocket = await this.#getAttemptSocket(message.attemptFriendlyId);

          if (!taskSocket) {
            log.debug("Socket for attempt not found");
            return;
          }

          log.addFields({ socketId: taskSocket.id, socketData: taskSocket.data });
          log.log("Found task socket for RESUME_AFTER_DEPENDENCY");

          await chaosMonkey.call();

          // In case the task resumes before the checkpoint is created
          this.#cancelCheckpoint(message.runId, {
            event: "RESUME_AFTER_DEPENDENCY",
            completions: message.completions.length,
          });

          taskSocket.emit("RESUME_AFTER_DEPENDENCY", message);
        },
        // This is used by sharedQueueConsumer
        RESUME_AFTER_DEPENDENCY_WITH_ACK: async (message) => {
          const log = platformLogger.child({
            eventName: "RESUME_AFTER_DEPENDENCY_WITH_ACK",
            ...omit(message, "completions", "executions"),
            completions: message.completions.map((c) => ({
              id: c.id,
              ok: c.ok,
            })),
            executions: message.executions.length,
          });

          log.log("Handling RESUME_AFTER_DEPENDENCY_WITH_ACK");

          const taskSocket = await this.#getAttemptSocket(message.attemptFriendlyId);

          if (!taskSocket) {
            log.debug("Socket for attempt not found");
            return {
              success: false,
              error: {
                name: "SocketNotFoundError",
                message: "Socket for attempt not found",
              },
            };
          }

          log.addFields({ socketId: taskSocket.id, socketData: taskSocket.data });
          log.log("Found task socket for RESUME_AFTER_DEPENDENCY_WITH_ACK");

          //if this is set, we want to kill the process because it will be resumed with the checkpoint from the queue
          if (taskSocket.data.requiresCheckpointResumeWithMessage) {
            log.log("RESUME_AFTER_DEPENDENCY_WITH_ACK: Checkpoint is set so going to nack");

            return {
              success: false,
              error: {
                name: "CheckpointMessagePresentError",
                message:
                  "Checkpoint message is present, so we need to kill the process and resume from the queue.",
              },
            };
          }

          await chaosMonkey.call();

          // In case the task resumes before the checkpoint is created
          this.#cancelCheckpoint(message.runId, {
            event: "RESUME_AFTER_DEPENDENCY_WITH_ACK",
            completions: message.completions.length,
          });

          taskSocket.emit("RESUME_AFTER_DEPENDENCY", message);

          return {
            success: true,
          };
        },
        RESUME_AFTER_DURATION: async (message) => {
          const log = platformLogger.child({
            eventName: "RESUME_AFTER_DURATION",
            ...message,
          });

          log.log("Handling RESUME_AFTER_DURATION");

          const taskSocket = await this.#getAttemptSocket(message.attemptFriendlyId);

          if (!taskSocket) {
            log.debug("Socket for attempt not found");
            return;
          }

          log.addFields({ socketId: taskSocket.id, socketData: taskSocket.data });
          log.log("Found task socket for RESUME_AFTER_DURATION");

          await chaosMonkey.call();

          taskSocket.emit("RESUME_AFTER_DURATION", message);
        },
        REQUEST_ATTEMPT_CANCELLATION: async (message) => {
          const log = platformLogger.child({
            eventName: "REQUEST_ATTEMPT_CANCELLATION",
            ...message,
          });

          log.log("Handling REQUEST_ATTEMPT_CANCELLATION");

          const taskSocket = await this.#getAttemptSocket(message.attemptFriendlyId);

          if (!taskSocket) {
            logger.debug("Socket for attempt not found");
            return;
          }

          log.addFields({ socketId: taskSocket.id, socketData: taskSocket.data });
          log.log("Found task socket for REQUEST_ATTEMPT_CANCELLATION");

          taskSocket.emit("REQUEST_ATTEMPT_CANCELLATION", message);
        },
        REQUEST_RUN_CANCELLATION: async (message) => {
          const log = platformLogger.child({
            eventName: "REQUEST_RUN_CANCELLATION",
            ...message,
          });

          log.log("Handling REQUEST_RUN_CANCELLATION");

          const taskSocket = await this.#getRunSocket(message.runId);

          if (!taskSocket) {
            logger.debug("Socket for run not found");
            return;
          }

          log.addFields({ socketId: taskSocket.id, socketData: taskSocket.data });
          log.log("Found task socket for REQUEST_RUN_CANCELLATION");

          this.#cancelCheckpoint(message.runId, { event: "REQUEST_RUN_CANCELLATION", ...message });

          if (message.delayInMs) {
            taskSocket.emit("REQUEST_EXIT", {
              version: "v2",
              delayInMs: message.delayInMs,
            });
          } else {
            // If there's no delay, assume the worker doesn't support non-v1 messages
            taskSocket.emit("REQUEST_EXIT", {
              version: "v1",
            });
          }
        },
        READY_FOR_RETRY: async (message) => {
          const log = platformLogger.child({
            eventName: "READY_FOR_RETRY",
            ...message,
          });

          const taskSocket = await this.#getRunSocket(message.runId);

          if (!taskSocket) {
            logger.debug("Socket for attempt not found");
            return;
          }

          log.addFields({ socketId: taskSocket.id, socketData: taskSocket.data });
          log.log("Found task socket for READY_FOR_RETRY");

          await chaosMonkey.call();

          taskSocket.emit("READY_FOR_RETRY", message);
        },
        DYNAMIC_CONFIG: async (message) => {
          const log = platformLogger.child({
            eventName: "DYNAMIC_CONFIG",
            ...message,
          });

          log.log("Handling DYNAMIC_CONFIG");

          this.#delayThresholdInMs = message.checkpointThresholdInMs;

          // The first time we receive a dynamic config, the worker namespace will be created
          if (!this.#prodWorkerNamespace) {
            const io = new Server(this.#httpServer);
            this.#prodWorkerNamespace = this.#createProdWorkerNamespace(io);
          }
        },
      },
    });

    return platformConnection;
  }

  async #getRunSocket(runId: string) {
    const sockets = (await this.#prodWorkerNamespace?.fetchSockets()) ?? [];

    for (const socket of sockets) {
      if (socket.data.runId === runId) {
        return socket;
      }
    }
  }

  async #getAttemptSocket(attemptFriendlyId: string) {
    const sockets = (await this.#prodWorkerNamespace?.fetchSockets()) ?? [];

    for (const socket of sockets) {
      if (socket.data.attemptFriendlyId === attemptFriendlyId) {
        return socket;
      }
    }
  }

  // MARK: SOCKET: WORKERS
  #createProdWorkerNamespace(io: Server) {
    const provider = new ZodNamespace({
      io,
      name: "prod-worker",
      clientMessages: ProdWorkerToCoordinatorMessages,
      serverMessages: CoordinatorToProdWorkerMessages,
      socketData: ProdWorkerSocketData,
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
          setSocketDataFromHeader("podName", "x-pod-name");
          setSocketDataFromHeader("contentHash", "x-trigger-content-hash");
          setSocketDataFromHeader("projectRef", "x-trigger-project-ref");
          setSocketDataFromHeader("runId", "x-trigger-run-id");
          setSocketDataFromHeader("attemptFriendlyId", "x-trigger-attempt-friendly-id", false);
          setSocketDataFromHeader("attemptNumber", "x-trigger-attempt-number", false);
          setSocketDataFromHeader("envId", "x-trigger-env-id");
          setSocketDataFromHeader("deploymentId", "x-trigger-deployment-id");
          setSocketDataFromHeader("deploymentVersion", "x-trigger-deployment-version");
        } catch (error) {
          logger.error("setSocketDataFromHeader error", { error });
          socket.disconnect(true);
          return;
        }

        logger.debug("success", socket.data);

        next();
      },
      onConnection: async (socket, handler, sender) => {
        const logger = new SimpleStructuredLogger("ns-prod-worker", undefined, {
          namespace: "prod-worker",
          socketId: socket.id,
          socketData: socket.data,
        });

        const getSocketMetadata = () => {
          return {
            attemptFriendlyId: socket.data.attemptFriendlyId,
            attemptNumber: socket.data.attemptNumber,
            requiresCheckpointResumeWithMessage: socket.data.requiresCheckpointResumeWithMessage,
          };
        };

        const getAttemptNumber = () => {
          return socket.data.attemptNumber ? parseInt(socket.data.attemptNumber) : undefined;
        };

        const exitRun = () => {
          logger.log("exitRun", getSocketMetadata());

          socket.emit("REQUEST_EXIT", {
            version: "v1",
          });
        };

        const crashRun = async (error: { name: string; message: string; stack?: string }) => {
          logger.error("crashRun", { ...getSocketMetadata(), error });

          try {
            this.#platformSocket?.send("RUN_CRASHED", {
              version: "v1",
              runId: socket.data.runId,
              error,
            });
          } finally {
            exitRun();
          }
        };

        const checkpointInProgress = () => {
          return this.#checkpointableTasks.has(socket.data.runId);
        };

        const readyToCheckpoint = async (
          reason: WaitReason | "RETRY"
        ): Promise<
          | {
              success: true;
            }
          | {
              success: false;
              reason?: string;
            }
        > => {
          const log = logger.child(getSocketMetadata());

          log.log("readyToCheckpoint", { runId: socket.data.runId, reason });

          if (checkpointInProgress()) {
            return {
              success: false,
              reason: "checkpoint in progress",
            };
          }

          let timeout: NodeJS.Timeout | undefined = undefined;

          const CHECKPOINTABLE_TIMEOUT_SECONDS = 20;

          const isCheckpointable = new Promise((resolve, reject) => {
            // We set a reasonable timeout to prevent waiting forever
            timeout = setTimeout(
              () => reject(new CheckpointReadinessTimeoutError()),
              CHECKPOINTABLE_TIMEOUT_SECONDS * 1000
            );

            this.#checkpointableTasks.set(socket.data.runId, { resolve, reject });
          });

          try {
            await isCheckpointable;
            this.#checkpointableTasks.delete(socket.data.runId);

            return {
              success: true,
            };
          } catch (error) {
            log.error("Error while waiting for checkpointable state", { error });

            if (error instanceof CheckpointReadinessTimeoutError) {
              logger.error(
                `Failed to become checkpointable in ${CHECKPOINTABLE_TIMEOUT_SECONDS}s for ${reason}`,
                { runId: socket.data.runId }
              );

              return {
                success: false,
                reason: "timeout",
              };
            }

            if (error instanceof CheckpointCancelError) {
              return {
                success: false,
                reason: "canceled",
              };
            }

            return {
              success: false,
              reason: typeof error === "string" ? error : "unknown",
            };
          } finally {
            clearTimeout(timeout);
          }
        };

        const updateAttemptFriendlyId = (attemptFriendlyId: string) => {
          socket.data.attemptFriendlyId = attemptFriendlyId;
        };

        const updateAttemptNumber = (attemptNumber: string | number) => {
          socket.data.attemptNumber = String(attemptNumber);
        };

        this.#platformSocket?.send("LOG", {
          metadata: socket.data,
          text: "connected",
        });

        socket.on("TEST", (message, callback) => {
          logger.log("Handling TEST", { eventName: "TEST", ...getSocketMetadata(), ...message });

          try {
            callback();
          } catch (error) {
            logger.error("TEST error", { error });
          }
        });

        // Deprecated: Only workers without support for lazy attempts use this
        socket.on("READY_FOR_EXECUTION", async (message) => {
          const log = logger.child({
            eventName: "READY_FOR_EXECUTION",
            ...getSocketMetadata(),
            ...message,
          });

          log.log("Handling READY_FOR_EXECUTION");

          try {
            const executionAck = await this.#platformSocket?.sendWithAck(
              "READY_FOR_EXECUTION",
              message
            );

            if (!executionAck) {
              log.error("no execution ack");

              await crashRun({
                name: "ReadyForExecutionError",
                message: "No execution ack",
              });

              return;
            }

            if (!executionAck.success) {
              log.error("failed to get execution payload");

              await crashRun({
                name: "ReadyForExecutionError",
                message: "Failed to get execution payload",
              });

              return;
            }

            socket.emit("EXECUTE_TASK_RUN", {
              version: "v1",
              executionPayload: executionAck.payload,
            });

            updateAttemptFriendlyId(executionAck.payload.execution.attempt.id);
            updateAttemptNumber(executionAck.payload.execution.attempt.number);
          } catch (error) {
            log.error("READY_FOR_EXECUTION error", { error });

            await crashRun({
              name: "ReadyForExecutionError",
              message:
                error instanceof Error ? `Unexpected error: ${error.message}` : "Unexpected error",
            });

            return;
          }
        });

        // MARK: LAZY ATTEMPT
        socket.on("READY_FOR_LAZY_ATTEMPT", async (message) => {
          const log = logger.child({
            eventName: "READY_FOR_LAZY_ATTEMPT",
            ...getSocketMetadata(),
            ...message,
          });

          log.log("Handling READY_FOR_LAZY_ATTEMPT");

          try {
            const lazyAttempt = await this.#platformSocket?.sendWithAck("READY_FOR_LAZY_ATTEMPT", {
              ...message,
              envId: socket.data.envId,
            });

            if (!lazyAttempt) {
              log.error("no lazy attempt ack");

              await crashRun({
                name: "ReadyForLazyAttemptError",
                message: "No lazy attempt ack",
              });

              return;
            }

            if (!lazyAttempt.success) {
              log.error("failed to get lazy attempt payload", { reason: lazyAttempt.reason });

              await crashRun({
                name: "ReadyForLazyAttemptError",
                message: "Failed to get lazy attempt payload",
              });

              return;
            }

            await chaosMonkey.call();

            const lazyPayload = {
              ...lazyAttempt.lazyPayload,
              metrics: [
                ...(message.startTime
                  ? [
                      {
                        name: "start",
                        event: "lazy_payload",
                        timestamp: message.startTime,
                        duration: Date.now() - message.startTime,
                      },
                    ]
                  : []),
              ],
            };

            socket.emit("EXECUTE_TASK_RUN_LAZY_ATTEMPT", {
              version: "v1",
              lazyPayload,
            });
          } catch (error) {
            if (error instanceof ChaosMonkey.Error) {
              log.error("ChaosMonkey error, won't crash run");
              return;
            }

            log.error("READY_FOR_LAZY_ATTEMPT error", { error });

            // await crashRun({
            //   name: "ReadyForLazyAttemptError",
            //   message:
            //     error instanceof Error ? `Unexpected error: ${error.message}` : "Unexpected error",
            // });

            return;
          }
        });

        // MARK: RESUME READY
        socket.on("READY_FOR_RESUME", async (message) => {
          const log = logger.child({
            eventName: "READY_FOR_RESUME",
            ...getSocketMetadata(),
            ...message,
          });

          log.log("Handling READY_FOR_RESUME");

          try {
            updateAttemptFriendlyId(message.attemptFriendlyId);

            if (message.version === "v2") {
              updateAttemptNumber(message.attemptNumber);
            }

            this.#platformSocket?.send("READY_FOR_RESUME", { ...message, version: "v1" });
          } catch (error) {
            log.error("READY_FOR_RESUME error", { error });

            await crashRun({
              name: "ReadyForResumeError",
              message:
                error instanceof Error ? `Unexpected error: ${error.message}` : "Unexpected error",
            });

            return;
          }
        });

        // MARK: RUN COMPLETED
        socket.on("TASK_RUN_COMPLETED", async (message, callback) => {
          const log = logger.child({
            eventName: "TASK_RUN_COMPLETED",
            ...getSocketMetadata(),
            ...omit(message, "completion", "execution"),
            completion: {
              id: message.completion.id,
              ok: message.completion.ok,
            },
          });

          log.log("Handling TASK_RUN_COMPLETED");

          try {
            const { completion, execution } = message;

            // Cancel all in-progress checkpoints (if any)
            this.#cancelCheckpoint(socket.data.runId, {
              event: "TASK_RUN_COMPLETED",
              attemptNumber: execution.attempt.number,
            });

            await chaosMonkey.call({ throwErrors: false });

            const sendCompletionWithAck = async (): Promise<boolean> => {
              try {
                const response = await this.#platformSocket?.sendWithAck(
                  "TASK_RUN_COMPLETED_WITH_ACK",
                  {
                    version: "v2",
                    execution,
                    completion,
                  },
                  TASK_RUN_COMPLETED_WITH_ACK_TIMEOUT_MS
                );

                if (!response) {
                  log.error("TASK_RUN_COMPLETED_WITH_ACK: no response");
                  return false;
                }

                if (!response.success) {
                  log.error("TASK_RUN_COMPLETED_WITH_ACK: error response", {
                    error: response.error,
                  });
                  return false;
                }

                log.log("TASK_RUN_COMPLETED_WITH_ACK: successful response");
                return true;
              } catch (error) {
                log.error("TASK_RUN_COMPLETED_WITH_ACK: threw error", { error });
                return false;
              }
            };

            const completeWithoutCheckpoint = async (shouldExit: boolean) => {
              const supportsRetryCheckpoints = message.version === "v1";

              callback({ willCheckpointAndRestore: false, shouldExit });

              if (supportsRetryCheckpoints) {
                // This is only here for backwards compat
                this.#platformSocket?.send("TASK_RUN_COMPLETED", {
                  version: "v1",
                  execution,
                  completion,
                });
              } else {
                // 99.99% of runs should end up here

                const completedWithAckBackoff = new ExponentialBackoff("FullJitter").maxRetries(
                  TASK_RUN_COMPLETED_WITH_ACK_MAX_RETRIES
                );

                const result = await completedWithAckBackoff.execute(
                  async ({ retry, delay, elapsedMs }) => {
                    logger.log("TASK_RUN_COMPLETED_WITH_ACK: sending with backoff", {
                      retry,
                      delay,
                      elapsedMs,
                    });

                    const success = await sendCompletionWithAck();

                    if (!success) {
                      throw new Error("Failed to send completion with ack");
                    }
                  }
                );

                if (!result.success) {
                  logger.error("TASK_RUN_COMPLETED_WITH_ACK: failed to send with backoff", result);
                  return;
                }

                logger.log("TASK_RUN_COMPLETED_WITH_ACK: sent with backoff", result);
              }
            };

            if (completion.ok) {
              await completeWithoutCheckpoint(true);
              return;
            }

            if (
              completion.error.type === "INTERNAL_ERROR" &&
              completion.error.code === "TASK_RUN_CANCELLED"
            ) {
              await completeWithoutCheckpoint(true);
              return;
            }

            if (completion.retry === undefined) {
              await completeWithoutCheckpoint(true);
              return;
            }

            if (completion.retry.delay < this.#delayThresholdInMs) {
              await completeWithoutCheckpoint(false);

              // Prevents runs that fail fast from never sending a heartbeat
              this.#sendRunHeartbeat(socket.data.runId);

              return;
            }

            if (message.version === "v2") {
              await completeWithoutCheckpoint(true);
              return;
            }

            const { canCheckpoint, willSimulate } = await this.#checkpointer.init();

            const willCheckpointAndRestore = canCheckpoint || willSimulate;

            if (!willCheckpointAndRestore) {
              await completeWithoutCheckpoint(false);
              return;
            }

            // The worker will then put itself in a checkpointable state
            callback({ willCheckpointAndRestore: true, shouldExit: false });

            const ready = await readyToCheckpoint("RETRY");

            if (!ready.success) {
              log.error("Failed to become checkpointable", { reason: ready.reason });

              return;
            }

            const checkpoint = await this.#checkpointer.checkpointAndPush({
              runId: socket.data.runId,
              projectRef: socket.data.projectRef,
              deploymentVersion: socket.data.deploymentVersion,
              shouldHeartbeat: true,
            });

            if (!checkpoint) {
              log.error("Failed to checkpoint");
              await completeWithoutCheckpoint(false);
              return;
            }

            log.addFields({ checkpoint });

            this.#platformSocket?.send("TASK_RUN_COMPLETED", {
              version: "v1",
              execution,
              completion,
              checkpoint,
            });

            if (!checkpoint.docker || !willSimulate) {
              exitRun();
            }
          } catch (error) {
            log.error("TASK_RUN_COMPLETED error", { error });

            await crashRun({
              name: "TaskRunCompletedError",
              message:
                error instanceof Error ? `Unexpected error: ${error.message}` : "Unexpected error",
            });

            return;
          }
        });

        // MARK: TASK FAILED
        socket.on("TASK_RUN_FAILED_TO_RUN", async ({ completion }) => {
          const log = logger.child({
            eventName: "TASK_RUN_FAILED_TO_RUN",
            ...getSocketMetadata(),
            completion: {
              id: completion.id,
              ok: completion.ok,
            },
          });

          log.log("Handling TASK_RUN_FAILED_TO_RUN");

          try {
            // Cancel all in-progress checkpoints (if any)
            this.#cancelCheckpoint(socket.data.runId, {
              event: "TASK_RUN_FAILED_TO_RUN",
              errorType: completion.error.type,
            });

            this.#platformSocket?.send("TASK_RUN_FAILED_TO_RUN", {
              version: "v1",
              completion,
            });

            exitRun();
          } catch (error) {
            log.error("TASK_RUN_FAILED_TO_RUN error", { error });

            return;
          }
        });

        // MARK: CHECKPOINT
        socket.on("READY_FOR_CHECKPOINT", async (message) => {
          const log = logger.child({
            eventName: "READY_FOR_CHECKPOINT",
            ...getSocketMetadata(),
            ...message,
          });

          log.log("Handling READY_FOR_CHECKPOINT");

          try {
            const checkpointable = this.#checkpointableTasks.get(socket.data.runId);

            if (!checkpointable) {
              log.error("No checkpoint scheduled");
              return;
            }

            checkpointable.resolve();
          } catch (error) {
            log.error("READY_FOR_CHECKPOINT error", { error });

            return;
          }
        });

        // MARK: CXX CHECKPOINT
        socket.on("CANCEL_CHECKPOINT", async (message, callback) => {
          const log = logger.child({
            eventName: "CANCEL_CHECKPOINT",
            ...getSocketMetadata(),
            ...message,
          });

          log.log("Handling CANCEL_CHECKPOINT");

          try {
            if (message.version === "v1") {
              this.#cancelCheckpoint(socket.data.runId, { event: "CANCEL_CHECKPOINT", ...message });
              // v1 has no callback
              return;
            }

            const checkpointCanceled = this.#cancelCheckpoint(socket.data.runId, {
              event: "CANCEL_CHECKPOINT",
              ...message,
            });

            callback({ version: "v2", checkpointCanceled });
          } catch (error) {
            log.error("CANCEL_CHECKPOINT error", { error });
          }
        });

        // MARK: DURATION WAIT
        socket.on("WAIT_FOR_DURATION", async (message, callback) => {
          const log = logger.child({
            eventName: "WAIT_FOR_DURATION",
            ...getSocketMetadata(),
            ...message,
          });

          log.log("Handling WAIT_FOR_DURATION");

          try {
            await chaosMonkey.call({ throwErrors: false });

            if (checkpointInProgress()) {
              log.error("Checkpoint already in progress");
              callback({ willCheckpointAndRestore: false });
              return;
            }

            const { canCheckpoint, willSimulate } = await this.#checkpointer.init();

            const willCheckpointAndRestore = canCheckpoint || willSimulate;

            callback({ willCheckpointAndRestore });

            if (!willCheckpointAndRestore) {
              return;
            }

            const ready = await readyToCheckpoint("WAIT_FOR_DURATION");

            if (!ready.success) {
              log.error("Failed to become checkpointable", { reason: ready.reason });
              return;
            }

            const runId = socket.data.runId;
            const attemptNumber = getAttemptNumber();

            const checkpoint = await this.#checkpointer.checkpointAndPush({
              runId,
              projectRef: socket.data.projectRef,
              deploymentVersion: socket.data.deploymentVersion,
              attemptNumber,
            });

            if (!checkpoint) {
              // The task container will keep running until the wait duration has elapsed
              log.error("Failed to checkpoint");
              return;
            }

            log.addFields({ checkpoint });

            const ack = await this.#platformSocket?.sendWithAck("CHECKPOINT_CREATED", {
              version: "v1",
              runId: socket.data.runId,
              attemptFriendlyId: message.attemptFriendlyId,
              docker: checkpoint.docker,
              location: checkpoint.location,
              reason: {
                type: "WAIT_FOR_DURATION",
                ms: message.ms,
                now: message.now,
              },
            });

            if (ack?.keepRunAlive) {
              log.log("keeping run alive after duration checkpoint");

              if (checkpoint.docker && willSimulate) {
                // The container is still paused so we need to unpause it
                log.log("unpausing container after duration checkpoint");
                this.#checkpointer.unpause(runId, attemptNumber);
              }

              return;
            }

            if (!checkpoint.docker || !willSimulate) {
              exitRun();
            }
          } catch (error) {
            log.error("WAIT_FOR_DURATION error", { error });

            await crashRun({
              name: "WaitForDurationError",
              message:
                error instanceof Error ? `Unexpected error: ${error.message}` : "Unexpected error",
            });

            return;
          }
        });

        // MARK: TASK WAIT
        socket.on("WAIT_FOR_TASK", async (message, callback) => {
          const log = logger.child({
            eventName: "WAIT_FOR_TASK",
            ...getSocketMetadata(),
            ...message,
          });

          log.log("Handling WAIT_FOR_TASK");

          try {
            await chaosMonkey.call({ throwErrors: false });

            if (checkpointInProgress()) {
              log.error("Checkpoint already in progress");
              callback({ willCheckpointAndRestore: false });
              return;
            }

            const { canCheckpoint, willSimulate } = await this.#checkpointer.init();

            const willCheckpointAndRestore = canCheckpoint || willSimulate;

            callback({ willCheckpointAndRestore });

            if (!willCheckpointAndRestore) {
              return;
            }

            // Workers with v1 schemas don't signal when they're ready to checkpoint for dependency waits
            if (message.version === "v2") {
              const ready = await readyToCheckpoint("WAIT_FOR_TASK");

              if (!ready.success) {
                log.error("Failed to become checkpointable", { reason: ready.reason });
                return;
              }
            }

            const runId = socket.data.runId;
            const attemptNumber = getAttemptNumber();

            const checkpoint = await this.#checkpointer.checkpointAndPush(
              {
                runId,
                projectRef: socket.data.projectRef,
                deploymentVersion: socket.data.deploymentVersion,
                attemptNumber,
              },
              WAIT_FOR_TASK_CHECKPOINT_DELAY_MS
            );

            if (!checkpoint) {
              log.error("Failed to checkpoint");
              return;
            }

            log.addFields({ checkpoint });

            log.log("WAIT_FOR_TASK checkpoint created");

            //setting this means we can only resume from a checkpoint
            socket.data.requiresCheckpointResumeWithMessage = `location:${checkpoint.location}-docker:${checkpoint.docker}`;
            log.log("WAIT_FOR_TASK set requiresCheckpointResumeWithMessage");

            const ack = await this.#platformSocket?.sendWithAck("CHECKPOINT_CREATED", {
              version: "v1",
              runId: socket.data.runId,
              attemptFriendlyId: message.attemptFriendlyId,
              docker: checkpoint.docker,
              location: checkpoint.location,
              reason: {
                type: "WAIT_FOR_TASK",
                friendlyId: message.friendlyId,
              },
            });

            if (ack?.keepRunAlive) {
              socket.data.requiresCheckpointResumeWithMessage = undefined;
              log.log("keeping run alive after task checkpoint");

              if (checkpoint.docker && willSimulate) {
                // The container is still paused so we need to unpause it
                log.log("unpausing container after duration checkpoint");
                this.#checkpointer.unpause(runId, attemptNumber);
              }

              return;
            }

            if (!checkpoint.docker || !willSimulate) {
              exitRun();
            }
          } catch (error) {
            log.error("WAIT_FOR_TASK error", { error });

            await crashRun({
              name: "WaitForTaskError",
              message:
                error instanceof Error ? `Unexpected error: ${error.message}` : "Unexpected error",
            });

            return;
          }
        });

        // MARK: BATCH WAIT
        socket.on("WAIT_FOR_BATCH", async (message, callback) => {
          const log = logger.child({
            eventName: "WAIT_FOR_BATCH",
            ...getSocketMetadata(),
            ...message,
          });

          log.log("Handling WAIT_FOR_BATCH", message);

          try {
            await chaosMonkey.call({ throwErrors: false });

            if (checkpointInProgress()) {
              log.error("Checkpoint already in progress");
              callback({ willCheckpointAndRestore: false });
              return;
            }

            const { canCheckpoint, willSimulate } = await this.#checkpointer.init();

            const willCheckpointAndRestore = canCheckpoint || willSimulate;

            callback({ willCheckpointAndRestore });

            if (!willCheckpointAndRestore) {
              return;
            }

            // Workers with v1 schemas don't signal when they're ready to checkpoint for dependency waits
            if (message.version === "v2") {
              const ready = await readyToCheckpoint("WAIT_FOR_BATCH");

              if (!ready.success) {
                log.error("Failed to become checkpointable", { reason: ready.reason });
                return;
              }
            }

            const runId = socket.data.runId;
            const attemptNumber = getAttemptNumber();

            const checkpoint = await this.#checkpointer.checkpointAndPush(
              {
                runId,
                projectRef: socket.data.projectRef,
                deploymentVersion: socket.data.deploymentVersion,
                attemptNumber,
              },
              WAIT_FOR_BATCH_CHECKPOINT_DELAY_MS
            );

            if (!checkpoint) {
              log.error("Failed to checkpoint");
              return;
            }

            log.addFields({ checkpoint });

            log.log("WAIT_FOR_BATCH checkpoint created");

            //setting this means we can only resume from a checkpoint
            socket.data.requiresCheckpointResumeWithMessage = `location:${checkpoint.location}-docker:${checkpoint.docker}`;
            log.log("WAIT_FOR_BATCH set checkpoint");

            const ack = await this.#platformSocket?.sendWithAck("CHECKPOINT_CREATED", {
              version: "v1",
              runId: socket.data.runId,
              attemptFriendlyId: message.attemptFriendlyId,
              docker: checkpoint.docker,
              location: checkpoint.location,
              reason: {
                type: "WAIT_FOR_BATCH",
                batchFriendlyId: message.batchFriendlyId,
                runFriendlyIds: message.runFriendlyIds,
              },
            });

            if (ack?.keepRunAlive) {
              socket.data.requiresCheckpointResumeWithMessage = undefined;
              log.log("keeping run alive after batch checkpoint");

              if (checkpoint.docker && willSimulate) {
                // The container is still paused so we need to unpause it
                log.log("unpausing container after batch checkpoint");
                this.#checkpointer.unpause(runId, attemptNumber);
              }

              return;
            }

            if (!checkpoint.docker || !willSimulate) {
              exitRun();
            }
          } catch (error) {
            log.error("WAIT_FOR_BATCH error", { error });

            await crashRun({
              name: "WaitForBatchError",
              message:
                error instanceof Error ? `Unexpected error: ${error.message}` : "Unexpected error",
            });

            return;
          }
        });

        // MARK: INDEX
        socket.on("INDEX_TASKS", async (message, callback) => {
          const log = logger.child({
            eventName: "INDEX_TASKS",
            ...getSocketMetadata(),
            ...message,
          });

          log.log("Handling INDEX_TASKS");

          try {
            const workerAck = await this.#platformSocket?.sendWithAck("CREATE_WORKER", {
              version: "v2",
              projectRef: socket.data.projectRef,
              envId: socket.data.envId,
              deploymentId: message.deploymentId,
              metadata: {
                contentHash: socket.data.contentHash,
                packageVersion: message.packageVersion,
                tasks: message.tasks,
              },
              supportsLazyAttempts: message.version !== "v1" && message.supportsLazyAttempts,
            });

            if (!workerAck) {
              log.debug("no worker ack while indexing");
            }

            callback({ success: !!workerAck?.success });
          } catch (error) {
            log.error("INDEX_TASKS error", { error });
            callback({ success: false });
          }
        });

        // MARK: INDEX FAILED
        socket.on("INDEXING_FAILED", async (message) => {
          const log = logger.child({
            eventName: "INDEXING_FAILED",
            ...getSocketMetadata(),
            ...message,
          });

          log.log("Handling INDEXING_FAILED");

          try {
            this.#platformSocket?.send("INDEXING_FAILED", {
              version: "v1",
              deploymentId: message.deploymentId,
              error: message.error,
            });
          } catch (error) {
            log.error("INDEXING_FAILED error", { error });
          }
        });

        // MARK: CREATE ATTEMPT
        socket.on("CREATE_TASK_RUN_ATTEMPT", async (message, callback) => {
          const log = logger.child({
            eventName: "CREATE_TASK_RUN_ATTEMPT",
            ...getSocketMetadata(),
            ...message,
          });

          log.log("Handling CREATE_TASK_RUN_ATTEMPT");

          try {
            await chaosMonkey.call({ throwErrors: false });

            const createAttempt = await this.#platformSocket?.sendWithAck(
              "CREATE_TASK_RUN_ATTEMPT",
              {
                runId: message.runId,
                envId: socket.data.envId,
              }
            );

            if (!createAttempt?.success) {
              log.debug("no ack while creating attempt", { reason: createAttempt?.reason });
              callback({ success: false, reason: createAttempt?.reason });
              return;
            }

            updateAttemptFriendlyId(createAttempt.executionPayload.execution.attempt.id);
            updateAttemptNumber(createAttempt.executionPayload.execution.attempt.number);

            callback({
              success: true,
              executionPayload: createAttempt.executionPayload,
            });
          } catch (error) {
            log.error("CREATE_TASK_RUN_ATTEMPT error", { error });
            callback({
              success: false,
              reason:
                error instanceof Error ? `Unexpected error: ${error.message}` : "Unexpected error",
            });
          }
        });

        socket.on("UNRECOVERABLE_ERROR", async (message) => {
          const log = logger.child({
            eventName: "UNRECOVERABLE_ERROR",
            ...getSocketMetadata(),
            error: message.error,
          });

          log.log("Handling UNRECOVERABLE_ERROR");

          try {
            await crashRun(message.error);
          } catch (error) {
            log.error("UNRECOVERABLE_ERROR error", { error });
          }
        });

        socket.on("SET_STATE", async (message) => {
          const log = logger.child({
            eventName: "SET_STATE",
            ...getSocketMetadata(),
            ...message,
          });

          log.log("Handling SET_STATE");

          try {
            if (message.attemptFriendlyId) {
              updateAttemptFriendlyId(message.attemptFriendlyId);
            }

            if (message.attemptNumber) {
              updateAttemptNumber(message.attemptNumber);
            }
          } catch (error) {
            log.error("SET_STATE error", { error });
          }
        });
      },
      onDisconnect: async (socket, handler, sender, logger) => {
        try {
          this.#platformSocket?.send("LOG", {
            metadata: socket.data,
            text: "disconnect",
          });
        } catch (error) {
          logger.error("onDisconnect error", { error });
        }
      },
      handlers: {
        TASK_HEARTBEAT: async (message) => {
          this.#platformSocket?.send("TASK_HEARTBEAT", message);
        },
        TASK_RUN_HEARTBEAT: async (message) => {
          this.#sendRunHeartbeat(message.runId);
        },
      },
    });

    return provider;
  }

  #sendRunHeartbeat(runId: string) {
    this.#platformSocket?.send("TASK_RUN_HEARTBEAT", {
      version: "v1",
      runId,
    });
  }

  #cancelCheckpoint(runId: string, reason?: any): boolean {
    logger.log("cancelCheckpoint: call", { runId, reason });

    const checkpointWait = this.#checkpointableTasks.get(runId);

    if (checkpointWait) {
      // Stop waiting for task to reach checkpointable state
      checkpointWait.reject(new CheckpointCancelError());
    }

    // Cancel checkpointing procedure
    const checkpointCanceled = this.#checkpointer.cancelAllCheckpointsForRun(runId);

    logger.log("cancelCheckpoint: result", {
      runId,
      reason,
      checkpointCanceled,
      hadCheckpointWait: !!checkpointWait,
    });

    return checkpointCanceled;
  }

  // MARK: HTTP SERVER
  #createHttpServer() {
    const httpServer = createServer(async (req, res) => {
      logger.log(`[${req.method}]`, { url: req.url });

      const reply = new HttpReply(res);

      switch (req.url) {
        case "/health": {
          return reply.text("ok");
        }
        case "/metrics": {
          return reply.text(await register.metrics(), 200, register.contentType);
        }
        default: {
          return reply.empty(404);
        }
      }
    });

    httpServer.on("clientError", (err, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    httpServer.on("listening", () => {
      logger.log("server listening on port", { port: HTTP_SERVER_PORT });
    });

    return httpServer;
  }

  #createInternalHttpServer() {
    const httpServer = createServer(async (req, res) => {
      logger.log(`[${req.method}]`, { url: req.url });

      const reply = new HttpReply(res);

      switch (req.url) {
        case "/whoami": {
          return reply.text(NODE_NAME);
        }
        case "/checkpoint/duration": {
          try {
            const body = await getTextBody(req);
            const json = safeJsonParse(body);

            if (typeof json !== "object" || !json) {
              return reply.text("Invalid body", 400);
            }

            if (!("runId" in json) || typeof json.runId !== "string") {
              return reply.text("Missing or invalid: runId", 400);
            }

            if (!("now" in json) || typeof json.now !== "number") {
              return reply.text("Missing or invalid: now", 400);
            }

            if (!("ms" in json) || typeof json.ms !== "number") {
              return reply.text("Missing or invalid: ms", 400);
            }

            let keepRunAlive = false;
            if ("keepRunAlive" in json && typeof json.keepRunAlive === "boolean") {
              keepRunAlive = json.keepRunAlive;
            }

            let async = false;
            if ("async" in json && typeof json.async === "boolean") {
              async = json.async;
            }

            const { runId, now, ms } = json;

            if (!runId) {
              return reply.text("Missing runId", 400);
            }

            const runSocket = await this.#getRunSocket(runId);
            if (!runSocket) {
              return reply.text("Run socket not found", 404);
            }

            const { data } = runSocket;

            console.log("Manual duration checkpoint", data);

            if (async) {
              reply.text("Creating checkpoint in the background", 202);
            }

            const checkpoint = await this.#checkpointer.checkpointAndPush({
              runId: data.runId,
              projectRef: data.projectRef,
              deploymentVersion: data.deploymentVersion,
              attemptNumber: data.attemptNumber ? parseInt(data.attemptNumber) : undefined,
            });

            if (!checkpoint) {
              return reply.text("Failed to checkpoint", 500);
            }

            if (!data.attemptFriendlyId) {
              return reply.text("Socket data missing attemptFriendlyId", 500);
            }

            const ack = await this.#platformSocket?.sendWithAck("CHECKPOINT_CREATED", {
              version: "v1",
              runId,
              attemptFriendlyId: data.attemptFriendlyId,
              docker: checkpoint.docker,
              location: checkpoint.location,
              reason: {
                type: "WAIT_FOR_DURATION",
                ms,
                now,
              },
            });

            if (ack?.keepRunAlive || keepRunAlive) {
              return reply.json({
                message: `keeping run ${runId} alive after checkpoint`,
                checkpoint,
                requestJson: json,
                platformAck: ack,
              });
            }

            runSocket.emit("REQUEST_EXIT", {
              version: "v1",
            });

            return reply.json({
              message: `checkpoint created for run ${runId}`,
              checkpoint,
              requestJson: json,
              platformAck: ack,
            });
          } catch (error) {
            return reply.json({
              message: `error`,
              error,
            });
          }
        }
        case "/checkpoint/manual": {
          try {
            const body = await getTextBody(req);
            const json = safeJsonParse(body);

            if (typeof json !== "object" || !json) {
              return reply.text("Invalid body", 400);
            }

            if (!("runId" in json) || typeof json.runId !== "string") {
              return reply.text("Missing or invalid: runId", 400);
            }

            let restoreAtUnixTimeMs: number | undefined;
            if ("restoreAtUnixTimeMs" in json && typeof json.restoreAtUnixTimeMs === "number") {
              restoreAtUnixTimeMs = json.restoreAtUnixTimeMs;
            }

            let keepRunAlive = false;
            if ("keepRunAlive" in json && typeof json.keepRunAlive === "boolean") {
              keepRunAlive = json.keepRunAlive;
            }

            let async = false;
            if ("async" in json && typeof json.async === "boolean") {
              async = json.async;
            }

            const { runId } = json;

            if (!runId) {
              return reply.text("Missing runId", 400);
            }

            const runSocket = await this.#getRunSocket(runId);
            if (!runSocket) {
              return reply.text("Run socket not found", 404);
            }

            const { data } = runSocket;

            console.log("Manual checkpoint", data);

            if (async) {
              reply.text("Creating checkpoint in the background", 202);
            }

            const checkpoint = await this.#checkpointer.checkpointAndPush({
              runId: data.runId,
              projectRef: data.projectRef,
              deploymentVersion: data.deploymentVersion,
              attemptNumber: data.attemptNumber ? parseInt(data.attemptNumber) : undefined,
            });

            if (!checkpoint) {
              return reply.text("Failed to checkpoint", 500);
            }

            if (!data.attemptFriendlyId) {
              return reply.text("Socket data missing attemptFriendlyId", 500);
            }

            const ack = await this.#platformSocket?.sendWithAck("CHECKPOINT_CREATED", {
              version: "v1",
              runId,
              attemptFriendlyId: data.attemptFriendlyId,
              docker: checkpoint.docker,
              location: checkpoint.location,
              reason: {
                type: "MANUAL",
                restoreAtUnixTimeMs,
              },
            });

            if (ack?.keepRunAlive || keepRunAlive) {
              return reply.json({
                message: `keeping run ${runId} alive after checkpoint`,
                checkpoint,
                requestJson: json,
                platformAck: ack,
              });
            }

            runSocket.emit("REQUEST_EXIT", {
              version: "v1",
            });

            return reply.json({
              message: `checkpoint created for run ${runId}`,
              checkpoint,
              requestJson: json,
              platformAck: ack,
            });
          } catch (error) {
            return reply.json({
              message: `error`,
              error,
            });
          }
        }
        default: {
          return reply.empty(404);
        }
      }
    });

    httpServer.on("clientError", (err, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    httpServer.on("listening", () => {
      logger.log("internal server listening on port", { port: HTTP_SERVER_PORT + 100 });
    });

    return httpServer;
  }

  listen() {
    this.#httpServer.listen(this.port, this.host);
    this.#internalHttpServer.listen(this.port + 100, "127.0.0.1");
  }
}

const coordinator = new TaskCoordinator(HTTP_SERVER_PORT);
coordinator.listen();
