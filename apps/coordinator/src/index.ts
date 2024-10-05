import { createServer } from "node:http";
import { Server } from "socket.io";
import {
  CoordinatorToPlatformMessages,
  CoordinatorToProdWorkerMessages,
  PlatformToCoordinatorMessages,
  ProdWorkerSocketData,
  ProdWorkerToCoordinatorMessages,
  WaitReason,
} from "@trigger.dev/core/v3";
import { ZodNamespace } from "@trigger.dev/core/v3/zodNamespace";
import { ZodSocketConnection } from "@trigger.dev/core/v3/zodSocket";
import { HttpReply, getTextBody } from "@trigger.dev/core/v3/apps";
import { SimpleLogger } from "@trigger.dev/core/v3/apps";
import { ChaosMonkey } from "./chaosMonkey";
import { Checkpointer } from "./checkpointer";
import { boolFromEnv, numFromEnv } from "./util";

import { collectDefaultMetrics, register, Gauge } from "prom-client";
collectDefaultMetrics();

const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || 8020);
const NODE_NAME = process.env.NODE_NAME || "coordinator";
const DEFAULT_RETRY_DELAY_THRESHOLD_IN_MS = 30_000;

const PLATFORM_ENABLED = ["1", "true"].includes(process.env.PLATFORM_ENABLED ?? "true");
const PLATFORM_HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PLATFORM_WS_PORT = process.env.PLATFORM_WS_PORT || 3030;
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || "coordinator-secret";
const SECURE_CONNECTION = ["1", "true"].includes(process.env.SECURE_CONNECTION ?? "false");

const logger = new SimpleLogger(`[${NODE_NAME}]`);
const chaosMonkey = new ChaosMonkey(
  !!process.env.CHAOS_MONKEY_ENABLED,
  !!process.env.CHAOS_MONKEY_DISABLE_ERRORS,
  !!process.env.CHAOS_MONKEY_DISABLE_DELAYS
);

class CheckpointReadinessTimeoutError extends Error {}
class CheckpointCancelError extends Error {}

