import {
  BackgroundWorkerProperties,
  CreateBackgroundWorkerResponse,
  ProdTaskRunExecutionPayload,
  SemanticInternalAttributes,
  TaskMetadataWithFilePath,
  TaskRunBuiltInError,
  TaskRunExecution,
  TaskRunExecutionPayload,
  TaskRunExecutionResult,
  ZodMessageHandler,
  ZodMessageSender,
  childToWorkerMessages,
  correctErrorStackTrace,
  workerToChildMessages,
} from "@trigger.dev/core/v3";
import { Evt } from "evt";
import { ChildProcess, fork } from "node:child_process";
import { unlinkSync } from "node:fs";

type BackgroundWorkerParams = {
  env: Record<string, string>;
  projectDir: string;
  contentHash: string;
};

export class ProdBackgroundWorker {
  private _initialized: boolean = false;
  private _handler = new ZodMessageHandler({
    schema: childToWorkerMessages,
  });

  public onTaskHeartbeat: Evt<string> = new Evt();

  public onWaitForBatch: Evt<{ version?: "v1"; id: string; runs: string[] }> = new Evt();
  public onWaitForDuration: Evt<{ version?: "v1"; ms: number }> = new Evt();
  public onWaitForTask: Evt<{ version?: "v1"; id: string }> = new Evt();

  private _onClose: Evt<void> = new Evt();

  public tasks: Array<TaskMetadataWithFilePath> = [];

  _taskRunProcesses: Map<string, TaskRunProcess> = new Map();

  constructor(
    public path: string,
    private params: BackgroundWorkerParams
  ) {}

  close() {
    this.onTaskHeartbeat.detach();

    // We need to close all the task run processes
    for (const taskRunProcess of this._taskRunProcesses.values()) {
      taskRunProcess.cleanup(true);
    }

    // Delete worker files
    this._onClose.post();

    unlinkSync(this.path);
    unlinkSync(`${this.path}.map`);
  }

