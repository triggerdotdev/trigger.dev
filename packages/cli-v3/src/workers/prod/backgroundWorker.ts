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
  TaskRunExecutionLazyAttemptPayload,
  TaskRunExecutionPayload,
  TaskRunExecutionResult,
  correctErrorStackTrace,
} from "@trigger.dev/core/v3";
import { ZodIpcConnection } from "@trigger.dev/core/v3/zodIpc";
import type { InferSocketMessageSchema } from "@trigger.dev/core/v3/zodSocket";
import { Evt } from "evt";
import { ChildProcess, fork } from "node:child_process";
import {
  CancelledProcessError,
  CleanupProcessError,
  GracefulExitTimeoutError,
  SigKillTimeoutProcessError,
  TaskMetadataParseError,
  UncaughtExceptionError,
  UnexpectedExitError,
  getFriendlyErrorMessage,
} from "../common/errors.js";

type BackgroundWorkerParams = {
  env: Record<string, string>;
  projectConfig: Config;
  contentHash: string;
  debugOtel?: boolean;
};

export type OnWaitForDurationMessage = InferSocketMessageSchema<
  typeof ProdChildToWorkerMessages,
  "WAIT_FOR_DURATION"
>;
export type OnWaitForTaskMessage = InferSocketMessageSchema<
  typeof ProdChildToWorkerMessages,
  "WAIT_FOR_TASK"
>;
export type OnWaitForBatchMessage = InferSocketMessageSchema<
  typeof ProdChildToWorkerMessages,
  "WAIT_FOR_BATCH"
>;

export class ProdBackgroundWorker {
  private _initialized: boolean = false;

  /**
   * @deprecated use onTaskRunHeartbeat instead
   */
  public onTaskHeartbeat: Evt<string> = new Evt();
  public onTaskRunHeartbeat: Evt<string> = new Evt();

  public onWaitForDuration: Evt<OnWaitForDurationMessage> = new Evt();
  public onWaitForTask: Evt<OnWaitForTaskMessage> = new Evt();
  public onWaitForBatch: Evt<OnWaitForBatchMessage> = new Evt();

  public onCreateTaskRunAttempt = Evt.create<{ version?: "v1"; runId: string }>();
  public attemptCreatedNotification = Evt.create<
    | {
        success: false;
        reason?: string;
      }
    | {
        success: true;
        execution: ProdTaskRunExecution;
      }
  >();

  private _onClose: Evt<void> = new Evt();

  public tasks: Array<TaskMetadataWithFilePath> = [];
  public stderr: Array<string> = [];

  _taskRunProcess: TaskRunProcess | undefined;
  private _taskRunProcessesBeingKilled: Map<number, TaskRunProcess> = new Map();

  private _closed: boolean = false;

  constructor(
    public path: string,
    private params: BackgroundWorkerParams
  ) {}

  async close(gracefulExitTimeoutElapsed = false) {
    console.log("Closing worker", { gracefulExitTimeoutElapsed, closed: this._closed });

    if (this._closed) {
      return;
    }

    this._closed = true;

    this.onTaskHeartbeat.detach();
    this.onTaskRunHeartbeat.detach();

    // We need to close the task run process
    await this._taskRunProcess?.cleanup(true, gracefulExitTimeoutElapsed);
  }

  async #killTaskRunProcess(flush = true, initialSignal: number | NodeJS.Signals = "SIGTERM") {
    console.log("Killing task run process", { flush, initialSignal, closed: this._closed });

    if (this._closed || !this._taskRunProcess) {
      return;
    }

    if (flush) {
      await this.flushTelemetry();
    }

    const currentTaskRunProcess = this._taskRunProcess;

