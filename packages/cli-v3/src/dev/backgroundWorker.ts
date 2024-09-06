import {
  BuildManifest,
  CreateBackgroundWorkerResponse,
  ServerBackgroundWorker,
  TaskRunBuiltInError,
  TaskRunErrorCodes,
  TaskRunExecution,
  TaskRunExecutionPayload,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  WorkerManifest,
  correctErrorStackTrace,
} from "@trigger.dev/core/v3";
import { Evt } from "evt";

import { join } from "node:path";
import {
  CancelledProcessError,
  CleanupProcessError,
  SigKillTimeoutProcessError,
  UnexpectedExitError,
  getFriendlyErrorMessage,
} from "@trigger.dev/core/v3/errors";
import { TaskRunProcess, TaskRunProcessOptions } from "../executions/taskRunProcess.js";
import { indexWorkerManifest } from "../indexing/indexWorkerManifest.js";
import { prettyError } from "../utilities/cliOutput.js";
import { eventBus } from "../utilities/eventBus.js";
import { writeJSONFile } from "../utilities/fileSystem.js";
import { logger } from "../utilities/logger.js";
import { execOptionsForRuntime } from "@trigger.dev/core/v3/build";
import { sanitizeEnvVars } from "../utilities/sanitizeEnvVars.js";

export type CurrentWorkers = BackgroundWorkerCoordinator["currentWorkers"];
export class BackgroundWorkerCoordinator {
  public onTaskCompleted: Evt<{
    backgroundWorkerId: string;
    completion: TaskRunExecutionResult;
    worker: BackgroundWorker;
    execution: TaskRunExecution;
  }> = new Evt();
  public onTaskFailedToRun: Evt<{
    backgroundWorkerId: string;
    worker: BackgroundWorker;
    completion: TaskRunFailedExecutionResult;
  }> = new Evt();
  public onWorkerRegistered: Evt<{
    worker: BackgroundWorker;
    id: string;
    record: CreateBackgroundWorkerResponse;
  }> = new Evt();

  /**
   * @deprecated use onWorkerTaskRunHeartbeat instead
   */
  public onWorkerTaskHeartbeat: Evt<{
    id: string;
    backgroundWorkerId: string;
    worker: BackgroundWorker;
  }> = new Evt();
  public onWorkerTaskRunHeartbeat: Evt<{
    id: string;
    backgroundWorkerId: string;
    worker: BackgroundWorker;
  }> = new Evt();
  public onWorkerDeprecated: Evt<{ worker: BackgroundWorker; id: string }> = new Evt();
  private _backgroundWorkers: Map<string, BackgroundWorker> = new Map();

  constructor() {
    this.onTaskCompleted.attach(async ({ completion }) => {
      if (!completion.ok && typeof completion.retry !== "undefined") {
        return;
      }

      await this.#notifyWorkersOfTaskCompletion(completion);
    });

    this.onTaskFailedToRun.attach(async ({ completion }) => {
      await this.#notifyWorkersOfTaskCompletion(completion);
    });
  }

  async #notifyWorkersOfTaskCompletion(completion: TaskRunExecutionResult) {
    for (const worker of this._backgroundWorkers.values()) {
      await worker.taskRunCompletedNotification(completion);
    }
  }

  get currentWorkers() {
    return Array.from(this._backgroundWorkers.entries()).map(([id, worker]) => ({
      id,
      worker,
    }));
  }

  async cancelRun(id: string, taskRunId: string) {
    const worker = this._backgroundWorkers.get(id);

    if (!worker) {
      logger.error(`Could not find worker ${id}`);
      return;
    }

    await worker.cancelRun(taskRunId);
  }

  async registerWorker(worker: BackgroundWorker) {
    if (!worker.serverWorker) {
      return;
    }

    for (const [workerId, existingWorker] of this._backgroundWorkers.entries()) {
      if (workerId === worker.serverWorker.id) {
        continue;
      }

      existingWorker.deprecate();
      this.onWorkerDeprecated.post({ worker: existingWorker, id: workerId });
    }

    this._backgroundWorkers.set(worker.serverWorker.id, worker);
    this.onWorkerRegistered.post({
      worker,
      id: worker.serverWorker.id,
      record: worker.serverWorker,
    });

    worker.onTaskRunHeartbeat.attach((id) => {
      this.onWorkerTaskRunHeartbeat.post({
        id,
        backgroundWorkerId: worker.serverWorker!.id,
        worker,
      });
    });
  }

  close() {
    for (const worker of this._backgroundWorkers.values()) {
      worker.close();
    }

    this._backgroundWorkers.clear();
  }

  async executeTaskRun(id: string, payload: TaskRunExecutionPayload, messageId: string) {
    const worker = this._backgroundWorkers.get(id);

    if (!worker) {
      logger.error(`Could not find worker ${id}`);
      return;
    }

    try {
      const completion = await worker.executeTaskRun(payload, messageId);

      this.onTaskCompleted.post({
        completion,
        execution: payload.execution,
        worker,
        backgroundWorkerId: id,
      });

      return completion;
    } catch (error) {
      this.onTaskFailedToRun.post({
        backgroundWorkerId: id,
        worker,
        completion: {
          ok: false,
          id: payload.execution.run.id,
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
        },
      });
    }

    return;
  }
}

