import {
  ExecutorToWorkerMessageCatalog,
  ServerBackgroundWorker,
  TaskRunErrorCodes,
  TaskRunExecution,
  TaskRunExecutionPayload,
  TaskRunExecutionResult,
  type TaskRunInternalError,
  WorkerManifest,
  WorkerToExecutorMessageCatalog,
} from "@trigger.dev/core/v3";
import {
  type WorkerToExecutorProcessConnection,
  ZodIpcConnection,
} from "@trigger.dev/core/v3/zodIpc";
import { Evt } from "evt";
import { ChildProcess, fork } from "node:child_process";
import { chalkError, chalkGrey, chalkRun, prettyPrintDate } from "../utilities/cliOutput.js";

import { execOptionsForRuntime, execPathForRuntime } from "@trigger.dev/core/v3/build";
import { InferSocketMessageSchema } from "@trigger.dev/core/v3/zodSocket";
import { logger } from "../utilities/logger.js";
import {
  CancelledProcessError,
  CleanupProcessError,
  getFriendlyErrorMessage,
  GracefulExitTimeoutError,
  UnexpectedExitError,
} from "@trigger.dev/core/v3/errors";

export type OnWaitForDurationMessage = InferSocketMessageSchema<
  typeof ExecutorToWorkerMessageCatalog,
  "WAIT_FOR_DURATION"
>;
export type OnWaitForTaskMessage = InferSocketMessageSchema<
  typeof ExecutorToWorkerMessageCatalog,
  "WAIT_FOR_TASK"
>;
export type OnWaitForBatchMessage = InferSocketMessageSchema<
  typeof ExecutorToWorkerMessageCatalog,
  "WAIT_FOR_BATCH"
>;

export type TaskRunProcessOptions = {
  workerManifest: WorkerManifest;
  serverWorker: ServerBackgroundWorker;
  env: Record<string, string>;
  payload: TaskRunExecutionPayload;
  messageId: string;

  cwd?: string;
};

export class TaskRunProcess {
  private _ipc?: WorkerToExecutorProcessConnection;
  private _child: ChildProcess | undefined;
  private _childPid?: number;
  private _attemptPromises: Map<
    string,
    { resolver: (value: TaskRunExecutionResult) => void; rejecter: (err?: any) => void }
  > = new Map();
  private _attemptStatuses: Map<string, "PENDING" | "REJECTED" | "RESOLVED"> = new Map();
  private _currentExecution: TaskRunExecution | undefined;
  private _gracefulExitTimeoutElapsed: boolean = false;
  private _isBeingKilled: boolean = false;
  private _isBeingCancelled: boolean = false;
  private _stderr: Array<string> = [];

  public onTaskRunHeartbeat: Evt<string> = new Evt();
  public onExit: Evt<{ code: number | null; signal: NodeJS.Signals | null; pid?: number }> =
    new Evt();
  public onIsBeingKilled: Evt<TaskRunProcess> = new Evt();
  public onReadyToDispose: Evt<TaskRunProcess> = new Evt();

  public onWaitForDuration: Evt<OnWaitForDurationMessage> = new Evt();
  public onWaitForTask: Evt<OnWaitForTaskMessage> = new Evt();
  public onWaitForBatch: Evt<OnWaitForBatchMessage> = new Evt();

  constructor(public readonly options: TaskRunProcessOptions) {}

  async cancel() {
    this._isBeingCancelled = true;

    try {
      await this.#flush();
    } catch (err) {
      logger.error("Error flushing task run process", { err });
    }

    await this.kill();
  }

  async cleanup(kill = true) {
    try {
      await this.#flush();
    } catch (err) {
      logger.error("Error flushing task run process", { err });
    }

    if (kill) {
      await this.kill("SIGKILL");
    }
  }

  get runId() {
    return this.options.payload.execution.run.id;
  }

  get isTest() {
    return this.options.payload.execution.run.isTest;
  }

  get payload() {
    return this.options.payload;
  }