    // Try graceful exit but don't wait. We limit the amount of processes during creation instead.
    this.#tryGracefulExit(currentTaskRunProcess, true, initialSignal).catch((error) => {
      console.error("Error while trying graceful exit", error);
    });

    console.log("Killed task run process, setting closed to true", {
      closed: this._closed,
      pid: currentTaskRunProcess.pid,
    });
    this._closed = true;
  }

  async flushTelemetry() {
    console.log("Flushing telemetry");
    const start = performance.now();

    await this._taskRunProcess?.cleanup(false);

    console.log("Flushed telemetry", { duration: performance.now() - start });
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

      child.stdout?.on("data", (data) => {
        console.log(data.toString());
      });

      child.stderr?.on("data", (data) => {
        console.error(data.toString());
        this.stderr.push(data.toString());
      });

      child.on("exit", (code) => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          reject(new Error(`Worker exited with code ${code}`));
        }
      });

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
  async taskRunCompletedNotification(completion: TaskRunExecutionResult) {
    this._taskRunProcess?.taskRunCompletedNotification(completion);
  }

  async waitCompletedNotification() {
    this._taskRunProcess?.waitCompletedNotification();
  }

  async #getFreshTaskRunProcess(
    payload: ProdTaskRunExecutionPayload,
    messageId?: string
  ): Promise<TaskRunProcess> {
    const metadata = this.getMetadata(
      payload.execution.worker.id,
      payload.execution.worker.version
    );

    console.log("Getting fresh task run process, setting closed to false", {
      closed: this._closed,
    });
    this._closed = false;

    await this.#killCurrentTaskRunProcessBeforeAttempt();

    const taskRunProcess = new TaskRunProcess(
      payload.execution.run.id,
      payload.execution.run.isTest,
      this.path,
      {
        ...this.params.env,
        ...(payload.environment ?? {}),
      },
      metadata,
      this.params,
      messageId
    );

    taskRunProcess.onExit.attach(({ pid }) => {
      console.log("Task run process exited", { pid });

      // Only delete the task run process if the pid matches
      if (this._taskRunProcess?.pid === pid) {
        this._taskRunProcess = undefined;
      }

      if (pid) {
        this._taskRunProcessesBeingKilled.delete(pid);
      }
    });

    taskRunProcess.onIsBeingKilled.attach((taskRunProcess) => {
      if (taskRunProcess?.pid) {
        this._taskRunProcessesBeingKilled.set(taskRunProcess.pid, taskRunProcess);
      }
    });

    taskRunProcess.onTaskHeartbeat.attach((id) => {
      this.onTaskHeartbeat.post(id);
    });

    taskRunProcess.onTaskRunHeartbeat.attach((id) => {
      this.onTaskRunHeartbeat.post(id);
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

    await taskRunProcess.initialize();

    this._taskRunProcess = taskRunProcess;

    return this._taskRunProcess;
  }

  async forceKillOldTaskRunProcesses() {
    for (const taskRunProcess of this._taskRunProcessesBeingKilled.values()) {
      try {
        await taskRunProcess.kill("SIGKILL");
      } catch (error) {
        console.error("Error while force killing old task run processes", error);
      }
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

    console.log("Killing current task run process", {
      isBeingKilled: currentTaskRunProcess?.isBeingKilled,
      totalBeingKilled: this._taskRunProcessesBeingKilled.size,
    });

    if (currentTaskRunProcess.isBeingKilled) {
      if (this._taskRunProcessesBeingKilled.size > 1) {
        await this.#tryGracefulExit(currentTaskRunProcess);
      } else {
        // If there's only one or none being killed, don't do anything so we can create a fresh one in parallel
      }
    } else {
      // It's not being killed, so kill it
      if (this._taskRunProcessesBeingKilled.size > 0) {
        await this.#tryGracefulExit(currentTaskRunProcess);
      } else {
        // There's none being killed yet, so we can kill it without waiting. We still set a timeout to kill it forcefully just in case it sticks around.
        currentTaskRunProcess.kill("SIGTERM", 5_000).catch(() => {});
      }
    }
  }

  async #tryGracefulExit(
    taskRunProcess: TaskRunProcess,
    kill = false,
    initialSignal: number | NodeJS.Signals = "SIGTERM"
  ) {
    console.log("Trying graceful exit", { kill, initialSignal });

    try {
      const initialExit = taskRunProcess.onExit.waitFor(5_000);

      if (kill) {
        taskRunProcess.kill(initialSignal);
      }

      await initialExit;
    } catch (error) {
      console.error("TaskRunProcess graceful kill timeout exceeded", error);

      this.#tryForcefulExit(taskRunProcess);
    }
  }

  async #tryForcefulExit(taskRunProcess: TaskRunProcess) {
    console.log("Trying forceful exit");

    try {
      const forcedKill = taskRunProcess.onExit.waitFor(5_000);
      taskRunProcess.kill("SIGKILL");
      await forcedKill;
    } catch (error) {
      console.error("TaskRunProcess forced kill timeout exceeded", error);
      throw new SigKillTimeoutProcessError();
    }
  }

  // We need to fork the process before we can execute any tasks, use a fresh process for each execution
  async executeTaskRun(
    payload: ProdTaskRunExecutionPayload,
    messageId?: string
  ): Promise<TaskRunExecutionResult> {
    try {
      const taskRunProcess = await this.#getFreshTaskRunProcess(payload, messageId);

      console.log("executing task run", {
        attempt: payload.execution.attempt.id,
        taskRunPid: taskRunProcess.pid,
      });

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
            message: getFriendlyErrorMessage(e.code, e.signal, e.stderr),
            stackTrace: e.stderr,
          },
        };
      }

      if (e instanceof SigKillTimeoutProcessError) {
        return {
          id: payload.execution.attempt.id,
          ok: false,
          retry: undefined,
          error: {
            type: "INTERNAL_ERROR",
            code: TaskRunErrorCodes.TASK_PROCESS_SIGKILL_TIMEOUT,
          },
        };
      }

      if (e instanceof GracefulExitTimeoutError) {
        return {
          id: payload.execution.attempt.id,
          ok: false,
          retry: undefined,
          error: {
            type: "INTERNAL_ERROR",
            code: TaskRunErrorCodes.GRACEFUL_EXIT_TIMEOUT,
            message: "Worker process killed while attempt in progress.",
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
    } finally {
      await this.#killTaskRunProcess();
    }
  }

  async cancelAttempt(attemptId: string) {
    if (!this._taskRunProcess) {
      console.error("No task run process to cancel attempt", { attemptId });
      return;
    }

    await this._taskRunProcess.cancel();
  }

  async executeTaskRunLazyAttempt(payload: TaskRunExecutionLazyAttemptPayload) {
    // Post to coordinator
    this.onCreateTaskRunAttempt.post({ runId: payload.runId });

    let execution: ProdTaskRunExecution;

    try {
      const start = performance.now();

      // ..and wait for response
      const attemptCreated = await this.attemptCreatedNotification.waitFor(120_000);

      if (!attemptCreated.success) {
        throw new Error(`${attemptCreated.reason ?? "Unknown error"}`);
      }

      console.log("Attempt created", {
        number: attemptCreated.execution.attempt.number,
        duration: performance.now() - start,
      });

      execution = attemptCreated.execution;
    } catch (error) {
      console.error("Error while creating attempt", error);
      throw new Error(`Failed to create attempt: ${error}`);
    }

    const completion = await this.executeTaskRun(
      {
        execution,
        traceContext: payload.traceContext,
        environment: payload.environment,
      },
      payload.messageId
    );

    return { execution, completion };
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
  private _childPid?: number;

  private _attemptPromises: Map<
    string,
    { resolver: (value: TaskRunExecutionResult) => void; rejecter: (err?: any) => void }
  > = new Map();
  private _attemptStatuses: Map<string, "PENDING" | "REJECTED" | "RESOLVED"> = new Map();
  private _currentExecution: TaskRunExecution | undefined;
  private _isBeingKilled: boolean = false;
  private _isBeingCancelled: boolean = false;
  private _gracefulExitTimeoutElapsed: boolean = false;
  private _stderr: Array<string> = [];

  /**
   * @deprecated use onTaskRunHeartbeat instead
   */
  public onTaskHeartbeat: Evt<string> = new Evt();
  public onTaskRunHeartbeat: Evt<string> = new Evt();
  public onExit: Evt<{ code: number | null; signal: NodeJS.Signals | null; pid?: number }> =
    new Evt();
  public onIsBeingKilled: Evt<TaskRunProcess> = new Evt();

  public onWaitForDuration: Evt<OnWaitForDurationMessage> = new Evt();
  public onWaitForTask: Evt<OnWaitForTaskMessage> = new Evt();
  public onWaitForBatch: Evt<OnWaitForBatchMessage> = new Evt();

  public preCheckpointNotification = Evt.create<{ willCheckpointAndRestore: boolean }>();

  constructor(
    private runId: string,
    private isTest: boolean,
    private path: string,
    private env: NodeJS.ProcessEnv,
    private metadata: BackgroundWorkerProperties,
    private worker: BackgroundWorkerParams,
    private messageId?: string
  ) {}

  async initialize() {
    this._child = fork(this.path, {
      stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
      env: {
        ...(this.isTest ? { TRIGGER_LOG_LEVEL: "debug" } : {}),
        ...this.env,
        OTEL_RESOURCE_ATTRIBUTES: JSON.stringify({
          [SemanticInternalAttributes.PROJECT_DIR]: this.worker.projectConfig.projectDir,
        }),
        ...(this.worker.debugOtel ? { OTEL_LOG_LEVEL: "debug" } : {}),
      },
    });

    this._childPid = this._child?.pid;

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
          if (this.messageId) {
            this.onTaskRunHeartbeat.post(this.messageId);
          } else {
            console.error(
              "No message id for task heartbeat, falling back to (deprecated) attempt heartbeat",
              { id: message.id }
            );
            this.onTaskHeartbeat.post(message.id);
          }
        },
        TASKS_READY: async (message) => {},
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

  async cancel() {
    this._isBeingCancelled = true;

    await this.cleanup(true);
  }

  async cleanup(kill = false, gracefulExitTimeoutElapsed = false) {
    console.log("cleanup()", { kill, gracefulExitTimeoutElapsed });

    if (kill && this._isBeingKilled) {
      return;
    }

    if (kill) {
      this._isBeingKilled = true;
      this.onIsBeingKilled.post(this);
    }

    const killChildProcess = gracefulExitTimeoutElapsed && !!this._currentExecution;

    // Kill parent unless graceful exit timeout has elapsed and we're in the middle of an execution
    const killParentProcess = kill && !killChildProcess;

    console.log("Cleaning up task run process", {
      killChildProcess,
      killParentProcess,
      ipc: this._ipc,
      childPid: this._childPid,
      realChildPid: this._child?.pid,
    });

    try {
      await this._ipc?.sendWithAck(
        "CLEANUP",
        {
          flush: true,
          kill: killParentProcess,
        },
        30_000
      );
    } catch (error) {
      console.error("Error while cleaning up task run process", error);
      if (killParentProcess) {
        process.exit(0);
      }
    }

    if (killChildProcess) {
      this._gracefulExitTimeoutElapsed = true;
      // Kill the child process
      await this.kill("SIGKILL");
    }
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

  taskRunCompletedNotification(completion: TaskRunExecutionResult) {
    if (!completion.ok && typeof completion.retry !== "undefined") {
      console.error(
        "Task run completed with error and wants to retry, won't send task run completed notification"
      );
      return;
    }

    if (!this._child?.connected || this._isBeingKilled || this._child.killed) {
      console.error(
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
    console.log("handling child exit", { code, signal });

    // Go through all the attempts currently pending and reject them
    for (const [id, status] of this._attemptStatuses.entries()) {
      if (status === "PENDING") {
        console.log("found pending attempt", { id });

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
    console.log(data.toString());
  }

  #handleStdErr(data: Buffer) {
    const text = data.toString();
    console.error(text);

    if (this._stderr.length > 100) {
      this._stderr.shift();
    }
    this._stderr.push(text);
  }

  async kill(signal?: number | NodeJS.Signals, timeoutInMs?: number) {
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