class TaskCoordinator {
  #httpServer: ReturnType<typeof createServer>;
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
      console.log("INFO: platform connection disabled");
      return;
    }

    const extraHeaders = this.#returnValidatedExtraHeaders({
      "x-supports-dynamic-config": "yes",
    });

    const host = PLATFORM_HOST;
    const port = Number(PLATFORM_WS_PORT);

    logger.log(`connecting to platform: ${host}:${port}`);
    logger.debug(`connecting with extra headers`, { extraHeaders });

    const platformConnection = new ZodSocketConnection({
      namespace: "coordinator",
      host,
      port,
      secure: SECURE_CONNECTION,
      extraHeaders,
      clientMessages: CoordinatorToPlatformMessages,
      serverMessages: PlatformToCoordinatorMessages,
      authToken: PLATFORM_SECRET,
      handlers: {
        RESUME_AFTER_DEPENDENCY: async (message) => {
          const taskSocket = await this.#getAttemptSocket(message.attemptFriendlyId);

          if (!taskSocket) {
            logger.log("Socket for attempt not found", {
              attemptFriendlyId: message.attemptFriendlyId,
            });
            return;
          }

          await chaosMonkey.call();

          // In case the task resumed faster than we could checkpoint
          this.#cancelCheckpoint(message.runId);

          taskSocket.emit("RESUME_AFTER_DEPENDENCY", message);
        },
        RESUME_AFTER_DEPENDENCY_WITH_ACK: async (message) => {
          const taskSocket = await this.#getAttemptSocket(message.attemptFriendlyId);

          if (!taskSocket) {
            logger.log("Socket for attempt not found", {
              attemptFriendlyId: message.attemptFriendlyId,
            });
            return {
              success: false,
              error: {
                name: "SocketNotFoundError",
                message: "Socket for attempt not found",
              },
            };
          }

          //if this is set, we want to kill the process because it will be resumed with the checkpoint from the queue
          if (taskSocket.data.requiresCheckpointResumeWithMessage) {
            logger.log("RESUME_AFTER_DEPENDENCY_WITH_ACK: Checkpoint is set so going to nack", {
              socketData: taskSocket.data,
            });

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

          // In case the task resumed faster than we could checkpoint
          this.#cancelCheckpoint(message.runId);

          taskSocket.emit("RESUME_AFTER_DEPENDENCY", message);

          return {
            success: true,
          };
        },
        RESUME_AFTER_DURATION: async (message) => {
          const taskSocket = await this.#getAttemptSocket(message.attemptFriendlyId);

          if (!taskSocket) {
            logger.log("Socket for attempt not found", {
              attemptFriendlyId: message.attemptFriendlyId,
            });
            return;
          }

          await chaosMonkey.call();

          taskSocket.emit("RESUME_AFTER_DURATION", message);
        },
        REQUEST_ATTEMPT_CANCELLATION: async (message) => {
          const taskSocket = await this.#getAttemptSocket(message.attemptFriendlyId);

          if (!taskSocket) {
            logger.log("Socket for attempt not found", {
              attemptFriendlyId: message.attemptFriendlyId,
            });
            return;
          }

          taskSocket.emit("REQUEST_ATTEMPT_CANCELLATION", message);
        },
        REQUEST_RUN_CANCELLATION: async (message) => {
          const taskSocket = await this.#getRunSocket(message.runId);

          if (!taskSocket) {
            logger.log("Socket for run not found", {
              runId: message.runId,
            });
            return;
          }

          this.#cancelCheckpoint(message.runId);

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
          const taskSocket = await this.#getRunSocket(message.runId);

          if (!taskSocket) {
            logger.log("Socket for attempt not found", {
              runId: message.runId,
            });
            return;
          }

          await chaosMonkey.call();

          taskSocket.emit("READY_FOR_RETRY", message);
        },
        DYNAMIC_CONFIG: async (message) => {
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
        const logger = new SimpleLogger(`[prod-worker][${socket.id}]`);

        const getAttemptNumber = () => {
          return socket.data.attemptNumber ? parseInt(socket.data.attemptNumber) : undefined;
        };

        const crashRun = async (error: { name: string; message: string; stack?: string }) => {
          try {
            this.#platformSocket?.send("RUN_CRASHED", {
              version: "v1",
              runId: socket.data.runId,
              error,
            });
          } finally {
            socket.emit("REQUEST_EXIT", {
              version: "v1",
            });
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
          logger.log("readyToCheckpoint", { runId: socket.data.runId, reason });

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
            logger.error("Error while waiting for checkpointable state", {
              error,
              runId: socket.data.runId,
            });

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
          logger.log("[TEST]", { runId: socket.data.runId, message });

          callback();
        });

        // Deprecated: Only workers without support for lazy attempts use this
        socket.on("READY_FOR_EXECUTION", async (message) => {
          logger.log("[READY_FOR_EXECUTION]", message);

          try {
            const executionAck = await this.#platformSocket?.sendWithAck(
              "READY_FOR_EXECUTION",
              message
            );

            if (!executionAck) {
              logger.error("no execution ack", { runId: socket.data.runId });

              await crashRun({
                name: "ReadyForExecutionError",
                message: "No execution ack",
              });

              return;
            }

            if (!executionAck.success) {
              logger.error("failed to get execution payload", { runId: socket.data.runId });

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
            logger.error("READY_FOR_EXECUTION error", { error, runId: socket.data.runId });

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
          logger.log("[READY_FOR_LAZY_ATTEMPT]", message);

          try {
            const lazyAttempt = await this.#platformSocket?.sendWithAck("READY_FOR_LAZY_ATTEMPT", {
              ...message,
              envId: socket.data.envId,
            });

            if (!lazyAttempt) {
              logger.error("no lazy attempt ack", { runId: socket.data.runId });

              await crashRun({
                name: "ReadyForLazyAttemptError",
                message: "No lazy attempt ack",
              });

              return;
            }

            if (!lazyAttempt.success) {
              logger.error("failed to get lazy attempt payload", { runId: socket.data.runId });

              await crashRun({
                name: "ReadyForLazyAttemptError",
                message: "Failed to get lazy attempt payload",
              });

              return;
            }

            await chaosMonkey.call();

            socket.emit("EXECUTE_TASK_RUN_LAZY_ATTEMPT", {
              version: "v1",
              lazyPayload: lazyAttempt.lazyPayload,
            });
          } catch (error) {
            if (error instanceof ChaosMonkey.Error) {
              logger.error("ChaosMonkey error, won't crash run", { runId: socket.data.runId });
              return;
            }

            logger.error("READY_FOR_LAZY_ATTEMPT error", { error, runId: socket.data.runId });

            await crashRun({
              name: "ReadyForLazyAttemptError",
              message:
                error instanceof Error ? `Unexpected error: ${error.message}` : "Unexpected error",
            });

            return;
          }
        });

        // MARK: RESUME READY
        socket.on("READY_FOR_RESUME", async (message) => {
          logger.log("[READY_FOR_RESUME]", message);

          updateAttemptFriendlyId(message.attemptFriendlyId);

          if (message.version === "v2") {
            updateAttemptNumber(message.attemptNumber);
          }

          this.#platformSocket?.send("READY_FOR_RESUME", { ...message, version: "v1" });
        });

        // MARK: RUN COMPLETED
        socket.on("TASK_RUN_COMPLETED", async (message, callback) => {
          const { completion, execution } = message;

          logger.log("completed task", { completionId: completion.id });

          // Cancel all in-progress checkpoints (if any)
          this.#cancelCheckpoint(socket.data.runId);

          await chaosMonkey.call({ throwErrors: false });

          const completeWithoutCheckpoint = (shouldExit: boolean) => {
            const supportsRetryCheckpoints = message.version === "v1";

            this.#platformSocket?.send("TASK_RUN_COMPLETED", {
              version: supportsRetryCheckpoints ? "v1" : "v2",
              execution,
              completion,
            });
            callback({ willCheckpointAndRestore: false, shouldExit });
          };

          if (completion.ok) {
            completeWithoutCheckpoint(true);
            return;
          }

          if (
            completion.error.type === "INTERNAL_ERROR" &&
            completion.error.code === "TASK_RUN_CANCELLED"
          ) {
            completeWithoutCheckpoint(true);
            return;
          }

          if (completion.retry === undefined) {
            completeWithoutCheckpoint(true);
            return;
          }

          if (completion.retry.delay < this.#delayThresholdInMs) {
            completeWithoutCheckpoint(false);

            // Prevents runs that fail fast from never sending a heartbeat
            this.#sendRunHeartbeat(socket.data.runId);

            return;
          }

          if (message.version === "v2") {
            completeWithoutCheckpoint(true);
            return;
          }

          const { canCheckpoint, willSimulate } = await this.#checkpointer.init();

          const willCheckpointAndRestore = canCheckpoint || willSimulate;

          if (!willCheckpointAndRestore) {
            completeWithoutCheckpoint(false);
            return;
          }

          // The worker will then put itself in a checkpointable state
          callback({ willCheckpointAndRestore: true, shouldExit: false });

          const ready = await readyToCheckpoint("RETRY");

          if (!ready.success) {
            logger.error("Failed to become checkpointable", {
              runId: socket.data.runId,
              reason: ready.reason,
            });

            return;
          }

          const checkpoint = await this.#checkpointer.checkpointAndPush({
            runId: socket.data.runId,
            projectRef: socket.data.projectRef,
            deploymentVersion: socket.data.deploymentVersion,
            shouldHeartbeat: true,
          });

          if (!checkpoint) {
            logger.error("Failed to checkpoint", { runId: socket.data.runId });
            completeWithoutCheckpoint(false);
            return;
          }

          this.#platformSocket?.send("TASK_RUN_COMPLETED", {
            version: "v1",
            execution,
            completion,
            checkpoint,
          });

          if (!checkpoint.docker || !willSimulate) {
            socket.emit("REQUEST_EXIT", {
              version: "v1",
            });
          }
        });

        // MARK: TASK FAILED
        socket.on("TASK_RUN_FAILED_TO_RUN", async ({ completion }) => {
          logger.log("task failed to run", { completionId: completion.id });

          // Cancel all in-progress checkpoints (if any)
          this.#cancelCheckpoint(socket.data.runId);

          this.#platformSocket?.send("TASK_RUN_FAILED_TO_RUN", {
            version: "v1",
            completion,
          });

          socket.emit("REQUEST_EXIT", {
            version: "v1",
          });
        });

        // MARK: CHECKPOINT
        socket.on("READY_FOR_CHECKPOINT", async (message) => {
          logger.log("[READY_FOR_CHECKPOINT]", message);

          const checkpointable = this.#checkpointableTasks.get(socket.data.runId);

          if (!checkpointable) {
            logger.error("No checkpoint scheduled", { runId: socket.data.runId });
            return;
          }

          checkpointable.resolve();
        });

        // MARK: CXX CHECKPOINT
        socket.on("CANCEL_CHECKPOINT", async (message, callback) => {
          logger.log("[CANCEL_CHECKPOINT]", message);

          if (message.version === "v1") {
            this.#cancelCheckpoint(socket.data.runId);
            // v1 has no callback
            return;
          }

          const checkpointCanceled = this.#cancelCheckpoint(socket.data.runId);

          callback({ version: "v2", checkpointCanceled });
        });

        // MARK: DURATION WAIT
        socket.on("WAIT_FOR_DURATION", async (message, callback) => {
          logger.log("[WAIT_FOR_DURATION]", message);

          await chaosMonkey.call({ throwErrors: false });

          if (checkpointInProgress()) {
            logger.error("Checkpoint already in progress", { runId: socket.data.runId });
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
            logger.error("Failed to become checkpointable", {
              runId: socket.data.runId,
              reason: ready.reason,
            });
            return;
          }

          const checkpoint = await this.#checkpointer.checkpointAndPush({
            runId: socket.data.runId,
            projectRef: socket.data.projectRef,
            deploymentVersion: socket.data.deploymentVersion,
            attemptNumber: getAttemptNumber(),
          });

          if (!checkpoint) {
            // The task container will keep running until the wait duration has elapsed
            logger.error("Failed to checkpoint", { runId: socket.data.runId });
            return;
          }

          const ack = await this.#platformSocket?.sendWithAck("CHECKPOINT_CREATED", {
            version: "v1",
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
            logger.log("keeping run alive after duration checkpoint", { runId: socket.data.runId });
            return;
          }

          if (!checkpoint.docker || !willSimulate) {
            socket.emit("REQUEST_EXIT", {
              version: "v1",
            });
          }
        });

        // MARK: TASK WAIT
        socket.on("WAIT_FOR_TASK", async (message, callback) => {
          logger.log("[WAIT_FOR_TASK]", message);

          await chaosMonkey.call({ throwErrors: false });

          if (checkpointInProgress()) {
            logger.error("Checkpoint already in progress", { runId: socket.data.runId });
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
              logger.error("Failed to become checkpointable", {
                runId: socket.data.runId,
                reason: ready.reason,
              });
              return;
            }
          }

          const checkpoint = await this.#checkpointer.checkpointAndPush({
            runId: socket.data.runId,
            projectRef: socket.data.projectRef,
            deploymentVersion: socket.data.deploymentVersion,
            attemptNumber: getAttemptNumber(),
          });

          if (!checkpoint) {
            logger.error("Failed to checkpoint", { runId: socket.data.runId });
            return;
          }

          logger.log("WAIT_FOR_TASK checkpoint created", {
            checkpoint,
            socketData: socket.data,
          });

          //setting this means we can only resume from a checkpoint
          socket.data.requiresCheckpointResumeWithMessage = `location:${checkpoint.location}-docker:${checkpoint.docker}`;
          logger.log("WAIT_FOR_TASK set requiresCheckpointResumeWithMessage", {
            checkpoint,
            socketData: socket.data,
          });

          const ack = await this.#platformSocket?.sendWithAck("CHECKPOINT_CREATED", {
            version: "v1",
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
            logger.log("keeping run alive after task checkpoint", { runId: socket.data.runId });
            return;
          }

          if (!checkpoint.docker || !willSimulate) {
            socket.emit("REQUEST_EXIT", {
              version: "v1",
            });
          }
        });

        // MARK: BATCH WAIT
        socket.on("WAIT_FOR_BATCH", async (message, callback) => {
          logger.log("[WAIT_FOR_BATCH]", message);

          await chaosMonkey.call({ throwErrors: false });

          if (checkpointInProgress()) {
            logger.error("Checkpoint already in progress", { runId: socket.data.runId });
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
              logger.error("Failed to become checkpointable", {
                runId: socket.data.runId,
                reason: ready.reason,
              });
              return;
            }
          }

          const checkpoint = await this.#checkpointer.checkpointAndPush({
            runId: socket.data.runId,
            projectRef: socket.data.projectRef,
            deploymentVersion: socket.data.deploymentVersion,
            attemptNumber: getAttemptNumber(),
          });

          if (!checkpoint) {
            logger.error("Failed to checkpoint", { runId: socket.data.runId });
            return;
          }

          logger.log("WAIT_FOR_BATCH checkpoint created", {
            checkpoint,
            socketData: socket.data,
          });

          //setting this means we can only resume from a checkpoint
          socket.data.requiresCheckpointResumeWithMessage = `location:${checkpoint.location}-docker:${checkpoint.docker}`;
          logger.log("WAIT_FOR_BATCH set checkpoint", {
            checkpoint,
            socketData: socket.data,
          });

          const ack = await this.#platformSocket?.sendWithAck("CHECKPOINT_CREATED", {
            version: "v1",
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
            logger.log("keeping run alive after batch checkpoint", { runId: socket.data.runId });
            return;
          }

          if (!checkpoint.docker || !willSimulate) {
            socket.emit("REQUEST_EXIT", {
              version: "v1",
            });
          }
        });

        // MARK: INDEX
        socket.on("INDEX_TASKS", async (message, callback) => {
          logger.log("[INDEX_TASKS]", message);

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
            logger.debug("no worker ack while indexing", message);
          }

          callback({ success: !!workerAck?.success });
        });

        // MARK: INDEX FAILED
        socket.on("INDEXING_FAILED", async (message) => {
          logger.log("[INDEXING_FAILED]", message);

          this.#platformSocket?.send("INDEXING_FAILED", {
            version: "v1",
            deploymentId: message.deploymentId,
            error: message.error,
          });
        });

        // MARK: CREATE ATTEMPT
        socket.on("CREATE_TASK_RUN_ATTEMPT", async (message, callback) => {
          logger.log("[CREATE_TASK_RUN_ATTEMPT]", message);

          await chaosMonkey.call({ throwErrors: false });

          const createAttempt = await this.#platformSocket?.sendWithAck("CREATE_TASK_RUN_ATTEMPT", {
            runId: message.runId,
            envId: socket.data.envId,
          });

          if (!createAttempt?.success) {
            logger.debug("no ack while creating attempt", message);
            callback({ success: false, reason: createAttempt?.reason });
            return;
          }

          updateAttemptFriendlyId(createAttempt.executionPayload.execution.attempt.id);
          updateAttemptNumber(createAttempt.executionPayload.execution.attempt.number);

          callback({
            success: true,
            executionPayload: createAttempt.executionPayload,
          });
        });

        socket.on("UNRECOVERABLE_ERROR", async (message) => {
          logger.log("[UNRECOVERABLE_ERROR]", message);

          await crashRun(message.error);
        });

        socket.on("SET_STATE", async (message) => {
          logger.log("[SET_STATE]", message);

          if (message.attemptFriendlyId) {
            updateAttemptFriendlyId(message.attemptFriendlyId);
          }

          if (message.attemptNumber) {
            updateAttemptNumber(message.attemptNumber);
          }
        });
      },
      onDisconnect: async (socket, handler, sender, logger) => {
        this.#platformSocket?.send("LOG", {
          metadata: socket.data,
          text: "disconnect",
        });
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

  #cancelCheckpoint(runId: string): boolean {
    const checkpointWait = this.#checkpointableTasks.get(runId);

    if (checkpointWait) {
      // Stop waiting for task to reach checkpointable state
      checkpointWait.reject(new CheckpointCancelError());
    }

    // Cancel checkpointing procedure
    const checkpointCanceled = this.#checkpointer.cancelCheckpoint(runId);

    logger.log("cancelCheckpoint()", { runId, checkpointCanceled });

    return checkpointCanceled;
  }

  // MARK: HTTP SERVER
  #createHttpServer() {
    const httpServer = createServer(async (req, res) => {
      logger.log(`[${req.method}]`, req.url);

      const reply = new HttpReply(res);

      switch (req.url) {
        case "/health": {
          return reply.text("ok");
        }
        case "/metrics": {
          return reply.text(await register.metrics(), 200, register.contentType);
        }
        case "/whoami": {
          return reply.text(NODE_NAME);
        }
        case "/checkpoint": {
          const body = await getTextBody(req);
          // await this.#checkpointer.checkpointAndPush(body);
          return reply.text(`sent restore request: ${body}`);
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
      logger.log("server listening on port", HTTP_SERVER_PORT);
    });

    return httpServer;
  }

  listen() {
    this.#httpServer.listen(this.port, this.host);
  }
}

const coordinator = new TaskCoordinator(HTTP_SERVER_PORT);
coordinator.listen();