export type BackgroundWorkerOptions = {
  env: Record<string, string>;
  cwd: string;
};

export class BackgroundWorker {
  public onTaskRunHeartbeat: Evt<string> = new Evt();
  private _onClose: Evt<void> = new Evt();

  public deprecated: boolean = false;
  public manifest: WorkerManifest | undefined;
  public serverWorker: ServerBackgroundWorker | undefined;

  _taskRunProcesses: Map<string, TaskRunProcess> = new Map();
  private _taskRunProcessesBeingKilled: Map<number, TaskRunProcess> = new Map();

  private _closed: boolean = false;

  constructor(
    public build: BuildManifest,
    public params: BackgroundWorkerOptions
  ) {}

  deprecate() {
    this.deprecated = true;
  }

  close() {
    if (this._closed) {
      return;
    }

    this._closed = true;

    this.onTaskRunHeartbeat.detach();

    // We need to close all the task run processes
    for (const taskRunProcess of this._taskRunProcesses.values()) {
      taskRunProcess.cleanup(true);
    }

    // Delete worker files
    this._onClose.post();
  }

  get inProgressRuns(): Array<string> {
    return Array.from(this._taskRunProcesses.keys());
  }

  get workerManifestPath(): string {
    return join(this.build.outputPath, "index.json");
  }

  get buildManifestPath(): string {
    return join(this.build.outputPath, "build.json");
  }

  async initialize() {
    if (this.manifest) {
      throw new Error("Worker already initialized");
    }

    // Write the build manifest to this.build.outputPath/build.json
    await writeJSONFile(this.buildManifestPath, this.build, true);

    logger.debug("indexing worker manifest", { build: this.build, params: this.params });

    this.manifest = await indexWorkerManifest({
      runtime: this.build.runtime,
      indexWorkerPath: this.build.indexWorkerEntryPoint,
      buildManifestPath: this.buildManifestPath,
      nodeOptions: execOptionsForRuntime(this.build.runtime, this.build),
      env: this.params.env,
      cwd: this.params.cwd,
      otelHookInclude: this.build.otelImportHook?.include,
      otelHookExclude: this.build.otelImportHook?.exclude,
      handleStdout(data) {
        logger.debug(data);
      },
      handleStderr(data) {
        if (!data.includes("Debugger attached")) {
          prettyError(data.toString());
        }
      },
    });

    // Write the build manifest to this.build.outputPath/worker.json
    await writeJSONFile(this.workerManifestPath, this.manifest, true);

    logger.debug("worker manifest indexed", { path: this.build.outputPath });
  }

  // We need to notify all the task run processes that a task run has completed,
  // in case they are waiting for it through triggerAndWait
  async taskRunCompletedNotification(completion: TaskRunExecutionResult) {
    for (const taskRunProcess of this._taskRunProcesses.values()) {
      taskRunProcess.taskRunCompletedNotification(completion);
    }
  }