  async initialize() {
    const { env: $env, workerManifest, cwd, messageId } = this.options;

    const fullEnv = {
      ...(this.isTest ? { TRIGGER_LOG_LEVEL: "debug" } : {}),
      ...$env,
      OTEL_IMPORT_HOOK_INCLUDES: workerManifest.otelImportHook?.include?.join(","),
      // TODO: this will probably need to use something different for bun (maybe --preload?)
      NODE_OPTIONS: execOptionsForRuntime(workerManifest.runtime, workerManifest),
    };

    logger.debug(`[${this.runId}] initializing task run process`, {
      env: fullEnv,
      path: workerManifest.workerEntryPoint,
      cwd,
    });

    this._child = fork(workerManifest.workerEntryPoint, executorArgs(workerManifest), {
      stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
      cwd,
      env: fullEnv,
      execArgv: ["--trace-uncaught", "--no-warnings=ExperimentalWarning"],
      execPath: execPathForRuntime(workerManifest.runtime),
      serialization: "json",
    });

    this._childPid = this._child?.pid;

    this._ipc = new ZodIpcConnection({
      listenSchema: ExecutorToWorkerMessageCatalog,
      emitSchema: WorkerToExecutorMessageCatalog,
      process: this._child,
      handlers: {
        TASK_RUN_COMPLETED: async (message) => {
          const { result, execution } = message;

          const promiseStatus = this._attemptStatuses.get(execution.attempt.id);

          if (promiseStatus !== "PENDING") {
            return;
          }

          this._attemptStatuses.set(execution.attempt.id, "RESOLVED");

          const attemptPromise = this._attemptPromises.get(execution.attempt.id);

          if (!attemptPromise) {
            return;
          }

          const { resolver } = attemptPromise;

          resolver(result);
        },
        READY_TO_DISPOSE: async (message) => {
          logger.debug(`[${this.runId}] task run process is ready to dispose`);

          this.onReadyToDispose.post(this);
        },
        TASK_HEARTBEAT: async (message) => {
          this.onTaskRunHeartbeat.post(messageId);
        },
        WAIT_FOR_TASK: async (message) => {
          this.onWaitForTask.post(message);
        },
        WAIT_FOR_BATCH: async (message) => {
          this.onWaitForBatch.post(message);
        },
        WAIT_FOR_DURATION: async (message) => {
          this.onWaitForDuration.post(message);
        },
      },
    });

    this._child.on("exit", this.#handleExit.bind(this));
    this._child.stdout?.on("data", this.#handleLog.bind(this));
    this._child.stderr?.on("data", this.#handleStdErr.bind(this));
  }

  async #flush(timeoutInMs: number = 5_000) {
    logger.debug("flushing task run process", { pid: this.pid });

    await this._ipc?.sendWithAck("FLUSH", { timeoutInMs }, timeoutInMs + 1_000);
  }

  async execute(): Promise<TaskRunExecutionResult> {
    let resolver: (value: TaskRunExecutionResult) => void;
    let rejecter: (err?: any) => void;

    const promise = new Promise<TaskRunExecutionResult>((resolve, reject) => {
      resolver = resolve;
      rejecter = reject;
    });

    this._attemptStatuses.set(this.payload.execution.attempt.id, "PENDING");

    // @ts-expect-error - We know that the resolver and rejecter are defined
    this._attemptPromises.set(this.payload.execution.attempt.id, { resolver, rejecter });

    const { execution, traceContext } = this.payload;

    this._currentExecution = execution;

    if (this._child?.connected && !this._isBeingKilled && !this._child.killed) {
      logger.debug(
        `[${new Date().toISOString()}][${
          this.runId
        }] sending EXECUTE_TASK_RUN message to task run process`,
        {
          pid: this.pid,
        }
      );

      await this._ipc?.send("EXECUTE_TASK_RUN", {
        execution,
        traceContext,
        metadata: this.options.serverWorker,
      });
    }

    const result = await promise;

    this._currentExecution = undefined;

    return result;
  }

  taskRunCompletedNotification(completion: TaskRunExecutionResult) {
    if (!completion.ok && typeof completion.retry !== "undefined") {
      logger.debug(
        "Task run completed with error and wants to retry, won't send task run completed notification"
      );
      return;
    }

    if (!this._child?.connected || this._isBeingKilled || this._child.killed) {
      logger.debug(
        "Child process not connected or being killed, can't send task run completed notification"
      );
      return;
    }

    this._ipc?.send("TASK_RUN_COMPLETED_NOTIFICATION", {
      version: "v2",
      completion,
    });
  }

  waitCompletedNotification() {
    if (!this._child?.connected || this._isBeingKilled || this._child.killed) {
      console.error(
        "Child process not connected or being killed, can't send wait completed notification"
      );
      return;
    }

    this._ipc?.send("WAIT_COMPLETED_NOTIFICATION", {});
  }

  async #handleExit(code: number | null, signal: NodeJS.Signals | null) {
    logger.debug("handling child exit", { code, signal });

    // Go through all the attempts currently pending and reject them
    for (const [id, status] of this._attemptStatuses.entries()) {
      if (status === "PENDING") {
        logger.debug("found pending attempt", { id });

        this._attemptStatuses.set(id, "REJECTED");

        const attemptPromise = this._attemptPromises.get(id);

        if (!attemptPromise) {
          continue;
        }

        const { rejecter } = attemptPromise;

        if (this._isBeingCancelled) {
          rejecter(new CancelledProcessError());
        } else if (this._gracefulExitTimeoutElapsed) {
          // Order matters, this has to be before the graceful exit timeout
          rejecter(new GracefulExitTimeoutError());
        } else if (this._isBeingKilled) {
          rejecter(new CleanupProcessError());
        } else {
          rejecter(
            new UnexpectedExitError(
              code ?? -1,
              signal,
              this._stderr.length ? this._stderr.join("\n") : undefined
            )
          );
        }
      }
    }

    logger.debug("Task run process exited, posting onExit", { code, signal, pid: this.pid });

    this.onExit.post({ code, signal, pid: this.pid });
  }

  #handleLog(data: Buffer) {
    if (!this._currentExecution) {
      logger.log(`${chalkGrey("○")} ${chalkGrey(prettyPrintDate(new Date()))} ${data.toString()}`);

      return;
    }

    const runId = chalkRun(
      `${this._currentExecution.run.id}.${this._currentExecution.attempt.number}`
    );

    logger.log(
      `${chalkGrey("○")} ${chalkGrey(prettyPrintDate(new Date()))} ${runId} ${data.toString()}`
    );
  }

