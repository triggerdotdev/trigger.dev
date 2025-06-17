import {
  attemptKey,
  CompletedWaitpoint,
  ExecutorToWorkerMessageCatalog,
  MachinePresetResources,
  ServerBackgroundWorker,
  TaskRunErrorCodes,
  TaskRunExecution,
  TaskRunExecutionPayload,
  TaskRunExecutionResult,
  type TaskRunInternalError,
  tryCatch,
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

export type OnSendDebugLogMessage = InferSocketMessageSchema<
  typeof ExecutorToWorkerMessageCatalog,
  "SEND_DEBUG_LOG"
>;

export type OnSetSuspendableMessage = InferSocketMessageSchema<
  typeof ExecutorToWorkerMessageCatalog,
  "SET_SUSPENDABLE"
>;

export type TaskRunProcessOptions = {
  workerManifest: WorkerManifest;
  serverWorker: ServerBackgroundWorker;
  env: Record<string, string>;
  machineResources: MachinePresetResources;
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
  public onSendDebugLog: Evt<OnSendDebugLogMessage> = new Evt();
  public onSetSuspendable: Evt<OnSetSuspendableMessage> = new Evt();

  private _isPreparedForNextRun: boolean = false;
  private _isPreparedForNextAttempt: boolean = false;

  constructor(public readonly options: TaskRunProcessOptions) {
    this._isPreparedForNextRun = true;
    this._isPreparedForNextAttempt = true;
  }

  get isPreparedForNextRun() {
    return this._isPreparedForNextRun;
  }

  get isPreparedForNextAttempt() {
    return this._isPreparedForNextAttempt;
  }

  unsafeDetachEvtHandlers() {
    this.onExit.detach();
    this.onIsBeingKilled.detach();
    this.onSendDebugLog.detach();
    this.onSetSuspendable.detach();
    this.onTaskRunHeartbeat.detach();
  }

  async cancel() {
    this._isPreparedForNextRun = false;
    this._isBeingCancelled = true;

    try {
      await this.#cancel();
    } catch (err) {
      console.error("Error cancelling task run process", { err });
    }

    await this.kill();
  }

  async cleanup(kill = true) {
    this._isPreparedForNextRun = false;

    if (this._isBeingCancelled) {
      return;
    }

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
    const { env: $env, workerManifest, cwd, machineResources: machine } = this.options;

    const maxOldSpaceSize = nodeOptionsWithMaxOldSpaceSize(undefined, machine);

    const fullEnv = {
      ...$env,
      OTEL_IMPORT_HOOK_INCLUDES: workerManifest.otelImportHook?.include?.join(","),
      // TODO: this will probably need to use something different for bun (maybe --preload?)
      NODE_OPTIONS: execOptionsForRuntime(workerManifest.runtime, workerManifest, maxOldSpaceSize),
      PATH: process.env.PATH,
      TRIGGER_PROCESS_FORK_START_TIME: String(Date.now()),
      TRIGGER_WARM_START: this.options.isWarmStart ? "true" : "false",
      TRIGGER: "1",
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

          const key = attemptKey(execution);

          const promiseStatus = this._attemptStatuses.get(key);

          if (promiseStatus !== "PENDING") {
            return;
          }

          this._attemptStatuses.set(key, "RESOLVED");

          const attemptPromise = this._attemptPromises.get(key);

          if (!attemptPromise) {
            return;
          }

          const { resolver } = attemptPromise;

          resolver(result);
        },
        TASK_HEARTBEAT: async (message) => {
          this.onTaskRunHeartbeat.post(message.id);
        },
        UNCAUGHT_EXCEPTION: async (message) => {
          logger.debug("uncaught exception in task run process", { ...message });
        },
        SEND_DEBUG_LOG: async (message) => {
          this.onSendDebugLog.post(message);
        },
        SET_SUSPENDABLE: async (message) => {
          this.onSetSuspendable.post(message);
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

  async #cancel(timeoutInMs: number = 30_000) {
    logger.debug("sending cancel message to task run process", { pid: this.pid, timeoutInMs });

    await this._ipc?.sendWithAck("CANCEL", { timeoutInMs }, timeoutInMs + 1_000);
  }

  async execute(
    params: TaskRunProcessExecuteParams,
    isWarmStart?: boolean
  ): Promise<TaskRunExecutionResult> {
    this._isBeingCancelled = false;
    this._isPreparedForNextRun = false;
    this._isPreparedForNextAttempt = false;

    let resolver: (value: TaskRunExecutionResult) => void;
    let rejecter: (err?: any) => void;

    const promise = new Promise<TaskRunExecutionResult>((resolve, reject) => {
      resolver = resolve;
      rejecter = reject;
    });

    const key = attemptKey(params.payload.execution);

    this._attemptStatuses.set(key, "PENDING");

    // @ts-expect-error - We know that the resolver and rejecter are defined
    this._attemptPromises.set(key, { resolver, rejecter });

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
        isWarmStart: isWarmStart ?? this.options.isWarmStart,
      });
    }

    const result = await promise;

    this._currentExecution = undefined;
    this._isPreparedForNextAttempt = true;

    return result;
  }

  isExecuting() {
    return this._currentExecution !== undefined;
  }

  waitpointCompleted(waitpoint: CompletedWaitpoint) {
    if (!this._child?.connected || this._isBeingKilled || this._child.killed) {
      console.error(
        "Child process not connected or being killed, can't send waitpoint completed notification"
      );
      return;
    }

    this._ipc?.send("RESOLVE_WAITPOINT", { waitpoint });
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

  /** This will never throw. */
  async kill(signal?: number | NodeJS.Signals, timeoutInMs?: number) {
    logger.debug(`killing task run process`, {
      signal,
      timeoutInMs,
      pid: this.pid,
    });

    this._isBeingKilled = true;

    const killTimeout = this.onExit.waitFor(timeoutInMs);

    this.onIsBeingKilled.post(this);

    try {
      this._child?.kill(signal);
    } catch (error) {
      logger.debug("kill: failed to kill child process", { error });
    }

    if (!timeoutInMs) {
      return;
    }

    const [error] = await tryCatch(killTimeout);

    if (error) {
      logger.debug("kill: failed to wait for child process to exit", { error });
    }
  }

  async suspend({ flush }: { flush: boolean }) {
    this._isBeingSuspended = true;

    if (flush) {
      const [error] = await tryCatch(this.#flush());

      if (error) {
        console.error("Error flushing task run process", { error });
      }
    }

    await this.kill("SIGKILL");
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
