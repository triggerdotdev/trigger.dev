import {
  CompletedWaitpoint,
  ExecutorToWorkerMessageCatalog,
  MachinePreset,
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
import { nodeOptionsWithMaxOldSpaceSize } from "@trigger.dev/core/v3/machines";
import { InferSocketMessageSchema } from "@trigger.dev/core/v3/zodSocket";
import { logger } from "../utilities/logger.js";
import {
  CancelledProcessError,
  CleanupProcessError,
  internalErrorFromUnexpectedExit,
  GracefulExitTimeoutError,
  UnexpectedExitError,
  SuspendedProcessError,
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
export type OnWaitMessage = InferSocketMessageSchema<typeof ExecutorToWorkerMessageCatalog, "WAIT">;

export type TaskRunProcessOptions = {
  workerManifest: WorkerManifest;
  serverWorker: ServerBackgroundWorker;
  env: Record<string, string>;
  machine: MachinePreset;
  isWarmStart?: boolean;
  cwd?: string;
};

export type TaskRunProcessExecuteParams = {
  payload: TaskRunExecutionPayload;
  messageId: string;
  env?: Record<string, string>;
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
  private _isBeingSuspended: boolean = false;
  private _stderr: Array<string> = [];

  public onTaskRunHeartbeat: Evt<string> = new Evt();
  public onExit: Evt<{ code: number | null; signal: NodeJS.Signals | null; pid?: number }> =
    new Evt();
  public onIsBeingKilled: Evt<TaskRunProcess> = new Evt();
  public onReadyToDispose: Evt<TaskRunProcess> = new Evt();

  public onWaitForTask: Evt<OnWaitForTaskMessage> = new Evt();
  public onWaitForBatch: Evt<OnWaitForBatchMessage> = new Evt();
  public onWait: Evt<OnWaitMessage> = new Evt();

  private _isPreparedForNextRun: boolean = false;

  constructor(public readonly options: TaskRunProcessOptions) {
    this._isPreparedForNextRun = true;
  }

  get isPreparedForNextRun() {
    return this._isPreparedForNextRun;
  }

  async cancel() {
    this._isPreparedForNextRun = false;
    this._isBeingCancelled = true;

    try {
      await this.#flush();
    } catch (err) {
      console.error("Error flushing task run process", { err });
    }

    await this.kill();
  }

  async cleanup(kill = true) {
    this._isPreparedForNextRun = false;

    try {
      await this.#flush();
    } catch (err) {
      console.error("Error flushing task run process", { err });
    }

    if (kill) {
      await this.kill("SIGKILL");
    }
  }

  initialize() {
    const { env: $env, workerManifest, cwd, machine } = this.options;

    const maxOldSpaceSize = nodeOptionsWithMaxOldSpaceSize(undefined, machine);

    const fullEnv = {
      ...$env,
      OTEL_IMPORT_HOOK_INCLUDES: workerManifest.otelImportHook?.include?.join(","),
      // TODO: this will probably need to use something different for bun (maybe --preload?)
      NODE_OPTIONS: execOptionsForRuntime(workerManifest.runtime, workerManifest, maxOldSpaceSize),
      PATH: process.env.PATH,
      TRIGGER_PROCESS_FORK_START_TIME: String(Date.now()),
      TRIGGER_WARM_START: this.options.isWarmStart ? "true" : "false",
    };

    logger.debug(`initializing task run process`, {
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
        READY_TO_DISPOSE: async () => {
          logger.debug(`task run process is ready to dispose`);

          this.onReadyToDispose.post(this);
        },
        TASK_HEARTBEAT: async (message) => {
          this.onTaskRunHeartbeat.post(message.id);
        },
        WAIT_FOR_TASK: async (message) => {
          this.onWaitForTask.post(message);
        },
        WAIT_FOR_BATCH: async (message) => {
          this.onWaitForBatch.post(message);
        },
        UNCAUGHT_EXCEPTION: async (message) => {
          logger.debug("uncaught exception in task run process", { ...message });
        },
      },
    });

    this._child.on("exit", this.#handleExit.bind(this));
    this._child.stdout?.on("data", this.#handleLog.bind(this));
    this._child.stderr?.on("data", this.#handleStdErr.bind(this));

    return this;
  }

  async #flush(timeoutInMs: number = 5_000) {
    logger.debug("flushing task run process", { pid: this.pid });

    await this._ipc?.sendWithAck("FLUSH", { timeoutInMs }, timeoutInMs + 1_000);
  }

  async execute(params: TaskRunProcessExecuteParams): Promise<TaskRunExecutionResult> {
    this._isPreparedForNextRun = false;

    let resolver: (value: TaskRunExecutionResult) => void;
    let rejecter: (err?: any) => void;

    const promise = new Promise<TaskRunExecutionResult>((resolve, reject) => {
      resolver = resolve;
      rejecter = reject;
    });

    this._attemptStatuses.set(params.payload.execution.attempt.id, "PENDING");

    // @ts-expect-error - We know that the resolver and rejecter are defined
    this._attemptPromises.set(params.payload.execution.attempt.id, { resolver, rejecter });

    const { execution, traceContext, metrics } = params.payload;

    this._currentExecution = execution;

    if (this._child?.connected && !this._isBeingKilled && !this._child.killed) {
      logger.debug(
        `[${new Date().toISOString()}][${
          params.payload.execution.run.id
        }] sending EXECUTE_TASK_RUN message to task run process`,
        {
          pid: this.pid,
        }
      );

      await this._ipc?.send("EXECUTE_TASK_RUN", {
        execution,
        traceContext,
        metadata: this.options.serverWorker,
        metrics,
        env: params.env,
        isWarmStart: this.options.isWarmStart,
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

  waitpointCreated(waitId: string, waitpointId: string) {
    if (!this._child?.connected || this._isBeingKilled || this._child.killed) {
      console.error(
        "Child process not connected or being killed, can't send waitpoint created notification"
      );
      return;
    }

    this._ipc?.send("WAITPOINT_CREATED", {
      wait: {
        id: waitId,
      },
      waitpoint: {
        id: waitpointId,
      },
    });
  }

  waitpointCompleted(waitpoint: CompletedWaitpoint) {
    if (!this._child?.connected || this._isBeingKilled || this._child.killed) {
      console.error(
        "Child process not connected or being killed, can't send waitpoint completed notification"
      );
      return;
    }

    this._ipc?.send("WAITPOINT_COMPLETED", {
      waitpoint,
    });
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
          if (this._isBeingSuspended) {
            rejecter(new SuspendedProcessError());
          } else {
            rejecter(new CleanupProcessError());
          }
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
    logger.debug(`killing task run process`, {
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

  async suspend() {
    this._isBeingSuspended = true;
    await this.kill("SIGKILL");
  }

  forceExit() {
    try {
      this._isBeingKilled = true;

      this._child?.kill("SIGKILL");
    } catch (error) {
      logger.debug("forceExit: failed to kill child process", { error });
    }
  }

  get isBeingKilled() {
    return this._isBeingKilled || this._child?.killed;
  }

  get pid() {
    return this._childPid;
  }

  static parseExecuteError(error: unknown, dockerMode = true): TaskRunInternalError {
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
      return internalErrorFromUnexpectedExit(error, dockerMode);
    }

    if (error instanceof GracefulExitTimeoutError) {
      return {
        type: "INTERNAL_ERROR",
        code: TaskRunErrorCodes.GRACEFUL_EXIT_TIMEOUT,
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
