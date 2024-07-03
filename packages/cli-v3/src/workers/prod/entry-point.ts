import {
  Config,
  CoordinatorToProdWorkerMessages,
  PostStartCauses,
  PreStopCauses,
  ProdTaskRunExecution,
  ProdWorkerToCoordinatorMessages,
  TaskResource,
  TaskRunErrorCodes,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  WaitReason,
} from "@trigger.dev/core/v3";
import { InferSocketMessageSchema, ZodSocketConnection } from "@trigger.dev/core/v3/zodSocket";
import { HttpReply, getRandomPortNumber } from "@trigger.dev/core-apps/http";
import { SimpleLogger } from "@trigger.dev/core-apps/logger";
import { EXIT_CODE_ALREADY_HANDLED, EXIT_CODE_CHILD_NONZERO } from "@trigger.dev/core-apps/process";
import { ExponentialBackoff } from "@trigger.dev/core-apps/backoff";
import {
  OnWaitForBatchMessage,
  OnWaitForTaskMessage,
  ProdBackgroundWorker,
} from "./backgroundWorker";
import { TaskMetadataParseError, UncaughtExceptionError } from "../common/errors";
import { checkpointSafeTimeout, unboundedTimeout } from "@trigger.dev/core/v3/utils/timers";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as timeout } from "node:timers/promises";

declare const __PROJECT_CONFIG__: Config;

const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || getRandomPortNumber());
const COORDINATOR_HOST = process.env.COORDINATOR_HOST || "127.0.0.1";
const COORDINATOR_PORT = Number(process.env.COORDINATOR_PORT || 50080);
const MACHINE_NAME = process.env.MACHINE_NAME || "local";
const POD_NAME = process.env.POD_NAME || "some-pod";
const SHORT_HASH = process.env.TRIGGER_CONTENT_HASH!.slice(0, 9);

const logger = new SimpleLogger(`[${MACHINE_NAME}][${SHORT_HASH}]`);

