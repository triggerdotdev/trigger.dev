import { createServer } from "node:http";
import fs from "node:fs/promises";
import { $, type ExecaChildProcess } from "execa";
import { nanoid } from "nanoid";
import { Server } from "socket.io";
import {
  CoordinatorToPlatformMessages,
  CoordinatorToProdWorkerMessages,
  PlatformToCoordinatorMessages,
  ProdWorkerSocketData,
  ProdWorkerToCoordinatorMessages,
} from "@trigger.dev/core/v3";
import { ZodNamespace } from "@trigger.dev/core/v3/zodNamespace";
import { ZodSocketConnection } from "@trigger.dev/core/v3/zodSocket";
import { HttpReply, getTextBody, SimpleLogger } from "@trigger.dev/core-apps";
import { ExponentialBackoff } from "./backoff";

import { collectDefaultMetrics, register, Gauge } from "prom-client";
collectDefaultMetrics();

const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || 8020);
const NODE_NAME = process.env.NODE_NAME || "coordinator";
const DEFAULT_RETRY_DELAY_THRESHOLD_IN_MS = 30_000;
const CHAOS_MONKEY_ENABLED = !!process.env.CHAOS_MONKEY_ENABLED;

const FORCE_CHECKPOINT_SIMULATION = ["1", "true"].includes(
  process.env.FORCE_CHECKPOINT_SIMULATION ?? "true"
);
const DISABLE_CHECKPOINT_SUPPORT = ["1", "true"].includes(
  process.env.DISABLE_CHECKPOINT_SUPPORT ?? "false"
);
const SIMULATE_PUSH_FAILURE = ["1", "true"].includes(process.env.SIMULATE_PUSH_FAILURE ?? "false");
const SIMULATE_PUSH_FAILURE_SECONDS = parseInt(
  process.env.SIMULATE_PUSH_FAILURE_SECONDS ?? "300",
  10
);
const SIMULATE_CHECKPOINT_FAILURE = ["1", "true"].includes(
  process.env.SIMULATE_CHECKPOINT_FAILURE ?? "false"
);
const SIMULATE_CHECKPOINT_FAILURE_SECONDS = parseInt(
  process.env.SIMULATE_CHECKPOINT_FAILURE_SECONDS ?? "300",
  10
);

const REGISTRY_HOST = process.env.REGISTRY_HOST || "localhost:5000";
const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH || "/checkpoints";
const REGISTRY_TLS_VERIFY = process.env.REGISTRY_TLS_VERIFY === "false" ? "false" : "true";

const PLATFORM_ENABLED = ["1", "true"].includes(process.env.PLATFORM_ENABLED ?? "true");
const PLATFORM_HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PLATFORM_WS_PORT = process.env.PLATFORM_WS_PORT || 3030;
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || "coordinator-secret";
const SECURE_CONNECTION = ["1", "true"].includes(process.env.SECURE_CONNECTION ?? "false");

const logger = new SimpleLogger(`[${NODE_NAME}]`);

if (CHAOS_MONKEY_ENABLED) {
  logger.log("🍌 Chaos monkey enabled");
}

type CheckpointerInitializeReturn = {
  canCheckpoint: boolean;
  willSimulate: boolean;
};

type CheckpointAndPushOptions = {
  runId: string;
  leaveRunning?: boolean;
  projectRef: string;
  deploymentVersion: string;
};

type CheckpointAndPushResult =
  | { success: true; checkpoint: CheckpointData }
  | { success: false; reason?: "CANCELED" | "DISABLED" | "ERROR" | "IN_PROGRESS" | "NO_SUPPORT" };

type CheckpointData = {
  location: string;
  docker: boolean;
};

function isExecaChildProcess(maybeExeca: unknown): maybeExeca is Awaited<ExecaChildProcess> {
  return typeof maybeExeca === "object" && maybeExeca !== null && "escapedCommand" in maybeExeca;
}