  #prefixedMessage(payload: TaskRunExecutionPayload, message: string = "") {
    return `[${payload.execution.run.id}.${payload.execution.attempt.number}] ${message}`;
  }

  async #getFreshTaskRunProcess(
    payload: TaskRunExecutionPayload,
    messageId: string
  ): Promise<TaskRunProcess> {
    logger.debug(this.#prefixedMessage(payload, "getFreshTaskRunProcess()"));

    if (!this.serverWorker) {
      throw new Error("Worker not registered");
    }

    if (!this.manifest) {
      throw new Error("Worker not initialized");
    }

    this._closed = false;

    logger.debug(this.#prefixedMessage(payload, "killing current task run process before attempt"));

    await this.#killCurrentTaskRunProcessBeforeAttempt(payload.execution.run.id);

    logger.debug(this.#prefixedMessage(payload, "creating new task run process"));

    const processOptions: TaskRunProcessOptions = {
      payload,
      env: {
        ...sanitizeEnvVars(this.params.env),
        // TODO: this needs the stripEmptyValues stuff too
        ...sanitizeEnvVars(payload.environment ?? {}),
        TRIGGER_WORKER_MANIFEST_PATH: this.workerManifestPath,
      },
      serverWorker: this.serverWorker,
      workerManifest: this.manifest,
      messageId,
    };

    const taskRunProcess = new TaskRunProcess(processOptions);

    taskRunProcess.onExit.attach(({ pid }) => {
      logger.debug(this.#prefixedMessage(payload, "onExit()"), { pid });

      const taskRunProcess = this._taskRunProcesses.get(payload.execution.run.id);

      // Only delete the task run process if the pid matches
      if (taskRunProcess?.pid === pid) {
        this._taskRunProcesses.delete(payload.execution.run.id);
      }

      if (pid) {
        this._taskRunProcessesBeingKilled.delete(pid);
      }
    });

    taskRunProcess.onIsBeingKilled.attach((taskRunProcess) => {
      if (taskRunProcess.pid) {
        this._taskRunProcessesBeingKilled.set(taskRunProcess.pid, taskRunProcess);
      }
    });

    taskRunProcess.onTaskRunHeartbeat.attach((id) => {
      this.onTaskRunHeartbeat.post(id);
    });

    taskRunProcess.onReadyToDispose.attach(async () => {
      await taskRunProcess.kill();
    });

    await taskRunProcess.initialize();

    this._taskRunProcesses.set(payload.execution.run.id, taskRunProcess);

    return taskRunProcess;
  }

  async #killCurrentTaskRunProcessBeforeAttempt(runId: string) {
    const taskRunProcess = this._taskRunProcesses.get(runId);

    if (!taskRunProcess) {
      logger.debug(`[${runId}] no current task process to kill`);
      return;
    }

    logger.debug(`[${runId}] killing current task process`, {
      pid: taskRunProcess.pid,
    });

    if (taskRunProcess.isBeingKilled) {
      if (this._taskRunProcessesBeingKilled.size > 1) {
        await this.#tryGracefulExit(taskRunProcess);
      } else {
        // If there's only one or none being killed, don't do anything so we can create a fresh one in parallel
      }
    } else {
      // It's not being killed, so kill it
      if (this._taskRunProcessesBeingKilled.size > 0) {
        await this.#tryGracefulExit(taskRunProcess);
      } else {
        // There's none being killed yet, so we can kill it without waiting. We still set a timeout to kill it forcefully just in case it sticks around.
        taskRunProcess.kill("SIGTERM", 5_000).catch(() => {});
      }
    }
  }

  async #tryGracefulExit(
    taskRunProcess: TaskRunProcess,
    kill = false,
    initialSignal: number | NodeJS.Signals = "SIGTERM"
  ) {
    try {
      const initialExit = taskRunProcess.onExit.waitFor(5_000);

      if (kill) {
        taskRunProcess.kill(initialSignal);
      }

      await initialExit;
    } catch (error) {
      logger.error("TaskRunProcess graceful kill timeout exceeded", error);

      this.#tryForcefulExit(taskRunProcess);
    }
  }

  async #tryForcefulExit(taskRunProcess: TaskRunProcess) {
    try {
      const forcedKill = taskRunProcess.onExit.waitFor(5_000);
      taskRunProcess.kill("SIGKILL");
      await forcedKill;
    } catch (error) {
      logger.error("TaskRunProcess forced kill timeout exceeded", error);
      throw new SigKillTimeoutProcessError();
    }
  }

  async cancelRun(taskRunId: string) {
    const taskRunProcess = this._taskRunProcesses.get(taskRunId);

    if (!taskRunProcess) {
      return;
    }

    await taskRunProcess.cancel();
  }

  // We need to fork the process before we can execute any tasks
  async executeTaskRun(
    payload: TaskRunExecutionPayload,
    messageId: string
  ): Promise<TaskRunExecutionResult> {
    if (this._closed) {
      throw new Error("Worker is closed");
    }

    if (!this.manifest) {
      throw new Error("Worker not initialized");
    }

    if (!this.serverWorker) {
      throw new Error("Worker not registered");
    }

    eventBus.emit("runStarted", this, payload);

    const now = performance.now();

    const completion = await this.#doExecuteTaskRun(payload, messageId);

    const elapsed = performance.now() - now;

    eventBus.emit("runCompleted", this, payload, completion, elapsed);

    return completion;
  }

  async #doExecuteTaskRun(
    payload: TaskRunExecutionPayload,
    messageId: string
  ): Promise<TaskRunExecutionResult> {
    try {
      const taskRunProcess = await this.#getFreshTaskRunProcess(payload, messageId);

      logger.debug(this.#prefixedMessage(payload, "executing task run"), {
        pid: taskRunProcess.pid,
      });

      const result = await taskRunProcess.execute();

      // Always kill the worker
      await taskRunProcess.cleanup(true);

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
          id: payload.execution.run.id,
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
          id: payload.execution.run.id,
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
          id: payload.execution.run.id,
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

      return {
        id: payload.execution.run.id,
        ok: false,
        retry: undefined,
        error: {
          type: "INTERNAL_ERROR",
          code: TaskRunErrorCodes.TASK_EXECUTION_FAILED,
          message: String(e),
        },
      };
    }
  }

  async #correctError(
    error: TaskRunBuiltInError,
    execution: TaskRunExecution
  ): Promise<TaskRunBuiltInError> {
    return {
      ...error,
      stackTrace: correctErrorStackTrace(error.stackTrace, this.params.cwd),
    };
  }
}
