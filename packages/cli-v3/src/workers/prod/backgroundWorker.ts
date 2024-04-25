import {
  BackgroundWorkerProperties,
  Config,
  CreateBackgroundWorkerResponse,
  ProdChildToWorkerMessages,
  ProdTaskRunExecution,
  ProdTaskRunExecutionPayload,
  ProdWorkerToChildMessages,
  SemanticInternalAttributes,
  TaskMetadataWithFilePath,
  TaskRunBuiltInError,
  TaskRunErrorCodes,
  TaskRunExecution,
  TaskRunExecutionPayload,
  TaskRunExecutionResult,
  WaitReason,
  correctErrorStackTrace,
} from "@trigger.dev/core/v3";
import { ZodIpcConnection } from "@trigger.dev/core/v3/zodIpc";
import type { InferSocketMessageSchema } from "@trigger.dev/core/v3/zodSocket";
import { Evt } from "evt";
import { ChildProcess, fork } from "node:child_process";
import { TaskMetadataParseError, UncaughtExceptionError } from "../common/errors";

class UnexpectedExitError extends Error {
  constructor(public code: number) {
    super(`Unexpected exit with code ${code}`);

    this.name = "UnexpectedExitError";
  }
}

class CleanupProcessError extends Error {
  constructor() {
    super("Cancelled");

    this.name = "CleanupProcessError";
  }
}

class CancelledProcessError extends Error {
  constructor() {
    super("Cancelled");

    this.name = "CancelledProcessError";
  }
}

type BackgroundWorkerParams = {
  env: Record<string, string>;
  projectConfig: Config;
  contentHash: string;
  debugOtel?: boolean;
};

export class ProdBackgroundWorker {
  private _initialized: boolean = false;

  public onTaskHeartbeat: Evt<string> = new Evt();

  public onWaitForBatch: Evt<
    InferSocketMessageSchema<typeof ProdChildToWorkerMessages, "WAIT_FOR_BATCH">
  > = new Evt();
  public onWaitForDuration: Evt<
    InferSocketMessageSchema<typeof ProdChildToWorkerMessages, "WAIT_FOR_DURATION">
  > = new Evt();
  public onWaitForTask: Evt<
    InferSocketMessageSchema<typeof ProdChildToWorkerMessages, "WAIT_FOR_TASK">
  > = new Evt();

  public preCheckpointNotification = Evt.create<{ willCheckpointAndRestore: boolean }>();
  public checkpointCanceledNotification = Evt.create<{ checkpointCanceled: boolean }>();

  public onReadyForCheckpoint = Evt.create<{ version?: "v1" }>();
  public onCancelCheckpoint = Evt.create<{ version?: "v1" | "v2"; reason?: WaitReason }>();

  private _onClose: Evt<void> = new Evt();

  public tasks: Array<TaskMetadataWithFilePath> = [];

  _taskRunProcess: TaskRunProcess | undefined;

  private _closed: boolean = false;

  constructor(
    public path: string,
    private params: BackgroundWorkerParams
  ) {}

  async close() {
    if (this._closed) {
      return;
    }

    this._closed = true;

    this.onTaskHeartbeat.detach();

    // We need to close the task run process
    await this._taskRunProcess?.cleanup(true);
  }

  async flushTelemetry() {
    await this._taskRunProcess?.cleanup(false);
  }