async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch (error) {
    console.error("Error getting file size:", error);
    return -1;
  }
}

async function getParsedFileSize(filePath: string) {
  const sizeInBytes = await getFileSize(filePath);

  let message = `Size in bytes: ${sizeInBytes}`;

  if (sizeInBytes > 1024 * 1024) {
    const sizeInMB = (sizeInBytes / 1024 / 1024).toFixed(2);
    message = `Size in MB (rounded): ${sizeInMB}`;
  } else if (sizeInBytes > 1024) {
    const sizeInKB = (sizeInBytes / 1024).toFixed(2);
    message = `Size in KB (rounded): ${sizeInKB}`;
  }

  return {
    path: filePath,
    sizeInBytes,
    message,
  };
}

class Checkpointer {
  #initialized = false;
  #canCheckpoint = false;
  #dockerMode = !process.env.KUBERNETES_PORT;

  #logger = new SimpleLogger("[checkptr]");
  #abortControllers = new Map<string, AbortController>();
  #failedCheckpoints = new Map<string, unknown>();
  #waitingForRetry = new Set<string>();

  constructor(private opts = { forceSimulate: false }) {}

  async initialize(): Promise<CheckpointerInitializeReturn> {
    if (this.#initialized) {
      return this.#getInitializeReturn();
    }

    this.#logger.log(`${this.#dockerMode ? "Docker" : "Kubernetes"} mode`);

    if (this.#dockerMode) {
      try {
        await $`criu --version`;
      } catch (error) {
        this.#logger.error("No checkpoint support: Missing CRIU binary");
        this.#logger.error("Will simulate instead");
        this.#canCheckpoint = false;
        this.#initialized = true;

        return this.#getInitializeReturn();
      }

      try {
        await $`docker checkpoint`;
      } catch (error) {
        this.#logger.error(
          "No checkpoint support: Docker needs to have experimental features enabled"
        );
        this.#logger.error("Will simulate instead");
        this.#canCheckpoint = false;
        this.#initialized = true;

        return this.#getInitializeReturn();
      }
    } else {
      try {
        await $`buildah login --get-login ${REGISTRY_HOST}`;
      } catch (error) {
        this.#logger.error(`No checkpoint support: Not logged in to registry ${REGISTRY_HOST}`);
        this.#canCheckpoint = false;
        this.#initialized = true;

        return this.#getInitializeReturn();
      }
    }

