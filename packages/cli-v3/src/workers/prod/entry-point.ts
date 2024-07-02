import {
  Config,
  CoordinatorToProdWorkerMessages,
  PostStartCauses,
  PreStopCauses,
  ProdWorkerToCoordinatorMessages,
  TaskResource,
  TaskRunErrorCodes,
  TaskRunFailedExecutionResult,
  WaitReason,
} from "@trigger.dev/core/v3";
import { InferSocketMessageSchema, ZodSocketConnection } from "@trigger.dev/core/v3/zodSocket";
import { HttpReply, getRandomPortNumber } from "@trigger.dev/core-apps/http";
import { SimpleLogger } from "@trigger.dev/core-apps/logger";
import { EXIT_CODE_ALREADY_HANDLED, EXIT_CODE_CHILD_NONZERO } from "@trigger.dev/core-apps/process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { ProdBackgroundWorker } from "./backgroundWorker";
import { TaskMetadataParseError, UncaughtExceptionError } from "../common/errors";
import { setTimeout } from "node:timers/promises";

declare const __PROJECT_CONFIG__: Config;

const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || getRandomPortNumber());
const COORDINATOR_HOST = process.env.COORDINATOR_HOST || "127.0.0.1";
const COORDINATOR_PORT = Number(process.env.COORDINATOR_PORT || 50080);
const MACHINE_NAME = process.env.MACHINE_NAME || "local";
const POD_NAME = process.env.POD_NAME || "some-pod";
const SHORT_HASH = process.env.TRIGGER_CONTENT_HASH!.slice(0, 9);

const logger = new SimpleLogger(`[${MACHINE_NAME}][${SHORT_HASH}]`);

class ProdWorker {
  private apiUrl = process.env.TRIGGER_API_URL!;
  private apiKey = process.env.TRIGGER_SECRET_KEY!;
  private contentHash = process.env.TRIGGER_CONTENT_HASH!;
  private projectRef = process.env.TRIGGER_PROJECT_REF!;
  private envId = process.env.TRIGGER_ENV_ID!;
  private runId = process.env.TRIGGER_RUN_ID || "index-only";
  private deploymentId = process.env.TRIGGER_DEPLOYMENT_ID!;
  private deploymentVersion = process.env.TRIGGER_DEPLOYMENT_VERSION!;
  private runningInKubernetes = !!process.env.KUBERNETES_PORT;

  private executing = false;
  private completed = new Set<string>();
  private paused = false;
  private attemptFriendlyId?: string;

  private nextResumeAfter?: WaitReason;
  private waitForPostStart = false;

  #httpPort: number;
  #backgroundWorker: ProdBackgroundWorker;
  #httpServer: ReturnType<typeof createServer>;
  #coordinatorSocket: ZodSocketConnection<
    typeof ProdWorkerToCoordinatorMessages,
    typeof CoordinatorToProdWorkerMessages
  >;

  constructor(
    port: number,
    private host = "0.0.0.0"
  ) {
    process.on("SIGTERM", this.#handleSignal.bind(this, "SIGTERM"));

    this.#coordinatorSocket = this.#createCoordinatorSocket(COORDINATOR_HOST);
    this.#backgroundWorker = this.#createBackgroundWorker();

    this.#httpPort = port;
    this.#httpServer = this.#createHttpServer();
  }

  async #handleSignal(signal: NodeJS.Signals) {
    logger.log("Received signal", { signal });

    if (signal === "SIGTERM") {
      let gracefulExitTimeoutElapsed = false;

      if (this.executing) {
        const terminationGracePeriodSeconds = 60 * 60;

        logger.log("Waiting for attempt to complete before exiting", {
          terminationGracePeriodSeconds,
        });

        // Wait for termination grace period minus 5s to give cleanup a chance to complete
        await setTimeout(terminationGracePeriodSeconds * 1000 - 5000);
        gracefulExitTimeoutElapsed = true;

        logger.log("Termination timeout reached, exiting gracefully.");
      } else {
        logger.log("Not executing, exiting immediately.");
      }

      await this.#exitGracefully(gracefulExitTimeoutElapsed);
      return;
    }

    logger.log("Unhandled signal", { signal });
  }