  async initialize(options?: { env?: Record<string, string> }) {
    if (this._initialized) {
      throw new Error("Worker already initialized");
    }

    let resolved = false;

    this.tasks = await new Promise<Array<TaskMetadataWithFilePath>>((resolve, reject) => {
      const child = fork(this.path, {
        stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
        env: {
          ...this.params.env,
          ...options?.env,
        },
      });

      // Set a timeout to kill the child process if it doesn't respond
      const timeout = setTimeout(() => {
        if (resolved) {
          return;
        }

        resolved = true;
        child.kill();
        reject(new Error("Worker timed out"));
      }, 10_000);

      new ZodIpcConnection({
        listenSchema: ProdChildToWorkerMessages,
        emitSchema: ProdWorkerToChildMessages,
        process: child,
        handlers: {
          TASKS_READY: async (message) => {
            if (!resolved) {
              clearTimeout(timeout);
              resolved = true;
              resolve(message.tasks);
              child.kill();
            }
          },
          UNCAUGHT_EXCEPTION: async (message) => {
            if (!resolved) {
              clearTimeout(timeout);
              resolved = true;
              reject(new UncaughtExceptionError(message.error, message.origin));
              child.kill();
            }
          },
          TASKS_FAILED_TO_PARSE: async (message) => {
            if (!resolved) {
              clearTimeout(timeout);
              resolved = true;
              reject(new TaskMetadataParseError(message.zodIssues, message.tasks));
              child.kill();
            }
          },
        },
      });

      child.stdout?.on("data", (data) => {
        console.log(data.toString());
      });

      child.stderr?.on("data", (data) => {
        console.error(data.toString());
      });

      child.on("exit", (code) => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          reject(new Error(`Worker exited with code ${code}`));
        }
      });
    });

    this._initialized = true;
  }

  getMetadata(workerId: string, version: string): CreateBackgroundWorkerResponse {
    return {
      contentHash: this.params.contentHash,
      id: workerId,
      version: version,
    };
  }

  // We need to notify all the task run processes that a task run has completed,
  // in case they are waiting for it through triggerAndWait
  async taskRunCompletedNotification(
    completion: TaskRunExecutionResult,
    execution: TaskRunExecution
  ) {
    this._taskRunProcess?.taskRunCompletedNotification(completion, execution);
  }

  async waitCompletedNotification() {
    this._taskRunProcess?.waitCompletedNotification();
  }

  async #initializeTaskRunProcess(payload: ProdTaskRunExecutionPayload): Promise<TaskRunProcess> {
    const metadata = this.getMetadata(
      payload.execution.worker.id,
      payload.execution.worker.version
    );

    if (!this._taskRunProcess) {
      const taskRunProcess = new TaskRunProcess(
        payload.execution,
        this.path,
        {
          ...this.params.env,
          ...(payload.environment ?? {}),
        },
        metadata,
        this.params
      );

      taskRunProcess.onExit.attach(() => {
        this._taskRunProcess = undefined;
      });

      taskRunProcess.onTaskHeartbeat.attach((id) => {
        this.onTaskHeartbeat.post(id);
      });

      taskRunProcess.onWaitForBatch.attach((message) => {
        this.onWaitForBatch.post(message);
      });

      taskRunProcess.onWaitForDuration.attach((message) => {
        this.onWaitForDuration.post(message);
      });

      taskRunProcess.onWaitForTask.attach((message) => {
        this.onWaitForTask.post(message);
      });

      taskRunProcess.onReadyForCheckpoint.attach((message) => {
        this.onReadyForCheckpoint.post(message);
      });

      taskRunProcess.onCancelCheckpoint.attach((message) => {
        this.onCancelCheckpoint.post(message);
      });

      // Notify down the chain
      this.preCheckpointNotification.attach((message) => {
        taskRunProcess.preCheckpointNotification.post(message);
      });
      this.checkpointCanceledNotification.attach((message) => {
        taskRunProcess.checkpointCanceledNotification.post(message);
      });

      await taskRunProcess.initialize();

      this._taskRunProcess = taskRunProcess;
    }

    return this._taskRunProcess;
  }

  // We need to fork the process before we can execute any tasks
  async executeTaskRun(payload: ProdTaskRunExecutionPayload): Promise<TaskRunExecutionResult> {
    try {
      const taskRunProcess = await this.#initializeTaskRunProcess(payload);

      const result = await taskRunProcess.executeTaskRun(payload);

      if (result.ok) {
        return result;
      }

      const error = result.error;

      if (error.type === "BUILT_IN_ERROR") {
        const mappedError = await this.#correctError(error, payload.execution);

        return {
          ...result,
          error: mappedError,
        };
      }

      return result;
    } catch (e) {
      if (e instanceof CancelledProcessError) {
        return {
          id: payload.execution.attempt.id,
          ok: false,
          retry: undefined,
          error: {
            type: "INTERNAL_ERROR",
            code: TaskRunErrorCodes.TASK_RUN_CANCELLED,
          },
        };
      }

      if (e instanceof CleanupProcessError) {
        return {
          id: payload.execution.attempt.id,
          ok: false,
          retry: undefined,
          error: {
            type: "INTERNAL_ERROR",
            code: TaskRunErrorCodes.TASK_EXECUTION_ABORTED,
          },
        };
      }

      if (e instanceof UnexpectedExitError) {
        return {
          id: payload.execution.attempt.id,
          ok: false,
          retry: undefined,
          error: {
            type: "INTERNAL_ERROR",
            code: TaskRunErrorCodes.TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE,
          },
        };
      }

      return {
        id: payload.execution.attempt.id,
        ok: false,
        retry: undefined,
        error: {
          type: "INTERNAL_ERROR",
          code: TaskRunErrorCodes.TASK_EXECUTION_FAILED,
        },
      };
    }
  }

  async cancelAttempt(attemptId: string) {
    await this._taskRunProcess?.cancel();
  }

  async #correctError(
    error: TaskRunBuiltInError,
    execution: TaskRunExecution
  ): Promise<TaskRunBuiltInError> {
    return {
      ...error,
      stackTrace: correctErrorStackTrace(error.stackTrace, this.params.projectConfig.projectDir),
    };
  }
}