  #handleStdErr(data: Buffer) {
    if (this._isBeingKilled) {
      return;
    }

    if (!this._currentExecution) {
      logger.log(`${chalkError("○")} ${chalkGrey(prettyPrintDate(new Date()))} ${data.toString()}`);

      return;
    }

    const runId = chalkRun(
      `${this._currentExecution.run.id}.${this._currentExecution.attempt.number}`
    );

    const errorLine = data.toString();

    logger.log(
      `${chalkError("○")} ${chalkGrey(prettyPrintDate(new Date()))} ${runId} ${errorLine}`
    );

    if (this._stderr.length > 100) {
      this._stderr.shift();
    }
    this._stderr.push(errorLine);
  }

  async kill(signal?: number | NodeJS.Signals, timeoutInMs?: number) {
    logger.debug(`[${this.runId}] killing task run process`, {
      signal,
      timeoutInMs,
      pid: this.pid,
    });

    this._isBeingKilled = true;

    const killTimeout = this.onExit.waitFor(timeoutInMs);

    this.onIsBeingKilled.post(this);

    this._child?.kill(signal);

    if (timeoutInMs) {
      await killTimeout;
    }
  }

  get isBeingKilled() {
    return this._isBeingKilled || this._child?.killed;
  }

  get pid() {
    return this._childPid;
  }

  static parseExecuteError(error: unknown): TaskRunInternalError {
    if (error instanceof CancelledProcessError) {
      return {
        type: "INTERNAL_ERROR",
        code: TaskRunErrorCodes.TASK_RUN_CANCELLED,
      };
    }

    if (error instanceof CleanupProcessError) {
      return {
        type: "INTERNAL_ERROR",
        code: TaskRunErrorCodes.TASK_EXECUTION_ABORTED,
      };
    }

    if (error instanceof UnexpectedExitError) {
      return {
        type: "INTERNAL_ERROR",
        code: TaskRunErrorCodes.TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE,
        message: getFriendlyErrorMessage(error.code, error.signal, error.stderr),
        stackTrace: error.stderr,
      };
    }

    return {
      type: "INTERNAL_ERROR",
      code: TaskRunErrorCodes.TASK_EXECUTION_FAILED,
      message: String(error),
    };
  }
}

function executorArgs(workerManifest: WorkerManifest): string[] {
  return [];
}