const defaultBackoff = new ExponentialBackoff("FullJitter", {
  maxRetries: 5,
});

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
  private connectionCount = 0;

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
  private submitAttemptCompletionReplay:
    | {
        idempotencyKey: string;
        message: {
          execution: ProdTaskRunExecution;
          completion: TaskRunExecutionResult;
        };
        attempt: number;
      }
    | undefined;
  private durationResumeFallback:
    | {
        idempotencyKey: string;
      }
    | undefined;

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
    await this.#backgroundWorker.close(gracefulExitTimeoutElapsed);

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
  async #waitForTaskHandler(message: OnWaitForTaskMessage, replayIdempotencyKey?: string) {
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
      // TODO: where's the timeout?
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
  async #waitForBatchHandler(message: OnWaitForBatchMessage, replayIdempotencyKey?: string) {
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

  // MARK: WORKER CREATION
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
      logger.log("onTaskHeartbeat", { attemptFriendlyId });

      this.#coordinatorSocket.socket.volatile.emit("TASK_HEARTBEAT", {
        version: "v1",
        attemptFriendlyId,
      });
    });

    backgroundWorker.onTaskRunHeartbeat.attach((runId) => {
      logger.log("onTaskRunHeartbeat", { runId });

      this.#coordinatorSocket.socket.volatile.emit("TASK_RUN_HEARTBEAT", { version: "v1", runId });
    });

    backgroundWorker.onCreateTaskRunAttempt.attach(async (message) => {
      logger.log("onCreateTaskRunAttempt()", { message });

      const createAttempt = await defaultBackoff.execute(async ({ retry }) => {
        logger.log("Create task run attempt with backoff", { retry });

        return await this.#coordinatorSocket.socket
          .timeout(15_000)
          .emitWithAck("CREATE_TASK_RUN_ATTEMPT", {
            version: "v1",
            runId: message.runId,
          });
      });

      if (!createAttempt.success) {
        backgroundWorker.attemptCreatedNotification.post({
          success: false,
          reason: `Failed to create attempt with backoff due to ${createAttempt.cause}. ${createAttempt.error}`,
        });
        return;
      }

      if (!createAttempt.result.success) {
        backgroundWorker.attemptCreatedNotification.post({
          success: false,
          reason: createAttempt.result.reason,
        });
        return;
      }

      backgroundWorker.attemptCreatedNotification.post({
        success: true,
        execution: createAttempt.result.executionPayload.execution,
      });
    });

    backgroundWorker.attemptCreatedNotification.attach((message) => {
      logger.log("attemptCreatedNotification", {
        success: message.success,
        ...(message.success
          ? {
              attempt: message.execution.attempt,
              queue: message.execution.queue,
              worker: message.execution.worker,
              machine: message.execution.machine,
            }
          : {
              reason: message.reason,
            }),
      });

      if (!message.success) {
        return;
      }

      // Workers with lazy attempt support set their friendly ID here
      this.attemptFriendlyId = message.execution.attempt.id;
    });

    backgroundWorker.onWaitForDuration.attach(async (message) => {
      logger.log("onWaitForDuration", { ...message, drift: Date.now() - message.now });

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

          const idempotencyKey = randomUUID();
          this.durationResumeFallback = { idempotencyKey };

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
          // If the cancellation times out, we will proceed as if the checkpoint was canceled
          logger.debug("Checkpoint cancellation timed out", { error });
          break noResume;
        }

        return;
      }

      this.#resumeAfterDuration();
    });

    backgroundWorker.onWaitForTask.attach(this.#waitForTaskHandler.bind(this));
    backgroundWorker.onWaitForBatch.attach(this.#waitForBatchHandler.bind(this));

    return backgroundWorker;
  }

  async #prepareForWait(reason: WaitReason, willCheckpointAndRestore: boolean) {
    logger.log(`prepare for ${reason}`, { willCheckpointAndRestore });

    if (!willCheckpointAndRestore) {
      return;
    }

    this.paused = true;
    this.nextResumeAfter = reason;
    this.waitForPostStart = true;

    await this.#prepareForCheckpoint();
  }

  // MARK: RETRY PREP
  async #prepareForRetry(
    willCheckpointAndRestore: boolean,
    shouldExit: boolean,
    exitCode?: number
  ) {
    logger.log("prepare for retry", { willCheckpointAndRestore, shouldExit, exitCode });

    // Graceful shutdown on final attempt
    if (shouldExit) {
      if (willCheckpointAndRestore) {
        logger.error("WARNING: Will checkpoint but also requested exit. This won't end well.");
      }

      await this.#exitGracefully(false, exitCode);
      return;
    }

    // Clear state for next execution
    this.paused = false;
    this.waitForPostStart = false;
    this.executing = false;
    this.attemptFriendlyId = undefined;

    if (!willCheckpointAndRestore) {
      return;
    }

    this.waitForPostStart = true;

    // We already flush after completion, so we don't need to do it here
    await this.#prepareForCheckpoint(false);
  }

  // MARK: CHECKPOINT PREP
  async #prepareForCheckpoint(flush = true) {
    if (flush) {
      // Flush before checkpointing so we don't flush the same spans again after restore
      try {
        await this.#backgroundWorker.flushTelemetry();
      } catch (error) {
        logger.error(
          "Failed to flush telemetry while preparing for checkpoint, will proceed anyway",
          { error }
        );
      }
    }

    try {
      // Kill the previous worker process to prevent large checkpoints
      await this.#backgroundWorker.forceKillOldTaskRunProcesses();
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

    this.#backgroundWorker.waitCompletedNotification();
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
        logger.error("replay ready for lazy attempt cancelled, discarding", {
          idempotencyKey,
        });

        return;
      }

      if (idempotencyKey !== this.readyForLazyAttemptReplay.idempotencyKey) {
        logger.error("replay ready for lazy attempt idempotency key mismatch, discarding", {
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
          version: "v1",
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

    await this.#prepareForRetry(willCheckpointAndRestore, shouldExit, exitCode);

    if (willCheckpointAndRestore) {
      // We need to replay this on next connection if we don't receive READY_FOR_RETRY within a reasonable time
      if (!this.submitAttemptCompletionReplay) {
        this.submitAttemptCompletionReplay = {
          message: {
            execution,
            completion,
          },
          attempt: 1,
          idempotencyKey: randomUUID(),
        };
      } else {
        if (
          replayIdempotencyKey &&
          replayIdempotencyKey !== this.submitAttemptCompletionReplay.idempotencyKey
        ) {
          logger.error(
            "attempt completion handler called with mismatched idempotency key, won't overwrite replay request"
          );
          return;
        }

        this.submitAttemptCompletionReplay.attempt++;
      }
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

          this.durationResumeFallback = undefined;

          this.#resumeAfterDuration();
        },
        // Deprecated: This will never get called as this worker supports lazy attempts. It's only here for a quick view of the flow old workers use.
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

          await this.#prepareForRetry(willCheckpointAndRestore, shouldExit);
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

          try {
            const { completion, execution } =
              await this.#backgroundWorker.executeTaskRunLazyAttempt(message.lazyPayload);

            logger.log("completed", completion);

            this.completed.add(execution.attempt.id);

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

          await this.#backgroundWorker.cancelAttempt(message.attemptId);
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

          this.submitAttemptCompletionReplay = undefined;

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
        socket.emit("SET_STATE", { version: "v1", attemptFriendlyId: this.attemptFriendlyId });

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

            process.removeAllListeners("uncaughtException");
            process.on("uncaughtException", (error) => {
              console.error("Uncaught exception while indexing", error);
              failIndex(error);
            });

            try {
              const taskResources = await this.#initializeWorker();

              const indexTasks = await defaultBackoff.maxRetries(3).execute(async () => {
                return await socket.timeout(20_000).emitWithAck("INDEX_TASKS", {
                  version: "v2",
                  deploymentId: this.deploymentId,
                  ...taskResources,
                  supportsLazyAttempts: true,
                });
              });

              if (!indexTasks.success || !indexTasks.result.success) {
                logger.error("indexing failure, shutting down..", { indexTasks });
                process.exit(1);
              } else {
                logger.info("indexing done, shutting down..");
                process.exit(0);
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

              await timeout(1000);

              process.exit(EXIT_CODE_ALREADY_HANDLED);
            }
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

        await this.#waitForTaskHandler(message);
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

        await this.#waitForBatchHandler(message);
      } catch (error) {
        if (error instanceof ExponentialBackoff.RetryLimitExceeded) {
          logger.error("wait for batch replay retry limit exceeded", { error });
        } else {
          logger.error("wait for batch replay error", { error });
        }
      }

      return;
    }

    if (this.submitAttemptCompletionReplay) {
      logger.log("replaying attempt completion", {
        ...this.submitAttemptCompletionReplay,
        cancellationDelay: replayCancellationDelay,
      });

      const { idempotencyKey, message, attempt } = this.submitAttemptCompletionReplay;

      // Give the platform some time to send READY_FOR_RETRY
      await timeout(replayCancellationDelay);

      if (!this.submitAttemptCompletionReplay) {
        logger.error("attempt completion replay cancelled, discarding", {
          originalMessage: { idempotencyKey, message, attempt },
        });

        return;
      }

      if (idempotencyKey !== this.submitAttemptCompletionReplay.idempotencyKey) {
        logger.error("attempt completion replay idempotency key mismatch, discarding", {
          originalMessage: { idempotencyKey, message, attempt },
          newMessage: this.submitAttemptCompletionReplay,
        });

        return;
      }

      try {
        await backoff.wait(attempt + 1);

        await this.#submitAttemptCompletion(message.execution, message.completion, idempotencyKey);
      } catch (error) {
        if (error instanceof ExponentialBackoff.RetryLimitExceeded) {
          logger.error("attempt completion replay retry limit exceeded", { error });
        } else {
          logger.error("attempt completion replay error", { error });
        }
      }

      return;
    }
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
                await this.#reconnectAfterPostStart();
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

      await timeout(100);
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

    if (!this.#backgroundWorker.tasks || this.#backgroundWorker.tasks.length === 0) {
      throw new Error(
        `Background Worker started without tasks. Searched in: ${__PROJECT_CONFIG__.triggerDirectories?.join(
          ", "
        )}`
      );
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
