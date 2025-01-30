import {
    BuildManifest,
    ServerBackgroundWorker,
    TaskRunBuiltInError,
    TaskRunExecutionPayload,
    TaskRunExecutionResult,
    WorkerManifest,
    correctErrorStackTrace
} from "@trigger.dev/core/v3";
import { execOptionsForRuntime } from "@trigger.dev/core/v3/build";
import { SigKillTimeoutProcessError } from "@trigger.dev/core/v3/errors";
import { Evt } from "evt";
import { join } from "node:path";
import { TaskRunProcess, TaskRunProcessOptions } from "../executions/taskRunProcess.js";
import { indexWorkerManifest } from "../indexing/indexWorkerManifest.js";
import { prettyError } from "../utilities/cliOutput.js";
import { eventBus } from "../utilities/eventBus.js";
import { writeJSONFile } from "../utilities/fileSystem.js";
import { logger } from "../utilities/logger.js";
import { sanitizeEnvVars } from "../utilities/sanitizeEnvVars.js";

export type BackgroundWorkerEngine2Options = {
  env: Record<string, string>;
  cwd: string;
  stop: () => void;
};

export class BackgroundWorkerEngine2 {
  public onTaskRunHeartbeat: Evt<string> = new Evt();

  public deprecated: boolean = false;
  public manifest: WorkerManifest | undefined;
  public serverWorker: ServerBackgroundWorker | undefined;

  _taskRunProcesses: Map<string, TaskRunProcess> = new Map();
  private _taskRunProcessesBeingKilled: Map<number, TaskRunProcess> = new Map();

  constructor(
    public build: BuildManifest,
    public params: BackgroundWorkerEngine2Options
  ) {}

  deprecate() {
    if (this.deprecated) {
      return;
    }

    this.deprecated = true;

    this.#tryStopWorker();
  }

  #tryStopWorker() {
    if (this.deprecated && this._taskRunProcesses.size === 0) {
      logger.debug("Worker deprecated, stopping", { outputPath: this.build.outputPath });

      this.params.stop();
    }
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

    logger.debug(this.#prefixedMessage(payload, "killing current task run process before attempt"));

    await this.#killCurrentTaskRunProcessBeforeAttempt(payload.execution.run.id);

    logger.debug(this.#prefixedMessage(payload, "creating new task run process"));

    const processOptions: TaskRunProcessOptions = {
      payload,
      env: {
        // TODO: this needs the stripEmptyValues stuff too
        ...sanitizeEnvVars(payload.environment ?? {}),
        ...sanitizeEnvVars(this.params.env),
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

        this.#tryStopWorker();
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
        const mappedError = await this.#correctError(error);

        return {
          ...result,
          error: mappedError,
        };
      }

      return result;
    } catch (e) {
      return {
        id: payload.execution.run.id,
        ok: false,
        retry: undefined,
        error: TaskRunProcess.parseExecuteError(e),
        taskIdentifier: payload.execution.task.id,
      };
    }
  }

  async #correctError(error: TaskRunBuiltInError): Promise<TaskRunBuiltInError> {
    return {
      ...error,
      stackTrace: correctErrorStackTrace(error.stackTrace, this.params.cwd),
    };
  }
}