  async #exitGracefully(gracefulExitTimeoutElapsed = false, exitCode = 0) {
    await this.#backgroundWorker.close(gracefulExitTimeoutElapsed);

    if (!gracefulExitTimeoutElapsed) {
      // TODO: Maybe add a sensible timeout instead of a conditional to avoid zombies
      process.exit(exitCode);
    }
  }

  async #reconnect(isPostStart = false, reconnectImmediately = false) {
    if (isPostStart) {
      this.waitForPostStart = false;
    }

    this.#coordinatorSocket.close();

    if (!reconnectImmediately) {
      await setTimeout(1000);
    }

    let coordinatorHost = COORDINATOR_HOST;

    try {
      if (this.runningInKubernetes) {
        coordinatorHost = (await readFile("/etc/taskinfo/coordinator-host", "utf-8")).replace(
          "\n",
          ""
        );

        logger.log("reconnecting", {
          coordinatorHost: {
            fromEnv: COORDINATOR_HOST,
            fromVolume: coordinatorHost,
            current: this.#coordinatorSocket.socket.io.opts.hostname,
          },
        });
      }
    } catch (error) {
      logger.error("taskinfo read error during reconnect", {
        error: error instanceof Error ? error.message : error,
      });
    } finally {
      this.#coordinatorSocket = this.#createCoordinatorSocket(coordinatorHost);
    }
  }

  #createBackgroundWorker() {
    const backgroundWorker = new ProdBackgroundWorker("worker.js", {
      projectConfig: __PROJECT_CONFIG__,
      env: {
        ...gatherProcessEnv(),
        TRIGGER_API_URL: this.apiUrl,
        TRIGGER_SECRET_KEY: this.apiKey,
        OTEL_EXPORTER_OTLP_ENDPOINT:
          process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
      },
      contentHash: this.contentHash,
    });

    backgroundWorker.onTaskHeartbeat.attach((attemptFriendlyId) => {
      // TODO: Switch to .send() once coordinator uses zod handler for all messages
      this.#coordinatorSocket.socket.emit("TASK_HEARTBEAT", { version: "v1", attemptFriendlyId });
    });

    backgroundWorker.onTaskRunHeartbeat.attach((runId) => {
      this.#coordinatorSocket.socket.emit("TASK_RUN_HEARTBEAT", { version: "v1", runId });
    });

    // Currently, this is only used for duration waits
    backgroundWorker.onReadyForCheckpoint.attach(async (message) => {
      await this.#prepareForCheckpoint();

      this.#coordinatorSocket.socket.emit("READY_FOR_CHECKPOINT", { version: "v1" });
    });

    // Currently, this is only used for duration waits. Might need adjusting for other use cases.
    backgroundWorker.onCancelCheckpoint.attach(async (message) => {
      logger.log("onCancelCheckpoint", { message });

      const { checkpointCanceled } = await this.#coordinatorSocket.socket.emitWithAck(
        "CANCEL_CHECKPOINT",
        {
          version: "v2",
          reason: message.reason,
        }
      );

      logger.log("onCancelCheckpoint coordinator response", { checkpointCanceled });

      if (checkpointCanceled) {
        if (message.reason === "WAIT_FOR_DURATION") {
          // Worker will resume immediately
          this.paused = false;
          this.nextResumeAfter = undefined;
          this.waitForPostStart = false;
        }
      }

      backgroundWorker.checkpointCanceledNotification.post({ checkpointCanceled });
    });

    backgroundWorker.onCreateTaskRunAttempt.attach(async (message) => {
      logger.log("onCreateTaskRunAttempt()", { message });

      const createAttempt = await this.#coordinatorSocket.socket.emitWithAck(
        "CREATE_TASK_RUN_ATTEMPT",
        {
          version: "v1",
          runId: message.runId,
        }
      );

      if (!createAttempt.success) {
        backgroundWorker.attemptCreatedNotification.post({
          success: false,
          reason: createAttempt.reason,
        });
        return;
      }

      backgroundWorker.attemptCreatedNotification.post({
        success: true,
        execution: createAttempt.executionPayload.execution,
      });
    });

    backgroundWorker.attemptCreatedNotification.attach((message) => {
      if (!message.success) {
        return;
      }

      // Workers with lazy attempt support set their friendly ID here
      this.attemptFriendlyId = message.execution.attempt.id;
    });

    backgroundWorker.onWaitForDuration.attach(async (message) => {
      if (!this.attemptFriendlyId) {
        logger.error("Failed to send wait message, attempt friendly ID not set", { message });

        this.#emitUnrecoverableError(
          "NoAttemptId",
          "Attempt ID not set before waiting for duration"
        );

        return;
      }

      const { willCheckpointAndRestore } = await this.#coordinatorSocket.socket.emitWithAck(
        "WAIT_FOR_DURATION",
        {
          ...message,
          attemptFriendlyId: this.attemptFriendlyId,
        }
      );

      this.#prepareForWait("WAIT_FOR_DURATION", willCheckpointAndRestore);
    });

    backgroundWorker.onWaitForTask.attach(async (message) => {
      if (!this.attemptFriendlyId) {
        logger.error("Failed to send wait message, attempt friendly ID not set", { message });

        this.#emitUnrecoverableError("NoAttemptId", "Attempt ID not set before waiting for task");

        return;
      }

      const { willCheckpointAndRestore } = await this.#coordinatorSocket.socket.emitWithAck(
        "WAIT_FOR_TASK",
        {
          ...message,
          attemptFriendlyId: this.attemptFriendlyId,
        }
      );

      this.#prepareForWait("WAIT_FOR_TASK", willCheckpointAndRestore);
    });

    backgroundWorker.onWaitForBatch.attach(async (message) => {
      if (!this.attemptFriendlyId) {
        logger.error("Failed to send wait message, attempt friendly ID not set", { message });

        this.#emitUnrecoverableError("NoAttemptId", "Attempt ID not set before waiting for batch");

        return;
      }

      const { willCheckpointAndRestore } = await this.#coordinatorSocket.socket.emitWithAck(
        "WAIT_FOR_BATCH",
        {
          ...message,
          attemptFriendlyId: this.attemptFriendlyId,
        }
      );

      this.#prepareForWait("WAIT_FOR_BATCH", willCheckpointAndRestore);
    });

    return backgroundWorker;
  }

  async #prepareForWait(reason: WaitReason, willCheckpointAndRestore: boolean) {
    logger.log(`prepare for ${reason}`, { willCheckpointAndRestore });

    this.#backgroundWorker.preCheckpointNotification.post({ willCheckpointAndRestore });

    if (willCheckpointAndRestore) {
      this.paused = true;
      this.nextResumeAfter = reason;
      this.waitForPostStart = true;

      if (reason === "WAIT_FOR_TASK" || reason === "WAIT_FOR_BATCH") {
        // Duration waits do this via the "ready for checkpoint" event instead
        await this.#prepareForCheckpoint();
      }
    }
  }

  async #prepareForRetry(
    willCheckpointAndRestore: boolean,
    shouldExit: boolean,
    exitCode?: number
  ) {
    logger.log("prepare for retry", { willCheckpointAndRestore, shouldExit });

    // Graceful shutdown on final attempt
    if (shouldExit) {
      if (willCheckpointAndRestore) {
        logger.log("WARNING: Will checkpoint but also requested exit. This won't end well.");
      }

      await this.#exitGracefully(false, exitCode);
      return;
    }

    // Clear state for next execution
    this.paused = false;
    this.waitForPostStart = false;
    this.executing = false;
    this.attemptFriendlyId = undefined;

    if (willCheckpointAndRestore) {
      this.waitForPostStart = true;

      // We already flush after completion, so we don't need to do it here
      this.#prepareForCheckpoint(false);

      this.#coordinatorSocket.socket.emit("READY_FOR_CHECKPOINT", { version: "v1" });
      return;
    }
  }

  async #prepareForCheckpoint(flush = true) {
    if (flush) {
      // Flush before checkpointing so we don't flush the same spans again after restore
      await this.#backgroundWorker.flushTelemetry();
    }

    // Kill the previous worker process to prevent large checkpoints
    await this.#backgroundWorker.forceKillOldTaskRunProcesses();
  }

  #resumeAfterDuration() {
    this.paused = false;
    this.nextResumeAfter = undefined;
    this.waitForPostStart = false;

    this.#backgroundWorker.waitCompletedNotification();
  }

  #returnValidatedExtraHeaders(headers: Record<string, string>) {
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) {
        throw new Error(`Extra header is undefined: ${key}`);
      }
    }

    return headers;
  }

  // FIXME: If the the worker can't connect for a while, this runs MANY times - it should only run once
  #createCoordinatorSocket(host: string) {
    const extraHeaders = this.#returnValidatedExtraHeaders({
      "x-machine-name": MACHINE_NAME,
      "x-pod-name": POD_NAME,
      "x-trigger-content-hash": this.contentHash,
      "x-trigger-project-ref": this.projectRef,
      "x-trigger-env-id": this.envId,
      "x-trigger-deployment-id": this.deploymentId,
      "x-trigger-run-id": this.runId,
      "x-trigger-deployment-version": this.deploymentVersion,
    });

    if (this.attemptFriendlyId) {
      extraHeaders["x-trigger-attempt-friendly-id"] = this.attemptFriendlyId;
    }

    logger.log(`connecting to coordinator: ${host}:${COORDINATOR_PORT}`);
    logger.debug(`connecting with extra headers`, { extraHeaders });

    const coordinatorConnection = new ZodSocketConnection({
      namespace: "prod-worker",
      host,
      port: COORDINATOR_PORT,
      clientMessages: ProdWorkerToCoordinatorMessages,
      serverMessages: CoordinatorToProdWorkerMessages,
      extraHeaders,
      handlers: {
        RESUME_AFTER_DEPENDENCY: async ({ completions }) => {
          if (!this.paused) {
            logger.error("Failed to resume after dependency: Worker not paused");
            return;
          }

          if (completions.length === 0) {
            logger.error("Failed to resume after dependency: No completions");
            return;
          }

          if (
            this.nextResumeAfter !== "WAIT_FOR_TASK" &&
            this.nextResumeAfter !== "WAIT_FOR_BATCH"
          ) {
            logger.error("Failed to resume after dependency: Invalid next resume", {
              nextResumeAfter: this.nextResumeAfter,
            });
            return;
          }

          if (this.nextResumeAfter === "WAIT_FOR_TASK" && completions.length > 1) {
            logger.error(
              "Failed to resume after dependency: Waiting for single task but got multiple completions",
              {
                completions: completions,
              }
            );
            return;
          }

          this.paused = false;
          this.nextResumeAfter = undefined;
          this.waitForPostStart = false;

          for (let i = 0; i < completions.length; i++) {
            const completion = completions[i];

            if (!completion) continue;

            this.#backgroundWorker.taskRunCompletedNotification(completion);
          }
        },
        RESUME_AFTER_DURATION: async (message) => {
          if (!this.paused) {
            logger.error("worker not paused", {
              attemptId: message.attemptId,
            });
            return;
          }

          if (this.nextResumeAfter !== "WAIT_FOR_DURATION") {
            logger.error("not waiting to resume after duration", {
              nextResumeAfter: this.nextResumeAfter,
            });
            return;
          }

          this.#resumeAfterDuration();
        },
        EXECUTE_TASK_RUN: async ({ executionPayload }) => {
          if (this.executing) {
            logger.error("dropping execute request, already executing");
            return;
          }

          if (this.completed.has(executionPayload.execution.attempt.id)) {
            logger.error("dropping execute request, already completed");
            return;
          }

          this.executing = true;
          this.attemptFriendlyId = executionPayload.execution.attempt.id;
          const completion = await this.#backgroundWorker.executeTaskRun(executionPayload);

          logger.log("completed", completion);

          this.completed.add(executionPayload.execution.attempt.id);

          const { willCheckpointAndRestore, shouldExit } =
            await this.#coordinatorSocket.socket.emitWithAck("TASK_RUN_COMPLETED", {
              version: "v1",
              execution: executionPayload.execution,
              completion,
            });

          logger.log("completion acknowledged", { willCheckpointAndRestore, shouldExit });

          this.#prepareForRetry(willCheckpointAndRestore, shouldExit);
        },
        EXECUTE_TASK_RUN_LAZY_ATTEMPT: async (message) => {
          if (this.executing) {
            logger.error("dropping execute request, already executing");
            return;
          }

          this.executing = true;

          try {
            const { completion, execution } =
              await this.#backgroundWorker.executeTaskRunLazyAttempt(message.lazyPayload);

            logger.log("completed", completion);

            this.completed.add(execution.attempt.id);

            const { willCheckpointAndRestore, shouldExit } =
              await this.#coordinatorSocket.socket.emitWithAck("TASK_RUN_COMPLETED", {
                version: "v1",
                execution,
                completion,
              });

            logger.log("completion acknowledged", { willCheckpointAndRestore, shouldExit });

            const exitCode =
              !completion.ok &&
              completion.error.type === "INTERNAL_ERROR" &&
              completion.error.code === TaskRunErrorCodes.TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE
                ? EXIT_CODE_CHILD_NONZERO
                : 0;

            this.#prepareForRetry(willCheckpointAndRestore, shouldExit, exitCode);
          } catch (error) {
            const completion: TaskRunFailedExecutionResult = {
              ok: false,
              id: message.lazyPayload.runId,
              retry: undefined,
              error:
                error instanceof Error
                  ? {
                      type: "BUILT_IN_ERROR",
                      name: error.name,
                      message: error.message,
                      stackTrace: error.stack ?? "",
                    }
                  : {
                      type: "BUILT_IN_ERROR",
                      name: "UnknownError",
                      message: String(error),
                      stackTrace: "",
                    },
            };

            this.#coordinatorSocket.socket.emit("TASK_RUN_FAILED_TO_RUN", {
              version: "v1",
              completion,
            });
          }
        },
        REQUEST_ATTEMPT_CANCELLATION: async (message) => {
          if (!this.executing) {
            logger.log("dropping cancel request, not executing", { status: this.#status });
            return;
          }

          logger.log("cancelling attempt", { attemptId: message.attemptId, status: this.#status });

          await this.#backgroundWorker.cancelAttempt(message.attemptId);
        },
        REQUEST_EXIT: async (message) => {
          if (message.version === "v2" && message.delayInMs) {
            logger.log("exit requested with delay", { delayInMs: message.delayInMs });
            await setTimeout(message.delayInMs);
          }

          this.#coordinatorSocket.close();
          process.exit(0);
        },
        READY_FOR_RETRY: async (message) => {
          if (this.completed.size < 1) {
            return;
          }

          this.#coordinatorSocket.socket.emit("READY_FOR_LAZY_ATTEMPT", {
            version: "v1",
            runId: this.runId,
            totalCompletions: this.completed.size,
          });
        },
      },
      onConnection: async (socket, handler, sender, logger) => {
        logger.log("connected to coordinator", { status: this.#status });

        if (this.waitForPostStart) {
          logger.log("skip connection handler, waiting for post start hook");
          return;
        }

        if (this.paused) {
          if (!this.nextResumeAfter) {
            logger.error("Missing next resume reason", { status: this.#status });

            this.#emitUnrecoverableError(
              "NoNextResume",
              "Next resume reason not set while resuming from paused state"
            );

            return;
          }

          if (!this.attemptFriendlyId) {
            logger.error("Missing friendly ID", { status: this.#status });

            this.#emitUnrecoverableError(
              "NoAttemptId",
              "Attempt ID not set while resuming from paused state"
            );

            return;
          }

          socket.emit("READY_FOR_RESUME", {
            version: "v1",
            attemptFriendlyId: this.attemptFriendlyId,
            type: this.nextResumeAfter,
          });

          return;
        }

        if (process.env.INDEX_TASKS === "true") {
          const failIndex = (
            error: InferSocketMessageSchema<
              typeof ProdWorkerToCoordinatorMessages,
              "INDEXING_FAILED"
            >["error"]
          ) => {
            socket.emit("INDEXING_FAILED", {
              version: "v1",
              deploymentId: this.deploymentId,
              error,
            });
          };

          try {
            const taskResources = await this.#initializeWorker();

            const { success } = await socket.emitWithAck("INDEX_TASKS", {
              version: "v2",
              deploymentId: this.deploymentId,
              ...taskResources,
              supportsLazyAttempts: true,
            });

            if (success) {
              logger.info("indexing done, shutting down..");
              process.exit(0);
            } else {
              logger.info("indexing failure, shutting down..");
              process.exit(1);
            }
          } catch (e) {
            const stderr = this.#backgroundWorker.stderr.join("\n");

            if (e instanceof TaskMetadataParseError) {
              logger.error("tasks metadata parse error", {
                zodIssues: e.zodIssues,
                tasks: e.tasks,
              });

              failIndex({
                name: "TaskMetadataParseError",
                message: "There was an error parsing the task metadata",
                stack: JSON.stringify({ zodIssues: e.zodIssues, tasks: e.tasks }),
                stderr,
              });
            } else if (e instanceof UncaughtExceptionError) {
              const error = {
                name: e.originalError.name,
                message: e.originalError.message,
                stack: e.originalError.stack,
                stderr,
              };

              logger.error("uncaught exception", { originalError: error });

              failIndex(error);
            } else if (e instanceof Error) {
              const error = {
                name: e.name,
                message: e.message,
                stack: e.stack,
                stderr,
              };

              logger.error("error", { error });

              failIndex(error);
            } else if (typeof e === "string") {
              logger.error("string error", { error: { message: e } });

              failIndex({
                name: "Error",
                message: e,
                stderr,
              });
            } else {
              logger.error("unknown error", { error: e });

              failIndex({
                name: "Error",
                message: "Unknown error",
                stderr,
              });
            }

            await setTimeout(200);

            process.exit(EXIT_CODE_ALREADY_HANDLED);
          }
        }

        if (this.executing) {
          return;
        }

        socket.emit("READY_FOR_LAZY_ATTEMPT", {
          version: "v1",
          runId: this.runId,
          totalCompletions: this.completed.size,
        });
      },
      onError: async (socket, err, logger) => {
        logger.error("onError", {
          error: {
            name: err.name,
            message: err.message,
          },
        });

        await this.#reconnect();
      },
      onDisconnect: async (socket, reason, description, logger) => {
        // this.#reconnect();
      },
    });

    return coordinatorConnection;
  }

  #createHttpServer() {
    const httpServer = createServer(async (req, res) => {
      logger.log(`[${req.method}]`, req.url);
      const reply = new HttpReply(res);

      try {
        const url = new URL(req.url ?? "", `http://${req.headers.host}`);

        switch (url.pathname) {
          case "/health": {
            return reply.text("ok");
          }

          case "/status": {
            return reply.json(this.#status);
          }

          case "/connect": {
            this.#coordinatorSocket.connect();

            return reply.text("Connected to coordinator");
          }

          case "/close": {
            await this.#coordinatorSocket.sendWithAck("LOG", {
              version: "v1",
              text: `[${req.method}] ${req.url}`,
            });

            this.#coordinatorSocket.close();

            return reply.text("Disconnected from coordinator");
          }

          case "/test": {
            await this.#coordinatorSocket.sendWithAck("LOG", {
              version: "v1",
              text: `[${req.method}] ${req.url}`,
            });

            return reply.text("Received ACK from coordinator");
          }

          case "/preStop": {
            const cause = PreStopCauses.safeParse(url.searchParams.get("cause"));

            if (!cause.success) {
              logger.error("Failed to parse cause", { cause });
              return reply.text("Failed to parse cause", 400);
            }

            switch (cause.data) {
              case "terminate": {
                break;
              }
              default: {
                logger.error("Unhandled cause", { cause: cause.data });
                break;
              }
            }

            return reply.text("preStop ok");
          }

          case "/postStart": {
            const cause = PostStartCauses.safeParse(url.searchParams.get("cause"));

            if (!cause.success) {
              logger.error("Failed to parse cause", { cause });
              return reply.text("Failed to parse cause", 400);
            }

            switch (cause.data) {
              case "index": {
                break;
              }
              case "create": {
                break;
              }
              case "restore": {
                await this.#reconnect(true, true);
                break;
              }
              default: {
                logger.error("Unhandled cause", { cause: cause.data });
                break;
              }
            }

            return reply.text("postStart ok");
          }

          default: {
            return reply.empty(404);
          }
        }
      } catch (error) {
        logger.error("HTTP server error", { error });
        reply.empty(500);
      }
    });

    httpServer.on("clientError", (err, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    httpServer.on("listening", () => {
      logger.log("http server listening on port", this.#httpPort);
    });

    httpServer.on("error", async (error) => {
      // @ts-expect-error
      if (error.code != "EADDRINUSE") {
        return;
      }

      logger.error(`port ${this.#httpPort} already in use, retrying with random port..`);

      this.#httpPort = getRandomPortNumber();

      await setTimeout(100);
      this.start();
    });

    return httpServer;
  }

  async #initializeWorker() {
    // Make an API call for the env vars
    // Don't use ApiClient again
    // Pass those into this.#backgroundWorker.initialize()
    const envVars = await this.#fetchEnvironmentVariables();

    await this.#backgroundWorker.initialize({ env: envVars });

    let packageVersion: string | undefined;

    const taskResources: Array<TaskResource> = [];

    if (!this.#backgroundWorker.tasks) {
      throw new Error(`Background Worker started without tasks`);
    }

    for (const task of this.#backgroundWorker.tasks) {
      taskResources.push(task);

      packageVersion = task.packageVersion;
    }

    if (!packageVersion) {
      throw new Error(`Background Worker started without package version`);
    }

    return {
      packageVersion,
      tasks: taskResources,
    };
  }

  async #fetchEnvironmentVariables(): Promise<Record<string, string>> {
    const response = await fetch(`${this.apiUrl}/api/v1/projects/${this.projectRef}/envvars`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      return {};
    }

    const data = await response.json();

    return data?.variables ?? {};
  }

  get #status() {
    return {
      executing: this.executing,
      paused: this.paused,
      completed: this.completed.size,
      nextResumeAfter: this.nextResumeAfter,
      waitForPostStart: this.waitForPostStart,
      attemptFriendlyId: this.attemptFriendlyId,
    };
  }

  #emitUnrecoverableError(name: string, message: string) {
    this.#coordinatorSocket.socket.emit("UNRECOVERABLE_ERROR", {
      version: "v1",
      error: {
        name,
        message,
      },
    });
  }

  start() {
    this.#httpServer.listen(this.#httpPort, this.host);
  }
}

const prodWorker = new ProdWorker(HTTP_SERVER_PORT);
prodWorker.start();

function gatherProcessEnv() {
  const env = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: process.env.PATH,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG,
    TERM: process.env.TERM,
    NODE_PATH: process.env.NODE_PATH,
    HOME: process.env.HOME,
  };

  // Filter out undefined values
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined));
}