class TaskRunProcess {
  private _ipc?: ZodIpcConnection<
    typeof ProdChildToWorkerMessages,
    typeof ProdWorkerToChildMessages
  >;
  private _child?: ChildProcess;

  private _attemptPromises: Map<
    string,
    { resolver: (value: TaskRunExecutionResult) => void; rejecter: (err?: any) => void }
  > = new Map();
  private _attemptStatuses: Map<string, "PENDING" | "REJECTED" | "RESOLVED"> = new Map();
  private _currentExecution: TaskRunExecution | undefined;
  private _isBeingKilled: boolean = false;
  private _isBeingCancelled: boolean = false;

  public onTaskHeartbeat: Evt<string> = new Evt();
  public onExit: Evt<number> = new Evt();

  public onWaitForBatch: Evt<
    InferSocketMessageSchema<typeof ProdChildToWorkerMessages, "WAIT_FOR_BATCH">
  > = new Evt();
  public onWaitForDuration: Evt<
    InferSocketMessageSchema<typeof ProdChildToWorkerMessages, "WAIT_FOR_DURATION">
  > = new Evt();
  public onWaitForTask: Evt<
    InferSocketMessageSchema<typeof ProdChildToWorkerMessages, "WAIT_FOR_TASK">
  > = new Evt();

  public preCheckpointNotification = Evt.create<{ willCheckpointAndRestore: boolean }>();
  public checkpointCanceledNotification = Evt.create<{ checkpointCanceled: boolean }>();

  public onReadyForCheckpoint = Evt.create<{ version?: "v1" }>();
  public onCancelCheckpoint = Evt.create<{ version?: "v1" | "v2"; reason?: WaitReason }>();

  constructor(
    private execution: ProdTaskRunExecution,
    private path: string,
    private env: NodeJS.ProcessEnv,
    private metadata: BackgroundWorkerProperties,
    private worker: BackgroundWorkerParams
  ) {}