    this.#logger.log(
      `Full checkpoint support${
        this.#dockerMode && this.opts.forceSimulate ? " with forced simulation enabled." : "!"
      }`
    );

    this.#initialized = true;
    this.#canCheckpoint = true;

    return this.#getInitializeReturn();
  }

  #getInitializeReturn(): CheckpointerInitializeReturn {
    return {
      canCheckpoint: this.#canCheckpoint,
      willSimulate: this.#dockerMode && (!this.#canCheckpoint || this.opts.forceSimulate),
    };
  }

  #getImageRef(projectRef: string, deploymentVersion: string, shortCode: string) {
    return `${REGISTRY_HOST}/trigger/${projectRef}:${deploymentVersion}.prod-${shortCode}`;
  }

  #getExportLocation(projectRef: string, deploymentVersion: string, shortCode: string) {
    const basename = `${projectRef}-${deploymentVersion}-${shortCode}`;

    if (this.#dockerMode) {
      return basename;
    } else {
      return `${CHECKPOINT_PATH}/${basename}.tar`;
    }
  }

  async checkpointAndPush(opts: CheckpointAndPushOptions): Promise<CheckpointData | undefined> {
    const start = performance.now();
    logger.log(`checkpointAndPush() start`, { start, opts });

    const result = await this.#checkpointAndPushWithBackoff(opts);

    const end = performance.now();
    logger.log(`checkpointAndPush() end`, {
      start,
      end,
      diff: end - start,
      opts,
      success: result.success,
    });

    if (!result.success) {
      return;
    }

    return result.checkpoint;
  }

  isCheckpointing(runId: string) {
    return this.#abortControllers.has(runId) || this.#waitingForRetry.has(runId);
  }

  cancelCheckpoint(runId: string): boolean {
    // If the last checkpoint failed, pretend we canceled it
    // This ensures tasks don't wait for external resume messages to continue
    if (this.#hasFailedCheckpoint(runId)) {
      this.#clearFailedCheckpoint(runId);
      return true;
    }

    if (this.#waitingForRetry.has(runId)) {
      this.#waitingForRetry.delete(runId);
      return true;
    }

    const controller = this.#abortControllers.get(runId);

    if (!controller) {
      logger.debug("Nothing to cancel", { runId });
      return false;
    }

    controller.abort("cancelCheckpointing()");
    this.#abortControllers.delete(runId);

    return true;
  }

  async #checkpointAndPushWithBackoff({
    runId,
    leaveRunning = true, // This mirrors kubernetes behaviour more accurately
    projectRef,
    deploymentVersion,
  }: CheckpointAndPushOptions): Promise<CheckpointAndPushResult> {
    this.#logger.log("Checkpointing with backoff", {
      runId,
      leaveRunning,
      projectRef,
      deploymentVersion,
    });

    const backoff = new ExponentialBackoff()
      .type("EqualJitter")
      .base(3)
      .max(3 * 3600)
      .maxElapsed(48 * 3600);

    for await (const { delay, retry } of backoff) {
      try {
        if (retry > 0) {
          this.#logger.error("Retrying checkpoint", {
            runId,
            retry,
            delay,
          });

          this.#waitingForRetry.add(runId);
          await new Promise((resolve) => setTimeout(resolve, delay.milliseconds));

          if (!this.#waitingForRetry.has(runId)) {
            this.#logger.log("Checkpoint canceled while waiting for retry", { runId });
            return { success: false, reason: "CANCELED" };
          } else {
            this.#waitingForRetry.delete(runId);
          }
        }

        const result = await this.#checkpointAndPush({
          runId,
          leaveRunning,
          projectRef,
          deploymentVersion,
        });

        if (result.success) {
          return result;
        }

        if (result.reason === "CANCELED") {
          this.#logger.log("Checkpoint canceled, won't retry", { runId });
          // Don't fail the checkpoint, as it was canceled
          return result;
        }

        if (result.reason === "IN_PROGRESS") {
          this.#logger.log("Checkpoint already in progress, won't retry", { runId });
          this.#failCheckpoint(runId, result.reason);
          return result;
        }

        if (result.reason === "NO_SUPPORT") {
          this.#logger.log("No checkpoint support, won't retry", { runId });
          this.#failCheckpoint(runId, result.reason);
          return result;
        }

        if (result.reason === "DISABLED") {
          this.#logger.log("Checkpoint support disabled, won't retry", { runId });
          this.#failCheckpoint(runId, result.reason);
          return result;
        }

        continue;
      } catch (error) {
        this.#logger.error("Checkpoint error", {
          retry,
          runId,
          delay,
          error: error instanceof Error ? error.message : error,
        });
      }
    }

    this.#logger.error(`Checkpoint failed after exponential backoff`, {
      runId,
      leaveRunning,
      projectRef,
      deploymentVersion,
    });
    this.#failCheckpoint(runId, "ERROR");

    return { success: false, reason: "ERROR" };
  }

  async #checkpointAndPush({
    runId,
    leaveRunning = true, // This mirrors kubernetes behaviour more accurately
    projectRef,
    deploymentVersion,
  }: CheckpointAndPushOptions): Promise<CheckpointAndPushResult> {
    await this.initialize();

    const options = {
      runId,
      leaveRunning,
      projectRef,
      deploymentVersion,
    };

    if (!this.#dockerMode && !this.#canCheckpoint) {
      this.#logger.error("No checkpoint support. Simulation requires docker.");
      return { success: false, reason: "NO_SUPPORT" };
    }

    if (this.#abortControllers.has(runId)) {
      logger.error("Checkpoint procedure already in progress", { options });
      return { success: false, reason: "IN_PROGRESS" };
    }

    // This is a new checkpoint, clear any last failure for this run
    this.#clearFailedCheckpoint(runId);

    if (DISABLE_CHECKPOINT_SUPPORT) {
      this.#logger.error("Checkpoint support disabled", { options });
      return { success: false, reason: "DISABLED" };
    }

    const controller = new AbortController();
    this.#abortControllers.set(runId, controller);

    const $$ = $({ signal: controller.signal });

    const shortCode = nanoid(8);
    const imageRef = this.#getImageRef(projectRef, deploymentVersion, shortCode);
    const exportLocation = this.#getExportLocation(projectRef, deploymentVersion, shortCode);

    const cleanup = async () => {
      if (this.#dockerMode) {
        return;
      }

      try {
        await $`rm ${exportLocation}`;
        this.#logger.log("Deleted checkpoint archive", { exportLocation });

        await $`buildah rmi ${imageRef}`;
        this.#logger.log("Deleted checkpoint image", { imageRef });
      } catch (error) {
        this.#logger.error("Failure during checkpoint cleanup", { exportLocation, error });
      }
    };

    try {
      if (CHAOS_MONKEY_ENABLED) {
        console.log("🍌 Chaos monkey wreaking havoc");

        const random = Math.random();

        if (random < 0.33) {
          // Fake long checkpoint duration
          await $$`sleep 300`;
        } else if (random < 0.66) {
          // Fake checkpoint error
          await $$`false`;
        } else {
          // no-op
        }
      }

      this.#logger.log("Checkpointing:", { options });

      const containterName = this.#getRunContainerName(runId);

      // Create checkpoint (docker)
      if (this.#dockerMode) {
        try {
          if (this.opts.forceSimulate || !this.#canCheckpoint) {
            this.#logger.log("Simulating checkpoint");
            this.#logger.debug(await $$`docker pause ${containterName}`);
          } else {
            if (SIMULATE_CHECKPOINT_FAILURE) {
              if (performance.now() < SIMULATE_CHECKPOINT_FAILURE_SECONDS * 1000) {
                this.#logger.error("Simulating checkpoint failure", { options });
                throw new Error("SIMULATE_CHECKPOINT_FAILURE");
              }
            }

            if (leaveRunning) {
              this.#logger.debug(
                await $$`docker checkpoint create --leave-running ${containterName} ${exportLocation}`
              );
            } else {
              this.#logger.debug(
                await $$`docker checkpoint create ${containterName} ${exportLocation}`
              );
            }
          }
        } catch (error) {
          this.#logger.error("Failed while creating docker checkpoint", { exportLocation });
          throw error;
        }

        this.#logger.log("checkpoint created:", {
          runId,
          location: exportLocation,
        });

        return {
          success: true,
          checkpoint: {
            location: exportLocation,
            docker: true,
          },
        };
      }

      // Create checkpoint (CRI)
      if (!this.#canCheckpoint) {
        throw new Error("No checkpoint support in kubernetes mode.");
      }

      const containerId = this.#logger.debug(
        // @ts-expect-error
        await $$`crictl ps`
          .pipeStdout($$({ stdin: "pipe" })`grep ${containterName}`)
          .pipeStdout($$({ stdin: "pipe" })`cut -f1 ${"-d "}`)
      );

      if (!containerId.stdout) {
        throw new Error("could not find container id");
      }

      const start = performance.now();

      if (SIMULATE_CHECKPOINT_FAILURE) {
        if (performance.now() < SIMULATE_CHECKPOINT_FAILURE_SECONDS * 1000) {
          this.#logger.error("Simulating checkpoint failure", { options });
          throw new Error("SIMULATE_CHECKPOINT_FAILURE");
        }
      }

      // Create checkpoint
      this.#logger.debug(await $$`crictl checkpoint --export=${exportLocation} ${containerId}`);
      const postCheckpoint = performance.now();

      // Print checkpoint size
      const size = await getParsedFileSize(exportLocation);
      this.#logger.log("checkpoint archive created", { size, options });

      // Create image from checkpoint
      const container = this.#logger.debug(await $$`buildah from scratch`);
      const postFrom = performance.now();

      this.#logger.debug(await $$`buildah add ${container} ${exportLocation} /`);
      const postAdd = performance.now();

      this.#logger.debug(
        await $$`buildah config --annotation=io.kubernetes.cri-o.annotations.checkpoint.name=counter ${container}`
      );
      const postConfig = performance.now();

      this.#logger.debug(await $$`buildah commit ${container} ${imageRef}`);
      const postCommit = performance.now();

      this.#logger.debug(await $$`buildah rm ${container}`);
      const postRm = performance.now();

      if (SIMULATE_PUSH_FAILURE) {
        if (performance.now() < SIMULATE_PUSH_FAILURE_SECONDS * 1000) {
          this.#logger.error("Simulating push failure", { options });
          throw new Error("SIMULATE_PUSH_FAILURE");
        }
      }

      // Push checkpoint image
      this.#logger.debug(await $$`buildah push --tls-verify=${REGISTRY_TLS_VERIFY} ${imageRef}`);
      const postPush = performance.now();

      const perf = {
        "crictl checkpoint": postCheckpoint - start,
        "buildah from": postFrom - postCheckpoint,
        "buildah add": postAdd - postFrom,
        "buildah config": postConfig - postAdd,
        "buildah commit": postCommit - postConfig,
        "buildah rm": postRm - postCommit,
        "buildah push": postPush - postRm,
      };

      this.#logger.log("Checkpointed and pushed image to:", { location: imageRef, perf });

      return {
        success: true,
        checkpoint: {
          location: imageRef,
          docker: false,
        },
      };
    } catch (error) {
      if (isExecaChildProcess(error)) {
        if (error.isCanceled) {
          this.#logger.error("Checkpoint canceled", { options, error });

          return { success: false, reason: "CANCELED" };
        }

        this.#logger.error("Checkpoint command error", { options, error });

        return { success: false, reason: "ERROR" };
      }

      this.#logger.error("Unhandled checkpoint error", { options, error });

      return { success: false, reason: "ERROR" };
    } finally {
      this.#abortControllers.delete(runId);
      await cleanup();
    }
  }

  #failCheckpoint(runId: string, error: unknown) {
    this.#failedCheckpoints.set(runId, error);
  }

  #clearFailedCheckpoint(runId: string) {
    this.#failedCheckpoints.delete(runId);
  }

  #hasFailedCheckpoint(runId: string) {
    return this.#failedCheckpoints.has(runId);
  }

  #getRunContainerName(suffix: string) {
    return `task-run-${suffix}`;
  }
}