  async initialize() {
    if (this._initialized) {
      throw new Error("Worker already initialized");
    }

    let resolved = false;

    this.tasks = await new Promise<Array<TaskMetadataWithFilePath>>((resolve, reject) => {
      const child = fork(this.path, {
        stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
        env: {
          ...this.params.env,
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
      }, 1000);

      child.on("message", async (msg: any) => {
        const message = this._handler.parseMessage(msg);

        if (message.type === "TASKS_READY" && !resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve(message.payload.tasks);
          child.kill();
        }
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
    for (const taskRunProcess of this._taskRunProcesses.values()) {
      taskRunProcess.taskRunCompletedNotification(completion, execution);
    }
  }

  async #initializeTaskRunProcess(payload: ProdTaskRunExecutionPayload): Promise<TaskRunProcess> {
    const metadata = this.getMetadata(
      payload.execution.worker.id,
      payload.execution.worker.version
    );

    if (!this._taskRunProcesses.has(payload.execution.run.id)) {
      const taskRunProcess = new TaskRunProcess(
        this.path,
        {
          ...this.params.env,
          ...(payload.environment ?? {}),
        },
        metadata,
        this.params
      );

      taskRunProcess.onExit.attach(() => {
        this._taskRunProcesses.delete(payload.execution.run.id);
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

      await taskRunProcess.initialize();

      this._taskRunProcesses.set(payload.execution.run.id, taskRunProcess);
    }

    return this._taskRunProcesses.get(payload.execution.run.id) as TaskRunProcess;
  }

  // We need to fork the process before we can execute any tasks
  async executeTaskRun(payload: ProdTaskRunExecutionPayload): Promise<TaskRunExecutionResult> {
    const taskRunProcess = await this.#initializeTaskRunProcess(payload);

    const result = await taskRunProcess.executeTaskRun(payload);

    // Kill the worker if the task was successful or if it's not going to be retried);
    await taskRunProcess.cleanup(result.ok || result.retry === undefined);

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
  }

  async #correctError(
    error: TaskRunBuiltInError,
    execution: TaskRunExecution
  ): Promise<TaskRunBuiltInError> {
    return {
      ...error,
      stackTrace: correctErrorStackTrace(error.stackTrace, this.params.projectDir),
    };
  }
}

class TaskRunProcess {
  private _handler = new ZodMessageHandler({
    schema: childToWorkerMessages,
  });
  private _sender: ZodMessageSender<typeof workerToChildMessages>;
  private _child: ChildProcess | undefined;
  private _attemptPromises: Map<
    string,
    { resolver: (value: TaskRunExecutionResult) => void; rejecter: (err?: any) => void }
  > = new Map();
  private _attemptStatuses: Map<string, "PENDING" | "REJECTED" | "RESOLVED"> = new Map();
  private _currentExecution: TaskRunExecution | undefined;
  private _isBeingKilled: boolean = false;

  public onTaskHeartbeat: Evt<string> = new Evt();
  public onExit: Evt<number> = new Evt();

  public onWaitForBatch: Evt<{ version?: "v1"; id: string; runs: string[] }> = new Evt();
  public onWaitForDuration: Evt<{ version?: "v1"; ms: number }> = new Evt();
  public onWaitForTask: Evt<{ version?: "v1"; id: string }> = new Evt();

  constructor(
    private path: string,
    private env: NodeJS.ProcessEnv,
    private metadata: BackgroundWorkerProperties,
    private worker: BackgroundWorkerParams
  ) {
    this._sender = new ZodMessageSender({
      schema: workerToChildMessages,
      sender: async (message) => {
        if (this._child?.connected && !this._isBeingKilled && !this._child.killed) {
          this._child?.send?.(message);
        }
      },
    });
  }

  async initialize() {
    this._child = fork(this.path, {
      stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
      env: {
        ...this.env,
        OTEL_RESOURCE_ATTRIBUTES: JSON.stringify({
          [SemanticInternalAttributes.PROJECT_DIR]: this.worker.projectDir,
        }),
      },
    });

    this._child.on("message", this.#handleMessage.bind(this));
    this._child.on("exit", this.#handleExit.bind(this));
    this._child.stdout?.on("data", this.#handleLog.bind(this));
    this._child.stderr?.on("data", this.#handleStdErr.bind(this));
  }

  async cleanup(kill: boolean = false) {
    if (kill && this._isBeingKilled) {
      return;
    }

    await this._sender.send("CLEANUP", {
      flush: true,
      kill,
    });

    this._isBeingKilled = kill;
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

    await this._sender.send("EXECUTE_TASK_RUN", {
      execution,
      traceContext,
      metadata: this.metadata,
    });

    const result = await promise;

    this._currentExecution = undefined;

    return result;
  }

  taskRunCompletedNotification(completion: TaskRunExecutionResult, execution: TaskRunExecution) {
    if (!completion.ok && typeof completion.retry === "undefined") {
      return;
    }
    this._sender.send("TASK_RUN_COMPLETED_NOTIFICATION", {
      completion,
      execution,
    });
  }

  async #handleMessage(msg: any) {
    const message = this._handler.parseMessage(msg);

    switch (message.type) {
      case "TASK_RUN_COMPLETED": {
        const { result, execution } = message.payload;

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

        break;
      }
      case "READY_TO_DISPOSE": {
        this.#kill();

        break;
      }
      case "TASK_HEARTBEAT": {
        this.onTaskHeartbeat.post(message.payload.id);

        break;
      }
      case "TASKS_READY": {
        break;
      }
      case "WAIT_FOR_BATCH": {
        this.onWaitForBatch.post(message.payload);

        break;
      }
      case "WAIT_FOR_DURATION": {
        this.onWaitForDuration.post(message.payload);

        break;
      }
      case "WAIT_FOR_TASK": {
        this.onWaitForTask.post(message.payload);

        break;
      }
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

        rejecter(new Error(`Worker exited with code ${code}`));
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
