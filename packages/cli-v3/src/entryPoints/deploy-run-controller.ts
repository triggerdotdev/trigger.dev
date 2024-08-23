import {
  CoordinatorToProdWorkerMessages,
  PostStartCauses,
  PreStopCauses,
  ProdTaskRunExecution,
  ProdWorkerToCoordinatorMessages,
  TaskRunErrorCodes,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  WaitReason,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import {
  EXIT_CODE_CHILD_NONZERO,
  ExponentialBackoff,
  HttpReply,
  SimpleLogger,
  getRandomPortNumber,
} from "@trigger.dev/core/v3/apps";
import { ZodSocketConnection } from "@trigger.dev/core/v3/zodSocket";
import { Evt } from "evt";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as timeout } from "node:timers/promises";
import { logger as cliLogger } from "../utilities/logger.js";
import {
  OnWaitForBatchMessage,
  OnWaitForDurationMessage,
  OnWaitForTaskMessage,
  TaskRunProcess,
} from "../executions/taskRunProcess.js";
import { checkpointSafeTimeout, unboundedTimeout } from "@trigger.dev/core/v3/utils/timers";
import { env } from "std-env";

const HTTP_SERVER_PORT = Number(env.HTTP_SERVER_PORT || getRandomPortNumber());
const COORDINATOR_HOST = env.COORDINATOR_HOST || "127.0.0.1";
const COORDINATOR_PORT = Number(env.COORDINATOR_PORT || 50080);
const MACHINE_NAME = env.MACHINE_NAME || "local";
const POD_NAME = env.POD_NAME || "some-pod";
const SHORT_HASH = env.TRIGGER_CONTENT_HASH!.slice(0, 9);

const logger = new SimpleLogger(`[${MACHINE_NAME}][${SHORT_HASH}]`);

const defaultBackoff = new ExponentialBackoff("FullJitter", {
  maxRetries: 5,
});

cliLogger.loggerLevel = "debug";

cliLogger.debug("Starting prod worker", {
  env,
});

class ProdWorker {
  private contentHash = env.TRIGGER_CONTENT_HASH!;
  private projectRef = env.TRIGGER_PROJECT_REF!;
  private envId = env.TRIGGER_ENV_ID!;
  private runId = env.TRIGGER_RUN_ID!;
  private deploymentId = env.TRIGGER_DEPLOYMENT_ID!;
  private deploymentVersion = env.TRIGGER_DEPLOYMENT_VERSION!;
  private runningInKubernetes = !!env.KUBERNETES_PORT;

  private executing = false;
  private completed = new Set<string>();
  private paused = false;
  private attemptFriendlyId?: string;
  private attemptNumber?: number;

  private nextResumeAfter?: WaitReason;
  private waitForPostStart = false;
  private connectionCount = 0;

  private restoreNotification = Evt.create();

  private waitForTaskReplay:
    | {
        idempotencyKey: string;
        message: OnWaitForTaskMessage;
        attempt: number;
      }
    | undefined;
  private waitForBatchReplay:
    | {
        idempotencyKey: string;
        message: OnWaitForBatchMessage;
        attempt: number;
      }
    | undefined;
  private readyForLazyAttemptReplay:
    | {
        idempotencyKey: string;
      }
    | undefined;
  private durationResumeFallback:
    | {
        idempotencyKey: string;
      }
    | undefined;

  #httpPort: number;
  #httpServer: ReturnType<typeof createServer>;
  #coordinatorSocket: ZodSocketConnection<
    typeof ProdWorkerToCoordinatorMessages,
    typeof CoordinatorToProdWorkerMessages
  >;

  private _taskRunProcess: TaskRunProcess | undefined;