class TaskCoordinator {
  #httpServer: ReturnType<typeof createServer>;
  #checkpointer = new Checkpointer({ forceSimulate: FORCE_CHECKPOINT_SIMULATION });

  #prodWorkerNamespace: ZodNamespace<
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

  #delayThresholdInMs: number;

  constructor(
    private port: number,
    private host = "0.0.0.0"
  ) {
    this.#httpServer = this.#createHttpServer();
    this.#checkpointer.initialize();
    this.#delayThresholdInMs = this.#getDelayThreshold();

    if (process.env.DELAY_THRESHOLD_IN_MS) {
      this.#delayThresholdInMs = this.#getDelayThreshold();
    }

    const io = new Server(this.#httpServer);
    this.#prodWorkerNamespace = this.#createProdWorkerNamespace(io);

    this.#platformSocket = this.#createPlatformSocket();

    const connectedTasksTotal = new Gauge({
      name: "daemon_connected_tasks_total", // don't change this without updating dashboard config
      help: "The number of tasks currently connected.",
      collect: () => {
        connectedTasksTotal.set(this.#prodWorkerNamespace.namespace.sockets.size);
      },
    });
    register.registerMetric(connectedTasksTotal);
  }

  #getDelayThreshold() {
    if (!process.env.RETRY_DELAY_THRESHOLD_IN_MS) {
      return DEFAULT_RETRY_DELAY_THRESHOLD_IN_MS;
    }

    const threshold = parseInt(process.env.RETRY_DELAY_THRESHOLD_IN_MS);

    if (isNaN(threshold)) {
      logger.log(
        "RETRY_DELAY_THRESHOLD_IN_MS parses as NaN, must supply integer. Will use default instead.",
        {
          RETRY_DELAY_THRESHOLD_IN_MS: process.env.RETRY_DELAY_THRESHOLD_IN_MS,
          DEFAULT_DELAY_THRESHOLD_IN_MS: DEFAULT_RETRY_DELAY_THRESHOLD_IN_MS,
        }
      );
      return DEFAULT_RETRY_DELAY_THRESHOLD_IN_MS;
    }

    return threshold;
  }

  #createPlatformSocket() {
    if (!PLATFORM_ENABLED) {
      console.log("INFO: platform connection disabled");
      return;
    }

    const platformConnection = new ZodSocketConnection({
      namespace: "coordinator",
      host: PLATFORM_HOST,
      port: Number(PLATFORM_WS_PORT),
      secure: SECURE_CONNECTION,
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

          // In case the task resumed faster than we could checkpoint
          this.#cancelCheckpoint(message.runId);

          taskSocket.emit("RESUME_AFTER_DEPENDENCY", message);
        },
        RESUME_AFTER_DURATION: async (message) => {
          const taskSocket = await this.#getAttemptSocket(message.attemptFriendlyId);

          if (!taskSocket) {
            logger.log("Socket for attempt not found", {
              attemptFriendlyId: message.attemptFriendlyId,
            });
            return;
          }

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

          this.#checkpointer.cancelCheckpoint(message.runId);

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

          taskSocket.emit("READY_FOR_RETRY", message);
        },
      },
    });

    return platformConnection;
  }

  async #getRunSocket(runId: string) {
    const sockets = await this.#prodWorkerNamespace.fetchSockets();

    for (const socket of sockets) {
      if (socket.data.runId === runId) {
        return socket;
      }
    }
  }

  async #getAttemptSocket(attemptFriendlyId: string) {
    const sockets = await this.#prodWorkerNamespace.fetchSockets();

    for (const socket of sockets) {
      if (socket.data.attemptFriendlyId === attemptFriendlyId) {
        return socket;
      }
    }
  }

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

        const readyToCheckpoint = async (): Promise<
          { success: true } | { success: false; reason?: string }
        > => {
          if (checkpointInProgress()) {
            return {
              success: false,
              reason: "checkpoint in progress",
            };
          }

          const isCheckpointable = new Promise((resolve, reject) => {
            // We set a reasonable timeout to prevent waiting forever
            // TODO: We may also want to cancel the task as it's unlikely to recover
            setTimeout(() => reject("timeout"), 10_000);

            this.#checkpointableTasks.set(socket.data.runId, { resolve, reject });
          });

          try {
            await isCheckpointable;
            this.#checkpointableTasks.delete(socket.data.runId);

            return {
              success: true,
            };
          } catch (error) {
            logger.error("Error while waiting for checkpointable state", { error });

            return {
              success: false,
              reason: typeof error === "string" ? error : "unknown",
            };
          }
        };

        this.#platformSocket?.send("LOG", {
          metadata: socket.data,
          text: "connected",
        });

        socket.on("LOG", (message, callback) => {
          logger.log("[LOG]", message.text);

          callback();

          this.#platformSocket?.send("LOG", {
            version: "v1",
            metadata: socket.data,
            text: message.text,
          });
        });

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

            socket.data.attemptFriendlyId = executionAck.payload.execution.attempt.id;
          } catch (error) {
            logger.error("Error", { error });

            await crashRun({
              name: "ReadyForExecutionError",
              message:
                error instanceof Error ? `Unexpected error: ${error.message}` : "Unexpected error",
            });

            return;
          }
        });

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

            socket.emit("EXECUTE_TASK_RUN_LAZY_ATTEMPT", {
              version: "v1",
              lazyPayload: lazyAttempt.lazyPayload,
            });
          } catch (error) {
            logger.error("Error", { error });

            await crashRun({
              name: "ReadyForLazyAttemptError",
              message:
                error instanceof Error ? `Unexpected error: ${error.message}` : "Unexpected error",
            });

            return;
          }
        });

        socket.on("READY_FOR_RESUME", async (message) => {
          logger.log("[READY_FOR_RESUME]", message);

          socket.data.attemptFriendlyId = message.attemptFriendlyId;
          this.#platformSocket?.send("READY_FOR_RESUME", message);
        });

        socket.on("TASK_RUN_COMPLETED", async ({ completion, execution }, callback) => {
          logger.log("completed task", { completionId: completion.id });

          const completeWithoutCheckpoint = (shouldExit: boolean) => {
            this.#platformSocket?.send("TASK_RUN_COMPLETED", {
              version: "v1",
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
            return;
          }

          const { canCheckpoint, willSimulate } = await this.#checkpointer.initialize();

          const willCheckpointAndRestore = canCheckpoint || willSimulate;

          if (!willCheckpointAndRestore) {
            completeWithoutCheckpoint(false);
            return;
          }

          // The worker will then put itself in a checkpointable state
          callback({ willCheckpointAndRestore: true, shouldExit: false });

          const ready = await readyToCheckpoint();

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

        socket.on("TASK_RUN_FAILED_TO_RUN", async ({ completion }) => {
          logger.log("completed task", { completionId: completion.id });

          this.#platformSocket?.send("TASK_RUN_FAILED_TO_RUN", {
            version: "v1",
            completion,
          });

          socket.emit("REQUEST_EXIT", {
            version: "v1",
          });
        });

        socket.on("READY_FOR_CHECKPOINT", async (message) => {
          logger.log("[READY_FOR_CHECKPOINT]", message);

          const checkpointable = this.#checkpointableTasks.get(socket.data.runId);

          if (!checkpointable) {
            logger.error("No checkpoint scheduled", { runId: socket.data.runId });
            return;
          }

          checkpointable.resolve();
        });

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

        socket.on("WAIT_FOR_DURATION", async (message, callback) => {
          logger.log("[WAIT_FOR_DURATION]", message);

          if (checkpointInProgress()) {
            logger.error("Checkpoint already in progress", { runId: socket.data.runId });
            callback({ willCheckpointAndRestore: false });
            return;
          }

          const { canCheckpoint, willSimulate } = await this.#checkpointer.initialize();

          const willCheckpointAndRestore = canCheckpoint || willSimulate;

          callback({ willCheckpointAndRestore });

          if (!willCheckpointAndRestore) {
            return;
          }

          const ready = await readyToCheckpoint();

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
          });

          if (!checkpoint) {
            // The task container will keep running until the wait duration has elapsed
            logger.error("Failed to checkpoint", { runId: socket.data.runId });
            return;
          }

          if (!checkpoint.docker || !willSimulate) {
            socket.emit("REQUEST_EXIT", {
              version: "v1",
            });
          }

          this.#platformSocket?.send("CHECKPOINT_CREATED", {
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
        });

        socket.on("WAIT_FOR_TASK", async (message, callback) => {
          logger.log("[WAIT_FOR_TASK]", message);

          const { canCheckpoint, willSimulate } = await this.#checkpointer.initialize();

          const willCheckpointAndRestore = canCheckpoint || willSimulate;

          callback({ willCheckpointAndRestore });

          if (!willCheckpointAndRestore) {
            return;
          }

          const checkpoint = await this.#checkpointer.checkpointAndPush({
            runId: socket.data.runId,
            projectRef: socket.data.projectRef,
            deploymentVersion: socket.data.deploymentVersion,
          });

          if (!checkpoint) {
            logger.error("Failed to checkpoint", { runId: socket.data.runId });
            return;
          }

          if (!checkpoint.docker || !willSimulate) {
            socket.emit("REQUEST_EXIT", {
              version: "v1",
            });
          }

          this.#platformSocket?.send("CHECKPOINT_CREATED", {
            version: "v1",
            attemptFriendlyId: message.attemptFriendlyId,
            docker: checkpoint.docker,
            location: checkpoint.location,
            reason: {
              type: "WAIT_FOR_TASK",
              friendlyId: message.friendlyId,
            },
          });
        });

        socket.on("WAIT_FOR_BATCH", async (message, callback) => {
          logger.log("[WAIT_FOR_BATCH]", message);

          const { canCheckpoint, willSimulate } = await this.#checkpointer.initialize();

          const willCheckpointAndRestore = canCheckpoint || willSimulate;

          callback({ willCheckpointAndRestore });

          if (!willCheckpointAndRestore) {
            return;
          }

          const checkpoint = await this.#checkpointer.checkpointAndPush({
            runId: socket.data.runId,
            projectRef: socket.data.projectRef,
            deploymentVersion: socket.data.deploymentVersion,
          });

          if (!checkpoint) {
            logger.error("Failed to checkpoint", { runId: socket.data.runId });
            return;
          }

          if (!checkpoint.docker || !willSimulate) {
            socket.emit("REQUEST_EXIT", {
              version: "v1",
            });
          }

          this.#platformSocket?.send("CHECKPOINT_CREATED", {
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
        });

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

        socket.on("INDEXING_FAILED", async (message) => {
          logger.log("[INDEXING_FAILED]", message);

          this.#platformSocket?.send("INDEXING_FAILED", {
            version: "v1",
            deploymentId: message.deploymentId,
            error: message.error,
          });
        });

        socket.on("CREATE_TASK_RUN_ATTEMPT", async (message, callback) => {
          logger.log("[CREATE_TASK_RUN_ATTEMPT]", message);

          const createAttempt = await this.#platformSocket?.sendWithAck("CREATE_TASK_RUN_ATTEMPT", {
            runId: message.runId,
            envId: socket.data.envId,
          });

          if (!createAttempt?.success) {
            logger.debug("no ack while creating attempt", message);
            callback({ success: false });
            return;
          }

          socket.data.attemptFriendlyId = createAttempt.executionPayload.execution.attempt.id;

          callback({
            success: true,
            executionPayload: createAttempt.executionPayload,
          });
        });

        socket.on("UNRECOVERABLE_ERROR", async (message) => {
          logger.log("[UNRECOVERABLE_ERROR]", message);

          await crashRun(message.error);
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
          this.#platformSocket?.send("TASK_RUN_HEARTBEAT", message);
        },
      },
    });

    return provider;
  }

  #cancelCheckpoint(runId: string): boolean {
    const checkpointWait = this.#checkpointableTasks.get(runId);

    if (checkpointWait) {
      // Stop waiting for task to reach checkpointable state
      checkpointWait.reject("Checkpoint cancelled");
    }

    // Cancel checkpointing procedure
    const checkpointCanceled = this.#checkpointer.cancelCheckpoint(runId);

    logger.log("cancelCheckpoint()", { runId, checkpointCanceled });

    return checkpointCanceled;
  }

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
