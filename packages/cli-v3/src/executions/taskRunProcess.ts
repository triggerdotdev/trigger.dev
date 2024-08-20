import {
  ServerBackgroundWorker,
  TaskRunExecution,
  TaskRunExecutionPayload,
  TaskRunExecutionResult,
  WorkerToExecutorMessageCatalog,
  ExecutorToWorkerMessageCatalog,
  WorkerManifest,
  SemanticInternalAttributes,
} from "@trigger.dev/core/v3";
import {
  type WorkerToExecutorProcessConnection,
  ZodIpcConnection,
} from "@trigger.dev/core/v3/zodIpc";
import { Evt } from "evt";
import { ChildProcess, fork } from "node:child_process";
import { chalkError, chalkGrey, chalkRun, prettyPrintDate } from "../utilities/cliOutput.js";

import { execPathForRuntime } from "@trigger.dev/core/v3/build";
import { logger } from "../utilities/logger.js";
import {
  CancelledProcessError,
  CleanupProcessError,
  GracefulExitTimeoutError,
  UnexpectedExitError,
} from "./errors.js";
import { InferSocketMessageSchema } from "@trigger.dev/core/v3/zodSocket";

export type OnWaitForDurationMessage = InferSocketMessageSchema<
  typeof WorkerToExecutorMessageCatalog,
  "WAIT_FOR_DURATION"
>;
export type OnWaitForTaskMessage = InferSocketMessageSchema<
  typeof WorkerToExecutorMessageCatalog,
  "WAIT_FOR_TASK"
>;
export type OnWaitForBatchMessage = InferSocketMessageSchema<
  typeof WorkerToExecutorMessageCatalog,
  "WAIT_FOR_BATCH"
>;

export type TaskRunProcessOptions = {
  workerManifest: WorkerManifest;
  serverWorker: ServerBackgroundWorker;
  env: Record<string, string>;
  payload: TaskRunExecutionPayload;

  cwd?: string;
  messageId?: string;
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
  /**
   * @deprecated use onTaskRunHeartbeat instead
   */
  public onTaskHeartbeat: Evt<string> = new Evt();
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

    await this.cleanup(true);
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
    const { env, workerManifest, cwd, messageId } = this.options;

    const fullEnv = {
      ...(this.isTest ? { TRIGGER_LOG_LEVEL: "debug" } : {}),
      ...env,
      OTEL_IMPORT_HOOK_INCLUDES: workerManifest.otelImportHook?.include?.join(","),
      // TODO: this will probably need to use something different for bun (maybe --preload?)
      NODE_OPTIONS: workerManifest.loaderEntryPoint
        ? `--import=${workerManifest.loaderEntryPoint} ${
            env.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? ""
          }`
        : env.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? "",
    };

    logger.debug(`[${this.runId}] initializing task run process`, {
      env: fullEnv,
      path: workerManifest.workerEntryPoint,
      cwd,
    });

    this._child = fork(workerManifest.executorEntryPoint, executorArgs(workerManifest), {
      stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
      cwd,
      env: fullEnv,
      execArgv: ["--trace-uncaught", "--no-warnings=ExperimentalWarning"],
      execPath: execPathForRuntime(workerManifest.runtime),
      serialization: "json",
    });

    this._childPid = this._child?.pid;

    this._ipc = new ZodIpcConnection({
      listenSchema: WorkerToExecutorMessageCatalog,
      emitSchema: ExecutorToWorkerMessageCatalog,
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
          if (messageId) {
            this.onTaskRunHeartbeat.post(messageId);
          } else {
            logger.debug(
              "No message id for task heartbeat, falling back to (deprecated) attempt heartbeat",
              { id: message.id }
            );
            this.onTaskHeartbeat.post(message.id);
          }
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

  async cleanup(kill = false, gracefulExitTimeoutElapsed = false) {
    logger.debug("cleanup()", { kill, gracefulExitTimeoutElapsed });

    if (kill && this._isBeingKilled) {
      return;
    }

    if (kill) {
      this._isBeingKilled = true;
      this.onIsBeingKilled.post(this);
    }

    logger.debug("Cleaning up task run process", {
      kill,
      childPid: this._childPid,
      realChildPid: this._child?.pid,
    });

    try {
      await this._ipc?.sendWithAck(
        "CLEANUP",
        {
          flush: true,
          kill,
        },
        30_000
      );
    } catch (error) {
      logger.debug("Error while cleaning up task run process", error);

      if (kill) {
        this.onReadyToDispose.post(this);
      }
    }

    if (!kill) {
      return;
    }

    // Set a timeout to kill the child process if it hasn't been killed within 5 seconds
    setTimeout(() => {
      if (this._child && !this._child.killed) {
        logger.debug(`[${this.runId}] killing task run process after timeout`, { pid: this.pid });

        this._child.kill();
      }
    }, 5000);
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

  #kill() {
    logger.debug(`[${this.runId}] #kill()`, { pid: this.pid });

    if (this._child && !this._child.killed) {
      this._child?.kill();
    }
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
}

function executorArgs(workerManifest: WorkerManifest): string[] {
  return [];
}