  async initialize() {
    this._child = fork(this.path, {
      stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
      env: {
        ...(this.execution.run.isTest ? { TRIGGER_LOG_LEVEL: "debug" } : {}),
        ...this.env,
        OTEL_RESOURCE_ATTRIBUTES: JSON.stringify({
          [SemanticInternalAttributes.PROJECT_DIR]: this.worker.projectConfig.projectDir,
        }),
        ...(this.worker.debugOtel ? { OTEL_LOG_LEVEL: "debug" } : {}),
      },
    });

    this._ipc = new ZodIpcConnection({
      listenSchema: ProdChildToWorkerMessages,
      emitSchema: ProdWorkerToChildMessages,
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
          process.exit(0);
        },
        TASK_HEARTBEAT: async (message) => {
          this.onTaskHeartbeat.post(message.id);
        },
        TASKS_READY: async (message) => {},
        WAIT_FOR_BATCH: async (message) => {
          this.onWaitForBatch.post(message);
        },
        WAIT_FOR_DURATION: async (message) => {
          // Post to coordinator
          this.onWaitForDuration.post(message);

          try {
            // ..and wait for response
            const { willCheckpointAndRestore } = await this.preCheckpointNotification.waitFor(
              30_000
            );

            return {
              willCheckpointAndRestore,
            };
          } catch (error) {
            console.error("Error while waiting for pre-checkpoint notification", error);

            // Assume we won't get checkpointed
            return {
              willCheckpointAndRestore: false,
            };
          }
        },
        WAIT_FOR_TASK: async (message) => {
          this.onWaitForTask.post(message);
        },
        READY_FOR_CHECKPOINT: async (message) => {
          this.onReadyForCheckpoint.post(message);
        },
        CANCEL_CHECKPOINT: async (message) => {
          const version = "v2";

          // Post to coordinator
          this.onCancelCheckpoint.post(message);

          try {
            // ..and wait for response
            const { checkpointCanceled } = await this.checkpointCanceledNotification.waitFor(
              30_000
            );

            return {
              version,
              checkpointCanceled,
            };
          } catch (error) {
            console.error("Error while waiting for checkpoint cancellation", error);

            // Assume it's been canceled
            return {
              version,
              checkpointCanceled: true,
            };
          }
        },
      },
    });

    this._child.on("exit", this.#handleExit.bind(this));
    this._child.stdout?.on("data", this.#handleLog.bind(this));
    this._child.stderr?.on("data", this.#handleStdErr.bind(this));
  }

  async cancel() {
    this._isBeingCancelled = true;

    await this.cleanup(true);
  }

  async cleanup(kill: boolean = false) {
    if (kill && this._isBeingKilled) {
      return;
    }

    this._isBeingKilled = kill;

    await this._ipc?.sendWithAck("CLEANUP", {
      flush: true,
      kill,
    });
  }

  async executeTaskRun(payload: TaskRunExecutionPayload): Promise<TaskRunExecutionResult> {
    let resolver: (value: TaskRunExecutionResult) => void;
    let rejecter: (err?: any) => void;

    const promise = new Promise<TaskRunExecutionResult>((resolve, reject) => {
      resolver = resolve;
      rejecter = reject;
    });

    this._attemptStatuses.set(payload.execution.attempt.id, "PENDING");

    // @ts-expect-error - We know that the resolver and rejecter are defined
    this._attemptPromises.set(payload.execution.attempt.id, { resolver, rejecter });

    const { execution, traceContext } = payload;

    this._currentExecution = execution;

    if (this._child?.connected && !this._isBeingKilled && !this._child.killed) {
      await this._ipc?.send("EXECUTE_TASK_RUN", {
        execution,
        traceContext,
        metadata: this.metadata,
      });
    }

    const result = await promise;

    this._currentExecution = undefined;

    return result;
  }

  taskRunCompletedNotification(completion: TaskRunExecutionResult, execution: TaskRunExecution) {
    if (!completion.ok && typeof completion.retry !== "undefined") {
      return;
    }

    if (this._child?.connected && !this._isBeingKilled && !this._child.killed) {
      this._ipc?.send("TASK_RUN_COMPLETED_NOTIFICATION", {
        completion,
        execution,
      });
    }
  }

  waitCompletedNotification() {
    if (this._child?.connected && !this._isBeingKilled && !this._child.killed) {
      this._ipc?.send("WAIT_COMPLETED_NOTIFICATION", {});
    }
  }

  async #handleExit(code: number) {
    // Go through all the attempts currently pending and reject them
    for (const [id, status] of this._attemptStatuses.entries()) {
      if (status === "PENDING") {
        this._attemptStatuses.set(id, "REJECTED");

        const attemptPromise = this._attemptPromises.get(id);

        if (!attemptPromise) {
          continue;
        }

        const { rejecter } = attemptPromise;

        if (this._isBeingCancelled) {
          rejecter(new CancelledProcessError());
        } else if (this._isBeingKilled) {
          rejecter(new CleanupProcessError());
        } else {
          rejecter(new UnexpectedExitError(code));
        }
      }
    }

    this.onExit.post(code);
  }

  #handleLog(data: Buffer) {
    if (!this._currentExecution) {
      return;
    }

    console.log(
      `[${this.metadata.version}][${this._currentExecution.run.id}.${
        this._currentExecution.attempt.number
      }] ${data.toString()}`
    );
  }

  #handleStdErr(data: Buffer) {
    if (this._isBeingKilled) {
      return;
    }

    if (!this._currentExecution) {
      console.error(`[${this.metadata.version}] ${data.toString()}`);

      return;
    }

    console.error(
      `[${this.metadata.version}][${this._currentExecution.run.id}.${
        this._currentExecution.attempt.number
      }] ${data.toString()}`
    );
  }

  #kill() {
    if (this._child && !this._child.killed) {
      this._child?.kill();
    }
  }
}