  constructor(
    port: number,
    private workerManifest: WorkerManifest,
    private host = "0.0.0.0"
  ) {
    process.on("SIGTERM", this.#handleSignal.bind(this, "SIGTERM"));

    this.#coordinatorSocket = this.#createCoordinatorSocket(COORDINATOR_HOST);

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
        await timeout(terminationGracePeriodSeconds * 1000 - 5000);
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
    if (this._taskRunProcess) {
      this._taskRunProcess.onTaskRunHeartbeat.detach();
      this._taskRunProcess.onWaitForDuration.detach();
      await this._taskRunProcess.cleanup(true);
    }

    if (!gracefulExitTimeoutElapsed) {
      // TODO: Maybe add a sensible timeout instead of a conditional to avoid zombies
      process.exit(exitCode);
    }
  }

  async #reconnectAfterPostStart() {
    this.waitForPostStart = false;

    this.#coordinatorSocket.close();
    this.connectionCount = 0;

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

  // MARK: TASK WAIT
  async #handleOnWaitForTask(message: OnWaitForTaskMessage, replayIdempotencyKey?: string) {
    logger.log("onWaitForTask", { message });

    if (this.nextResumeAfter) {
      logger.error("Already waiting for resume, skipping wait for task", {
        nextResumeAfter: this.nextResumeAfter,
      });

      return;
    }

    const waitForTask = await defaultBackoff.execute(async ({ retry }) => {
      logger.log("Wait for task with backoff", { retry });

      if (!this.attemptFriendlyId) {
        logger.error("Failed to send wait message, attempt friendly ID not set", { message });

        throw new ExponentialBackoff.StopRetrying("No attempt ID");
      }

      return await this.#coordinatorSocket.socket.timeout(20_000).emitWithAck("WAIT_FOR_TASK", {
        version: "v2",
        friendlyId: message.friendlyId,
        attemptFriendlyId: this.attemptFriendlyId,
      });
    });

    if (!waitForTask.success) {
      logger.error("Failed to wait for task with backoff", {
        cause: waitForTask.cause,
        error: waitForTask.error,
      });

      this.#emitUnrecoverableError(
        "WaitForTaskFailed",
        `${waitForTask.cause}: ${waitForTask.error}`
      );

      return;
    }

    const { willCheckpointAndRestore } = waitForTask.result;

    await this.#prepareForWait("WAIT_FOR_TASK", willCheckpointAndRestore);

    if (willCheckpointAndRestore) {
      // We need to replay this on next connection if we don't receive RESUME_AFTER_DEPENDENCY within a reasonable time
      if (!this.waitForTaskReplay) {
        this.waitForTaskReplay = {
          message,
          attempt: 1,
          idempotencyKey: randomUUID(),
        };
      } else {
        if (
          replayIdempotencyKey &&
          replayIdempotencyKey !== this.waitForTaskReplay.idempotencyKey
        ) {
          logger.error(
            "wait for task handler called with mismatched idempotency key, won't overwrite replay request"
          );
          return;
        }

        this.waitForTaskReplay.attempt++;
      }
    }
  }

  // MARK: BATCH WAIT
  async #handleOnWaitForBatch(message: OnWaitForBatchMessage, replayIdempotencyKey?: string) {
    logger.log("onWaitForBatch", { message });

    if (this.nextResumeAfter) {
      logger.error("Already waiting for resume, skipping wait for batch", {
        nextResumeAfter: this.nextResumeAfter,
      });

      return;
    }

    const waitForBatch = await defaultBackoff.execute(async ({ retry }) => {
      logger.log("Wait for batch with backoff", { retry });

      if (!this.attemptFriendlyId) {
        logger.error("Failed to send wait message, attempt friendly ID not set", { message });

        throw new ExponentialBackoff.StopRetrying("No attempt ID");
      }

      return await this.#coordinatorSocket.socket.timeout(20_000).emitWithAck("WAIT_FOR_BATCH", {
        version: "v2",
        batchFriendlyId: message.batchFriendlyId,
        runFriendlyIds: message.runFriendlyIds,
        attemptFriendlyId: this.attemptFriendlyId,
      });
    });

    if (!waitForBatch.success) {
      logger.error("Failed to wait for batch with backoff", {
        cause: waitForBatch.cause,
        error: waitForBatch.error,
      });

      this.#emitUnrecoverableError(
        "WaitForBatchFailed",
        `${waitForBatch.cause}: ${waitForBatch.error}`
      );

      return;
    }

    const { willCheckpointAndRestore } = waitForBatch.result;

    await this.#prepareForWait("WAIT_FOR_BATCH", willCheckpointAndRestore);

    if (willCheckpointAndRestore) {
      // We need to replay this on next connection if we don't receive RESUME_AFTER_DEPENDENCY within a reasonable time
      if (!this.waitForBatchReplay) {
        this.waitForBatchReplay = {
          message,
          attempt: 1,
          idempotencyKey: randomUUID(),
        };
      } else {
        if (
          replayIdempotencyKey &&
          replayIdempotencyKey !== this.waitForBatchReplay.idempotencyKey
        ) {
          logger.error(
            "wait for task handler called with mismatched idempotency key, won't overwrite replay request"
          );
          return;
        }

        this.waitForBatchReplay.attempt++;
      }
    }
  }

  async #prepareForWait(reason: WaitReason, willCheckpointAndRestore: boolean) {
    logger.log(`prepare for ${reason}`, { willCheckpointAndRestore });

    if (this.nextResumeAfter) {
      logger.error("Already waiting for resume, skipping prepare for wait", {
        nextResumeAfter: this.nextResumeAfter,
        params: {
          reason,
          willCheckpointAndRestore,
        },
      });

      return;
    }

    if (!willCheckpointAndRestore) {
      return;
    }

    this.paused = true;
    this.nextResumeAfter = reason;
    this.waitForPostStart = true;

    await this.#prepareForCheckpoint();
  }

  // MARK: RETRY PREP
  async #prepareForRetry(shouldExit: boolean, exitCode?: number) {
    logger.log("prepare for retry", { shouldExit, exitCode });

    // Graceful shutdown on final attempt
    if (shouldExit) {
      await this.#exitGracefully(false, exitCode);
      return;
    }

    // Clear state for next execution
    this.paused = false;
    this.waitForPostStart = false;
    this.executing = false;
    this.attemptFriendlyId = undefined;
    this.attemptNumber = undefined;
  }

  // MARK: CHECKPOINT PREP
  async #prepareForCheckpoint(flush = true) {
    if (flush) {
      // Flush before checkpointing so we don't flush the same spans again after restore
      try {
        await this._taskRunProcess?.cleanup(false);
      } catch (error) {
        logger.error(
          "Failed to flush telemetry while preparing for checkpoint, will proceed anyway",
          { error }
        );
      }
    }

    try {
      // Kill the previous worker process to prevent large checkpoints
      // TODO: do we need this?
      // await this.#backgroundWorker.forceKillOldTaskRunProcesses();
    } catch (error) {
      logger.error(
        "Failed to kill previous worker while preparing for checkpoint, will proceed anyway",
        { error }
      );
    }

    this.#readyForCheckpoint();
  }

  #resumeAfterDuration() {
    this.paused = false;
    this.nextResumeAfter = undefined;
    this.waitForPostStart = false;

    this.durationResumeFallback = undefined;

    this._taskRunProcess?.waitCompletedNotification();
  }

  async #readyForLazyAttempt() {
    const idempotencyKey = randomUUID();

    this.readyForLazyAttemptReplay = {
      idempotencyKey,
    };

    // Retry if we don't receive EXECUTE_TASK_RUN_LAZY_ATTEMPT in a reasonable time
    // ..but we also have to be fast to avoid failing the task due to missing heartbeat
    for await (const { delay, retry } of defaultBackoff.min(10).maxRetries(3)) {
      if (retry > 0) {
        logger.log("retrying ready for lazy attempt", { retry });
      }

      this.#coordinatorSocket.socket.emit("READY_FOR_LAZY_ATTEMPT", {
        version: "v1",
        runId: this.runId,
        totalCompletions: this.completed.size,
      });

      await timeout(delay.milliseconds);

      if (!this.readyForLazyAttemptReplay) {
        logger.log("replay ready for lazy attempt cancelled, discarding", {
          idempotencyKey,
        });

        return;
      }

      if (idempotencyKey !== this.readyForLazyAttemptReplay.idempotencyKey) {
        logger.log("replay ready for lazy attempt idempotency key mismatch, discarding", {
          idempotencyKey,
          newIdempotencyKey: this.readyForLazyAttemptReplay.idempotencyKey,
        });

        return;
      }
    }

    // Fail the task with a more descriptive message as it likely failed with a generic missing heartbeat error
    this.#failRun(this.runId, "Failed to receive execute request in a reasonable time");
  }

  #readyForCheckpoint() {
    this.#coordinatorSocket.socket.emit("READY_FOR_CHECKPOINT", { version: "v1" });
  }

  #failRun(anyRunId: string, error: unknown) {
    logger.error("Failing run", { anyRunId, error });

    const completion: TaskRunFailedExecutionResult = {
      ok: false,
      id: anyRunId,
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

  // MARK: ATTEMPT COMPLETION
  async #submitAttemptCompletion(
    execution: ProdTaskRunExecution,
    completion: TaskRunExecutionResult,
    replayIdempotencyKey?: string
  ) {
    const taskRunCompleted = await defaultBackoff.execute(async ({ retry }) => {
      logger.log("Submit attempt completion with backoff", { retry });

      return await this.#coordinatorSocket.socket
        .timeout(20_000)
        .emitWithAck("TASK_RUN_COMPLETED", {
          version: "v2",
          execution,
          completion,
        });
    });

    if (!taskRunCompleted.success) {
      logger.error("Failed to complete lazy attempt with backoff", {
        cause: taskRunCompleted.cause,
        error: taskRunCompleted.error,
      });

      this.#failRun(execution.run.id, taskRunCompleted.error);

      return;
    }

    const { willCheckpointAndRestore, shouldExit } = taskRunCompleted.result;

    logger.log("completion acknowledged", { willCheckpointAndRestore, shouldExit });

    const exitCode =
      !completion.ok &&
      completion.error.type === "INTERNAL_ERROR" &&
      completion.error.code === TaskRunErrorCodes.TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE
        ? EXIT_CODE_CHILD_NONZERO
        : 0;

    await this.#prepareForRetry(shouldExit, exitCode);

    if (willCheckpointAndRestore) {
      logger.error("This worker should never be checkpointed between attempts. This is a bug.");
    }
  }

  #returnValidatedExtraHeaders(headers: Record<string, string>) {
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) {
        throw new Error(`Extra header is undefined: ${key}`);
      }
    }

    return headers;
  }

  // MARK: COORDINATOR SOCKET
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

    if (this.attemptNumber !== undefined) {
      extraHeaders["x-trigger-attempt-number"] = String(this.attemptNumber);
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
      ioOptions: {
        reconnectionDelay: 1000,
        reconnectionDelayMax: 3000,
      },
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

          switch (this.nextResumeAfter) {
            case "WAIT_FOR_TASK": {
              this.waitForTaskReplay = undefined;
              break;
            }
            case "WAIT_FOR_BATCH": {
              this.waitForBatchReplay = undefined;
              break;
            }
          }

          this.paused = false;
          this.nextResumeAfter = undefined;
          this.waitForPostStart = false;

          for (let i = 0; i < completions.length; i++) {
            const completion = completions[i];

            if (!completion) continue;

            this._taskRunProcess?.taskRunCompletedNotification(completion);
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
        EXECUTE_TASK_RUN: async () => {
          // These messages should only be received by old workers that don't support lazy attempts
          this.#failRun(
            this.runId,
            "Received deprecated EXECUTE_TASK_RUN message. Please contact us if you see this error."
          );
        },
        EXECUTE_TASK_RUN_LAZY_ATTEMPT: async (message) => {
          this.readyForLazyAttemptReplay = undefined;

          if (this.executing) {
            logger.error("dropping execute request, already executing");
            return;
          }

          const attemptCount = message.lazyPayload.attemptCount ?? 0;

          logger.log("execute attempt counts", { attemptCount, completed: this.completed.size });

          if (this.completed.size > 0 && this.completed.size >= attemptCount + 1) {
            logger.error("dropping execute request, already completed");
            return;
          }

          this.executing = true;

          const createAttempt = await defaultBackoff.execute(async ({ retry }) => {
            logger.log("Create task run attempt with backoff", {
              retry,
              runId: message.lazyPayload.runId,
            });

            return await this.#coordinatorSocket.socket
              .timeout(15_000)
              .emitWithAck("CREATE_TASK_RUN_ATTEMPT", {
                version: "v1",
                runId: message.lazyPayload.runId,
              });
          });

          logger.log("create attempt", { createAttempt });

          if (!createAttempt.success) {
            this.#failRun(
              message.lazyPayload.runId,
              `Failed to create attempt: ${createAttempt.cause}. ${createAttempt.error}`
            );
            return;
          }

          if (!createAttempt.result.success) {
            this.#failRun(
              message.lazyPayload.runId,
              createAttempt.result.reason ?? "Failed to create attempt"
            );
            return;
          }

          await this.#killCurrentTaskRunProcessBeforeAttempt();

          this.attemptFriendlyId = createAttempt.result.executionPayload.execution.attempt.id;
          this.attemptNumber = createAttempt.result.executionPayload.execution.attempt.number;

          const { execution } = createAttempt.result.executionPayload;
          const { environment } = message.lazyPayload;

          const env = {
            ...gatherProcessEnv(),
            ...environment,
          };

          this._taskRunProcess = new TaskRunProcess({
            workerManifest: this.workerManifest,
            env,
            serverWorker: execution.worker,
            payload: createAttempt.result.executionPayload,
            messageId: message.lazyPayload.messageId,
          });

          this._taskRunProcess.onTaskRunHeartbeat.attach((heartbeatId) => {
            logger.log("onTaskRunHeartbeat", {
              heartbeatId,
            });

            this.#coordinatorSocket.socket.volatile.emit("TASK_RUN_HEARTBEAT", {
              version: "v1",
              runId: heartbeatId,
            });
          });

          this._taskRunProcess.onWaitForDuration.attach(this.#handleOnWaitForDuration.bind(this));
          this._taskRunProcess.onWaitForTask.attach(this.#handleOnWaitForTask.bind(this));
          this._taskRunProcess.onWaitForBatch.attach(this.#handleOnWaitForBatch.bind(this));

          logger.log("initializing task run process", {
            workerManifest: this.workerManifest,
            attemptId: execution.attempt.id,
            runId: execution.run.id,
          });

          try {
            await this._taskRunProcess.initialize();

            logger.log("executing task run process", {
              attemptId: execution.attempt.id,
              runId: execution.run.id,
            });

            const completion = await this._taskRunProcess.execute();

            logger.log("completed", completion);

            this.completed.add(execution.attempt.id);

            await this._taskRunProcess.startFlushingProcess();

            await this.#submitAttemptCompletion(execution, completion);
          } catch (error) {
            logger.error("Failed to complete lazy attempt", {
              error,
            });

            this.#failRun(message.lazyPayload.runId, error);
          }
        },
        REQUEST_ATTEMPT_CANCELLATION: async (message) => {
          if (!this.executing) {
            logger.log("dropping cancel request, not executing", { status: this.#status });
            return;
          }

          logger.log("cancelling attempt", { attemptId: message.attemptId, status: this.#status });

          await this._taskRunProcess?.cancel();
        },
        REQUEST_EXIT: async (message) => {
          if (message.version === "v2" && message.delayInMs) {
            logger.log("exit requested with delay", { delayInMs: message.delayInMs });
            await timeout(message.delayInMs);
          }

          this.#coordinatorSocket.close();
          process.exit(0);
        },
        READY_FOR_RETRY: async (message) => {
          if (this.completed.size < 1) {
            logger.error("Received READY_FOR_RETRY but no completions yet. This is a bug.");
            return;
          }

          await this.#readyForLazyAttempt();
        },
      },
      // MARK: ON CONNECTION
      onConnection: async (socket, handler, sender, logger) => {
        logger.log("connected to coordinator", {
          status: this.#status,
          connectionCount: ++this.connectionCount,
        });

        // We need to send our current state to the coordinator
        socket.emit("SET_STATE", {
          version: "v1",
          attemptFriendlyId: this.attemptFriendlyId,
          attemptNumber: this.attemptNumber ? String(this.attemptNumber) : undefined,
        });

        try {
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
              logger.error("Missing attempt friendly ID", { status: this.#status });

              this.#emitUnrecoverableError(
                "NoAttemptId",
                "Attempt ID not set while resuming from paused state"
              );

              return;
            }

            if (!this.attemptNumber) {
              logger.error("Missing attempt number", { status: this.#status });

              this.#emitUnrecoverableError(
                "NoAttemptNumber",
                "Attempt number not set while resuming from paused state"
              );

              return;
            }

            socket.emit("READY_FOR_RESUME", {
              version: "v2",
              attemptFriendlyId: this.attemptFriendlyId,
              attemptNumber: this.attemptNumber,
              type: this.nextResumeAfter,
            });

            return;
          }

          if (this.executing) {
            return;
          }

          process.removeAllListeners("uncaughtException");
          process.on("uncaughtException", (error) => {
            console.error("Uncaught exception during run", error);
            this.#failRun(this.runId, error);
          });

          await this.#readyForLazyAttempt();
        } catch (error) {
          logger.error("connection handler error", { error });
        } finally {
          if (this.connectionCount === 1) {
            // Skip replays if this is the first connection, including post start
            return;
          }

          // This is a reconnect, so handle replays
          this.#handleReplays();
        }
      },
      onError: async (socket, err, logger) => {
        logger.error("onError", {
          error: {
            name: err.name,
            message: err.message,
          },
        });
      },
    });

    return coordinatorConnection;
  }

  // MARK: Handle onWaitForDuration
  async #handleOnWaitForDuration(message: OnWaitForDurationMessage) {
    logger.log("onWaitForDuration", {
      ...message,
      drift: Date.now() - message.now,
    });

    if (this.nextResumeAfter) {
      logger.error("Already waiting for resume, skipping wait for duration", {
        nextResumeAfter: this.nextResumeAfter,
      });

      return;
    }

    noResume: {
      const { ms, waitThresholdInMs } = message;

      const internalTimeout = unboundedTimeout(ms, "internal" as const);
      const checkpointSafeInternalTimeout = checkpointSafeTimeout(ms);

      if (ms < waitThresholdInMs) {
        await internalTimeout;
        break noResume;
      }

      const waitForDuration = await defaultBackoff.execute(async ({ retry }) => {
        logger.log("Wait for duration with backoff", { retry });

        if (!this.attemptFriendlyId) {
          logger.error("Failed to send wait message, attempt friendly ID not set", { message });

          throw new ExponentialBackoff.StopRetrying("No attempt ID");
        }

        return await this.#coordinatorSocket.socket
          .timeout(20_000)
          .emitWithAck("WAIT_FOR_DURATION", {
            ...message,
            attemptFriendlyId: this.attemptFriendlyId,
          });
      });

      if (!waitForDuration.success) {
        logger.error("Failed to wait for duration with backoff", {
          cause: waitForDuration.cause,
          error: waitForDuration.error,
        });

        this.#emitUnrecoverableError(
          "WaitForDurationFailed",
          `${waitForDuration.cause}: ${waitForDuration.error}`
        );

        return;
      }

      const { willCheckpointAndRestore } = waitForDuration.result;

      if (!willCheckpointAndRestore) {
        await internalTimeout;
        break noResume;
      }

      await this.#prepareForWait("WAIT_FOR_DURATION", willCheckpointAndRestore);
      // CHECKPOINTING AFTER THIS LINE

      // internalTimeout acts as a backup and will be accurate if the checkpoint never happens
      // checkpointSafeInternalTimeout is accurate even after non-simulated restores
      await Promise.race([internalTimeout, checkpointSafeInternalTimeout]);

      const idempotencyKey = randomUUID();
      this.durationResumeFallback = { idempotencyKey };

      try {
        await this.restoreNotification.waitFor(5_000);
      } catch (error) {
        logger.error("Did not receive restore notification in time", {
          error,
        });
      }

      try {
        // The coordinator should cancel any in-progress checkpoints so we don't end up with race conditions
        const { checkpointCanceled } = await this.#coordinatorSocket.socket
          .timeout(15_000)
          .emitWithAck("CANCEL_CHECKPOINT", {
            version: "v2",
            reason: "WAIT_FOR_DURATION",
          });

        logger.log("onCancelCheckpoint coordinator response", { checkpointCanceled });

        if (checkpointCanceled) {
          // If the checkpoint was canceled, we will never be resumed externally with RESUME_AFTER_DURATION, so it's safe to immediately resume
          break noResume;
        }

        logger.log("Waiting for external duration resume as we may have been restored");

        setTimeout(() => {
          if (!this.durationResumeFallback) {
            logger.error("Already resumed after duration, skipping fallback");
            return;
          }

          if (this.durationResumeFallback.idempotencyKey !== idempotencyKey) {
            logger.error("Duration resume idempotency key mismatch, skipping fallback");
            return;
          }

          logger.log("Resuming after duration with fallback");

          this.#resumeAfterDuration();
        }, 15_000);
      } catch (error) {
        // Just log this for now, but don't automatically resume. Wait for the external checkpoint-based resume.
        logger.debug("Checkpoint cancellation timed out", {
          message,
          error,
        });
      }

      return;
    }

    this.#resumeAfterDuration();
  }

  // MARK: REPLAYS
  async #handleReplays() {
    const backoff = new ExponentialBackoff().type("FullJitter").maxRetries(3);
    const replayCancellationDelay = 20_000;

    if (this.waitForTaskReplay) {
      logger.log("replaying wait for task", { ...this.waitForTaskReplay });

      const { idempotencyKey, message, attempt } = this.waitForTaskReplay;

      // Give the platform some time to send RESUME_AFTER_DEPENDENCY
      await timeout(replayCancellationDelay);

      if (!this.waitForTaskReplay) {
        logger.error("wait for task replay cancelled, discarding", {
          originalMessage: { idempotencyKey, message, attempt },
        });

        return;
      }

      if (idempotencyKey !== this.waitForTaskReplay.idempotencyKey) {
        logger.error("wait for task replay idempotency key mismatch, discarding", {
          originalMessage: { idempotencyKey, message, attempt },
          newMessage: this.waitForTaskReplay,
        });

        return;
      }

      try {
        await backoff.wait(attempt + 1);

        await this.#handleOnWaitForTask(message, idempotencyKey);
      } catch (error) {
        if (error instanceof ExponentialBackoff.RetryLimitExceeded) {
          logger.error("wait for task replay retry limit exceeded", { error });
        } else {
          logger.error("wait for task replay error", { error });
        }
      }

      return;
    }

    if (this.waitForBatchReplay) {
      logger.log("replaying wait for batch", {
        ...this.waitForBatchReplay,
        cancellationDelay: replayCancellationDelay,
      });

      const { idempotencyKey, message, attempt } = this.waitForBatchReplay;

      // Give the platform some time to send RESUME_AFTER_DEPENDENCY
      await timeout(replayCancellationDelay);

      if (!this.waitForBatchReplay) {
        logger.error("wait for batch replay cancelled, discarding", {
          originalMessage: { idempotencyKey, message, attempt },
        });

        return;
      }

      if (idempotencyKey !== this.waitForBatchReplay.idempotencyKey) {
        logger.error("wait for batch replay idempotency key mismatch, discarding", {
          originalMessage: { idempotencyKey, message, attempt },
          newMessage: this.waitForBatchReplay,
        });

        return;
      }

      try {
        await backoff.wait(attempt + 1);

        await this.#handleOnWaitForBatch(message, idempotencyKey);
      } catch (error) {
        if (error instanceof ExponentialBackoff.RetryLimitExceeded) {
          logger.error("wait for batch replay retry limit exceeded", { error });
        } else {
          logger.error("wait for batch replay error", { error });
        }
      }

      return;
    }
  }

  async #killCurrentTaskRunProcessBeforeAttempt() {
    console.log("killCurrentTaskRunProcessBeforeAttempt()", {
      hasTaskRunProcess: !!this._taskRunProcess,
    });

    if (!this._taskRunProcess) {
      return;
    }

    const currentTaskRunProcess = this._taskRunProcess;

    await currentTaskRunProcess.cleanup();
  }

  // MARK: HTTP SERVER
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
            this.#coordinatorSocket.close();
            this.connectionCount = 0;

            return reply.text("Disconnected from coordinator");
          }

          case "/test": {
            await this.#coordinatorSocket.socket.timeout(10_000).emitWithAck("TEST", {
              version: "v1",
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
                logger.error("Unhandled cause", { cause: cause });
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
                await this.#reconnectAfterPostStart();
                this.restoreNotification.post();
                break;
              }
              default: {
                logger.error("Unhandled cause", { cause: cause });
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

      return;
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

      await timeout(100);
      this.start();
    });

    return httpServer;
  }

  get #status() {
    return {
      executing: this.executing,
      paused: this.paused,
      completed: this.completed.size,
      nextResumeAfter: this.nextResumeAfter,
      waitForPostStart: this.waitForPostStart,
      attemptFriendlyId: this.attemptFriendlyId,
      attemptNumber: this.attemptNumber,
      waitForTaskReplay: this.waitForTaskReplay,
      waitForBatchReplay: this.waitForBatchReplay,
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

  async start() {
    this.#httpServer.listen(this.#httpPort, this.host);
  }
}

const workerManifest = await loadWorkerManifest();

const prodWorker = new ProdWorker(HTTP_SERVER_PORT, workerManifest);
await prodWorker.start();

function gatherProcessEnv(): Record<string, string> {
  const $env = {
    NODE_ENV: env.NODE_ENV ?? "production",
    NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS,
    OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
  };

  // Filter out undefined values
  return Object.fromEntries(
    Object.entries($env).filter(([key, value]) => value !== undefined)
  ) as Record<string, string>;
}

async function loadWorkerManifest() {
  const manifestContents = await readFile("./index.json", "utf-8");
  const raw = JSON.parse(manifestContents);

  return WorkerManifest.parse(raw);
}
