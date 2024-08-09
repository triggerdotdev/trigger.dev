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
  childToWorkerMessages,
  correctErrorStackTrace,
  indexerToWorkerMessages,
  workerToChildMessages,
} from "@trigger.dev/core/v3";
import {
  ZodMessageHandler,
  ZodMessageSender,
  parseMessageFromCatalog,
} from "@trigger.dev/core/v3/zodMessageHandler";
import { Evt } from "evt";
import { ChildProcess, fork } from "node:child_process";
import { chalkError, chalkGrey, chalkRun, prettyPrintDate } from "../utilities/cliOutput.js";

import { join } from "node:path";
import { eventBus } from "../utilities/eventBus.js";
import { writeJSONFile } from "../utilities/fileSystem.js";
import { logger } from "../utilities/logger.js";
import {
  CancelledProcessError,
  CleanupProcessError,
  SigKillTimeoutProcessError,
  TaskMetadataParseError,
  UncaughtExceptionError,
  UnexpectedExitError,
  getFriendlyErrorMessage,
} from "./errors.js";

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

  async executeTaskRun(id: string, payload: TaskRunExecutionPayload, messageId?: string) {
    const worker = this._backgroundWorkers.get(id);

    if (!worker) {
      logger.error(`Could not find worker ${id}`);
      return;
    }

    try {
      const completion = await worker.executeTaskRun(payload);

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
  private _taskRunProcessesBeingKilled: Set<number> = new Set();

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

  async initialize() {
    if (this.manifest) {
      throw new Error("Worker already initialized");
    }

    let resolved = false;

    const buildManifestPath = join(this.build.outputPath, "build.json");

    // Write the build manifest to this.build.outputPath/build.json
    await writeJSONFile(buildManifestPath, this.build, true);

    logger.debug("Initializing worker", { build: this.build, params: this.params });

    this.manifest = await new Promise<WorkerManifest>((resolve, reject) => {
      const child = fork(this.build.indexerEntryPoint, {
        stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
        cwd: this.params.cwd,
        env: {
          ...this.params.env,
          TRIGGER_BUILD_MANIFEST_PATH: buildManifestPath,
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
      }, 20_000);

      child.on("message", async (msg: any) => {
        const message = parseMessageFromCatalog(msg, indexerToWorkerMessages);

        switch (message.type) {
          case "INDEX_COMPLETE": {
            clearTimeout(timeout);
            resolved = true;
            resolve(message.payload.manifest);
            child.kill();
            break;
          }
          case "TASKS_FAILED_TO_PARSE": {
            clearTimeout(timeout);
            resolved = true;
            reject(new TaskMetadataParseError(message.payload.zodIssues, message.payload.tasks));
            child.kill();
            break;
          }
          case "UNCAUGHT_EXCEPTION": {
            clearTimeout(timeout);
            resolved = true;
            reject(new UncaughtExceptionError(message.payload.error, message.payload.origin));
            child.kill();
            break;
          }
        }
      });

      child.on("exit", (code) => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          reject(new Error(`Worker exited with code ${code}`));
        }
      });

      child.stdout?.on("data", (data) => {
        logger.debug(`indexer: ${data.toString()}`);
      });

      child.stderr?.on("data", (data) => {
        logger.debug(`indexer: ${data.toString()}`);
      });
    });

    const indexManifestPath = join(this.build.outputPath, "index.json");

    // Write the build manifest to this.build.outputPath/worker.json
    await writeJSONFile(indexManifestPath, this.manifest, true);

    logger.debug("Worker initialized", { index: indexManifestPath, path: this.build.outputPath });
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
    messageId?: string
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
      build: this.build,
      env: {
        ...this.params.env,
        ...payload.environment,
        TRIGGER_BUILD_MANIFEST_PATH: join(this.build.outputPath, "build.json"),
        TRIGGER_WORKER_MANIFEST_PATH: join(this.build.outputPath, "index.json"),
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

    taskRunProcess.onIsBeingKilled.attach((pid) => {
      if (pid) {
        this._taskRunProcessesBeingKilled.add(pid);
      }
    });

    taskRunProcess.onTaskRunHeartbeat.attach((id) => {
      this.onTaskRunHeartbeat.post(id);
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
    messageId?: string
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
    messageId?: string
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

      return {
        id: payload.execution.attempt.id,
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

type TaskRunProcessOptions = {
  payload: TaskRunExecutionPayload;
  build: BuildManifest;
  env: Record<string, string>;
  cwd?: string;
  // this is the "index" data
  workerManifest: WorkerManifest;
  // this is the worker on the server data
  serverWorker: ServerBackgroundWorker;
  messageId?: string;
};

class TaskRunProcess {
  private _handler = new ZodMessageHandler({
    schema: childToWorkerMessages,
  });
  private _sender: ZodMessageSender<typeof workerToChildMessages>;
  private _child: ChildProcess | undefined;
  private _childPid?: number;
  private _attemptPromises: Map<
    string,
    { resolver: (value: TaskRunExecutionResult) => void; rejecter: (err?: any) => void }
  > = new Map();
  private _attemptStatuses: Map<string, "PENDING" | "REJECTED" | "RESOLVED"> = new Map();
  private _currentExecution: TaskRunExecution | undefined;
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
  public onIsBeingKilled: Evt<number | undefined> = new Evt();

  constructor(public readonly options: TaskRunProcessOptions) {
    this._sender = new ZodMessageSender({
      schema: workerToChildMessages,
      sender: async (message) => {
        if (this._child?.connected && !this._isBeingKilled && !this._child.killed) {
          this._child.send(message);
        }
      },
    });
  }

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
    const { env, build, cwd } = this.options;

    const fullEnv = {
      ...(this.isTest ? { TRIGGER_LOG_LEVEL: "debug" } : {}),
      ...env,
    };

    logger.debug(`[${this.runId}] initializing task run process`, {
      env: fullEnv,
      path: build.workerEntryPoint,
      cwd,
    });

    this._child = fork(build.workerEntryPoint, {
      stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
      cwd,
      env: fullEnv,
      execArgv: ["--trace-uncaught", "--no-warnings=ExperimentalWarning"],
    });

    this._childPid = this._child?.pid;

    this._child.on("message", this.#handleMessage.bind(this));
    this._child.on("exit", this.#handleExit.bind(this));
    this._child.stdout?.on("data", this.#handleLog.bind(this));
    this._child.stderr?.on("data", this.#handleStdErr.bind(this));
  }

  async cleanup(kill: boolean = false) {
    if (kill && this._isBeingKilled) {
      return;
    }

    if (kill) {
      this._isBeingKilled = true;
      this.onIsBeingKilled.post(this._child?.pid);
    }

    logger.debug(`[${this.runId}] cleaning up task run process`, { kill, pid: this.pid });

    await this._sender.send("CLEANUP", {
      flush: true,
      kill,
    });

    // FIXME: Something broke READY_TO_DISPOSE. We never receive it, so we always have to kill the process after the timeout below.

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

    await this._sender.send("EXECUTE_TASK_RUN", {
      execution,
      traceContext,
      metadata: this.options.serverWorker,
    });

    const result = await promise;

    this._currentExecution = undefined;

    return result;
  }

  taskRunCompletedNotification(completion: TaskRunExecutionResult) {
    if (!completion.ok && typeof completion.retry !== "undefined") {
      return;
    }

    if (completion.id === this.runId) {
      // We don't need to notify the task run process if it's the same as the one we're running
      return;
    }

    logger.debug(`[${this.runId}] task run completed notification`, {
      completion,
    });

    this._sender.send("TASK_RUN_COMPLETED_NOTIFICATION", {
      version: "v2",
      completion,
    });
  }

  async #handleMessage(msg: any) {
    const message = this._handler.parseMessage(msg);

    if (!message.success) {
      logger.error(`Dropping message: ${message.error}`, { message });
      return;
    }

    switch (message.data.type) {
      case "TASK_RUN_COMPLETED": {
        const { result, execution } = message.data.payload;

        logger.debug(`[${this.runId}] task run completed`, {
          result,
        });

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
        logger.debug(`[${this.runId}] task run process is ready to dispose`);

        this.#kill();

        break;
      }
      case "TASK_HEARTBEAT": {
        if (this.options.messageId) {
          this.onTaskRunHeartbeat.post(this.options.messageId);
        } else {
          this.onTaskHeartbeat.post(message.data.payload.id);
        }

        break;
      }
    }
  }

  async #handleExit(code: number | null, signal: NodeJS.Signals | null) {
    logger.debug(`[${this.runId}] handle task run process exit`, { code, signal, pid: this.pid });

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

    this.onIsBeingKilled.post(this._child?.pid);
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
