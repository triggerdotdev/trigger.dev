import {
  BackgroundWorkerProperties,
  BackgroundWorkerServerMessages,
  CreateBackgroundWorkerResponse,
  ResolvedConfig,
  SemanticInternalAttributes,
  TaskMetadataWithFilePath,
  TaskRunBuiltInError,
  TaskRunError,
  TaskRunErrorCodes,
  TaskRunExecution,
  TaskRunExecutionLazyAttemptPayload,
  TaskRunExecutionPayload,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  childToWorkerMessages,
  correctErrorStackTrace,
  formatDurationMilliseconds,
  workerToChildMessages,
} from "@trigger.dev/core/v3";
import { ZodMessageHandler, ZodMessageSender } from "@trigger.dev/core/v3/zodMessageHandler";
import dotenv from "dotenv";
import { Evt } from "evt";
import { ChildProcess, fork } from "node:child_process";
import { dirname, resolve } from "node:path";
import terminalLink from "terminal-link";
import {
  chalkError,
  chalkGrey,
  chalkLink,
  chalkRun,
  chalkSuccess,
  chalkTask,
  chalkWarning,
  chalkWorker,
  prettyPrintDate,
} from "../../utilities/cliOutput.js";
import { safeDeleteFileSync } from "../../utilities/fileSystem.js";
import { installPackages } from "../../utilities/installPackages.js";
import { logger } from "../../utilities/logger.js";
import {
  CancelledProcessError,
  CleanupProcessError,
  SigKillTimeoutProcessError,
  TaskMetadataParseError,
  UncaughtExceptionError,
  UnexpectedExitError,
  getFriendlyErrorMessage,
} from "../common/errors.js";
import { CliApiClient } from "../../apiClient.js";

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
  private _records: Map<string, CreateBackgroundWorkerResponse> = new Map();
  private _deprecatedWorkers: Set<string> = new Set();

  constructor(private baseURL: string) {
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
      record: this._records.get(id)!,
      isDeprecated: this._deprecatedWorkers.has(id),
    }));
  }

  async registerWorker(record: CreateBackgroundWorkerResponse, worker: BackgroundWorker) {
    for (const [workerId, existingWorker] of this._backgroundWorkers.entries()) {
      if (workerId === record.id) {
        continue;
      }

      this._deprecatedWorkers.add(workerId);
      this.onWorkerDeprecated.post({ worker: existingWorker, id: workerId });
    }

    this._backgroundWorkers.set(record.id, worker);
    this._records.set(record.id, record);
    this.onWorkerRegistered.post({ worker, id: record.id, record });

    worker.onTaskHeartbeat.attach((id) => {
      this.onWorkerTaskHeartbeat.post({ id, backgroundWorkerId: record.id, worker });
    });

    worker.onTaskRunHeartbeat.attach((id) => {
      this.onWorkerTaskRunHeartbeat.post({ id, backgroundWorkerId: record.id, worker });
    });
  }

  close() {
    for (const worker of this._backgroundWorkers.values()) {
      worker.close();
    }

    this._backgroundWorkers.clear();
    this._records.clear();
  }

  async handleMessage(id: string, message: BackgroundWorkerServerMessages) {
    logger.debug(`Received message from worker ${id}`, JSON.stringify({ workerMessage: message }));

    switch (message.type) {
      case "EXECUTE_RUNS": {
        await Promise.all(message.payloads.map((payload) => this.#executeTaskRun(id, payload)));
        break;
      }
      case "CANCEL_ATTEMPT": {
        // Need to cancel the attempt somehow here
        const worker = this._backgroundWorkers.get(id);

        if (!worker) {
          logger.error(`Could not find worker ${id}`);
          return;
        }

        await worker.cancelRun(message.taskRunId);
        break;
      }
      case "EXECUTE_RUN_LAZY_ATTEMPT": {
        await this.#executeTaskRunLazyAttempt(id, message.payload);
      }
    }
  }

  async #executeTaskRunLazyAttempt(id: string, payload: TaskRunExecutionLazyAttemptPayload) {
    const worker = this._backgroundWorkers.get(id);

    if (!worker) {
      logger.error(`Could not find worker ${id}`);
      return;
    }

    const record = this._records.get(id);

    if (!record) {
      logger.error(`Could not find worker record ${id}`);
      return;
    }

    try {
      const { completion, execution } = await worker.executeTaskRunLazyAttempt(
        payload,
        this.baseURL
      );

      this.onTaskCompleted.post({
        completion,
        execution,
        worker,
        backgroundWorkerId: id,
      });
    } catch (error) {
      this.onTaskFailedToRun.post({
        backgroundWorkerId: id,
        worker,
        completion: {
          ok: false,
          id: payload.runId,
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
  }

  async #executeTaskRun(id: string, payload: TaskRunExecutionPayload) {
    const worker = this._backgroundWorkers.get(id);

    if (!worker) {
      logger.error(`Could not find worker ${id}`);
      return;
    }

    const record = this._records.get(id);

    if (!record) {
      logger.error(`Could not find worker record ${id}`);
      return;
    }

    const completion = await worker.executeTaskRun(payload, this.baseURL);

    this.onTaskCompleted.post({
      completion,
      execution: payload.execution,
      worker,
      backgroundWorkerId: id,
    });
  }
}

export type BackgroundWorkerParams = {
  env: Record<string, string>;
  dependencies?: Record<string, string>;
  projectConfig: ResolvedConfig;
  debuggerOn: boolean;
  debugOtel?: boolean;
  resolveEnvVariables?: (
    env: Record<string, string>,
    worker: BackgroundWorker
  ) => Promise<Record<string, string> | undefined>;
};

export class BackgroundWorker {
  private _initialized: boolean = false;
  private _handler = new ZodMessageHandler({
    schema: childToWorkerMessages,
  });

  /**
   * @deprecated use onTaskRunHeartbeat instead
   */
  public onTaskHeartbeat: Evt<string> = new Evt();
  public onTaskRunHeartbeat: Evt<string> = new Evt();
  private _onClose: Evt<void> = new Evt();

  public tasks: Array<TaskMetadataWithFilePath> = [];
  public metadata: BackgroundWorkerProperties | undefined;
  public stderr: Array<string> = [];

  _taskRunProcesses: Map<string, TaskRunProcess> = new Map();
  private _taskRunProcessesBeingKilled: Set<number> = new Set();

  private _closed: boolean = false;

  private _fullEnv: Record<string, string> = {};

  constructor(
    public path: string,
    public params: BackgroundWorkerParams,
    private apiClient: CliApiClient
  ) {}

  close() {
    if (this._closed) {
      return;
    }

    this._closed = true;

    this.onTaskHeartbeat.detach();
    this.onTaskRunHeartbeat.detach();

    // We need to close all the task run processes
    for (const taskRunProcess of this._taskRunProcesses.values()) {
      taskRunProcess.cleanup(true);
    }

    // Delete worker files
    this._onClose.post();

    safeDeleteFileSync(this.path);
    safeDeleteFileSync(`${this.path}.map`);
  }

  get inProgressRuns(): Array<string> {
    return Array.from(this._taskRunProcesses.keys());
  }

  async initialize() {
    if (this._initialized) {
      throw new Error("Worker already initialized");
    }

    // Install the dependencies in dirname(this.path) using npm and child_process
    if (this.params.dependencies) {
      await installPackages(this.params.dependencies, { cwd: dirname(this.path) });
    }

    let resolved = false;

    const cwd = dirname(this.path);

    this._fullEnv = {
      ...this.params.env,
      ...this.#readEnvVars(),
      ...(this.params.debugOtel ? { OTEL_LOG_LEVEL: "debug" } : {}),
    };

    let resolvedEnvVars: Record<string, string> = {};

    if (this.params.resolveEnvVariables) {
      const resolvedEnv = await this.params.resolveEnvVariables(this._fullEnv, this);

      if (resolvedEnv) {
        resolvedEnvVars = resolvedEnv;
      }
    }

    this._fullEnv = {
      ...this._fullEnv,
      ...resolvedEnvVars,
    };

    logger.debug("Initializing worker", { path: this.path, cwd, fullEnv: this._fullEnv });

    this.tasks = await new Promise<Array<TaskMetadataWithFilePath>>((resolve, reject) => {
      const child = fork(this.path, {
        stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
        cwd,
        env: this._fullEnv,
      });

      // Set a timeout to kill the child process if it doesn't respond
      const timeout = setTimeout(() => {
        if (resolved) {
          return;
        }

        resolved = true;
        child.kill();
        reject(new Error("Worker timed out"));
      }, 5000);

      child.on("message", async (msg: any) => {
        const message = this._handler.parseMessage(msg);

        if (message.type === "TASKS_READY" && !resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve(message.payload.tasks);
          child.kill();
        } else if (message.type === "UNCAUGHT_EXCEPTION") {
          clearTimeout(timeout);
          resolved = true;
          reject(new UncaughtExceptionError(message.payload.error, message.payload.origin));
          child.kill();
        } else if (message.type === "TASKS_FAILED_TO_PARSE") {
          clearTimeout(timeout);
          resolved = true;
          reject(new TaskMetadataParseError(message.payload.zodIssues, message.payload.tasks));
          child.kill();
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
        logger.log(data.toString());
      });

      child.stderr?.on("data", (data) => {
        this.stderr.push(data.toString());
      });
    });

    this._initialized = true;
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

    if (!this.metadata) {
      throw new Error("Worker not registered");
    }

    this._closed = false;

    logger.debug(this.#prefixedMessage(payload, "killing current task run process before attempt"));

    await this.#killCurrentTaskRunProcessBeforeAttempt(payload.execution.run.id);

    logger.debug(this.#prefixedMessage(payload, "creating new task run process"));

    const taskRunProcess = new TaskRunProcess(
      payload.execution.run.id,
      payload.execution.run.isTest,
      this.path,
      {
        ...this._fullEnv,
        ...(payload.environment ?? {}),
        ...this.#readEnvVars(),
      },
      this.metadata,
      this.params,
      messageId
    );

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

    taskRunProcess.onTaskHeartbeat.attach((id) => {
      this.onTaskHeartbeat.post(id);
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

  async executeTaskRunLazyAttempt(payload: TaskRunExecutionLazyAttemptPayload, baseURL: string) {
    const attemptResponse = await this.apiClient.createTaskRunAttempt(payload.runId);

    if (!attemptResponse.success) {
      throw new Error(`Failed to create task run attempt: ${attemptResponse.error}`);
    }

    const execution = attemptResponse.data;

    const completion = await this.executeTaskRun(
      { execution, traceContext: payload.traceContext, environment: payload.environment },
      baseURL,
      payload.messageId
    );

    return { execution, completion };
  }

  // We need to fork the process before we can execute any tasks
  async executeTaskRun(
    payload: TaskRunExecutionPayload,
    baseURL: string,
    messageId?: string
  ): Promise<TaskRunExecutionResult> {
    if (this._closed) {
      throw new Error("Worker is closed");
    }

    if (!this.metadata) {
      throw new Error("Worker not registered");
    }

    const { execution } = payload;
    // ○ Mar 27 09:17:25.653 -> View logs | 20240326.20 | create-avatar | run_slufhjdfiv8ejnrkw9dsj.1

    const logsUrl = `${baseURL}/runs/${execution.run.id}`;

    const pipe = chalkGrey("|");
    const bullet = chalkGrey("○");
    const link = chalkLink(terminalLink("View logs", logsUrl));
    let timestampPrefix = chalkGrey(prettyPrintDate(payload.execution.attempt.startedAt));
    const workerPrefix = chalkWorker(this.metadata.version);
    const taskPrefix = chalkTask(execution.task.id);
    const runId = chalkRun(`${execution.run.id}.${execution.attempt.number}`);

    logger.log(
      `${bullet} ${timestampPrefix} ${chalkGrey(
        "->"
      )} ${link} ${pipe} ${workerPrefix} ${pipe} ${taskPrefix} ${pipe} ${runId}`
    );

    const now = performance.now();

    const completion = await this.#doExecuteTaskRun(payload, messageId);

    const elapsed = performance.now() - now;

    const retryingText = chalkGrey(
      !completion.ok && completion.skippedRetrying
        ? " (retrying skipped)"
        : !completion.ok && completion.retry !== undefined
        ? ` (retrying in ${completion.retry.delay}ms)`
        : ""
    );

    const resultText = !completion.ok
      ? completion.error.type === "INTERNAL_ERROR" &&
        (completion.error.code === TaskRunErrorCodes.TASK_EXECUTION_ABORTED ||
          completion.error.code === TaskRunErrorCodes.TASK_RUN_CANCELLED)
        ? chalkWarning("Cancelled")
        : `${chalkError("Error")}${retryingText}`
      : chalkSuccess("Success");

    const errorText = !completion.ok
      ? formatErrorLog(completion.error)
      : "retry" in completion
      ? `retry in ${completion.retry}ms`
      : "";

    const elapsedText = chalkGrey(`(${formatDurationMilliseconds(elapsed, { style: "short" })})`);

    timestampPrefix = chalkGrey(prettyPrintDate());

    logger.log(
      `${bullet} ${timestampPrefix} ${chalkGrey(
        "->"
      )} ${link} ${pipe} ${workerPrefix} ${pipe} ${taskPrefix} ${pipe} ${runId} ${pipe} ${resultText} ${elapsedText}${errorText}`
    );

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

      const result = await taskRunProcess.executeTaskRun(payload);

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
        },
      };
    }
  }

  #readEnvVars() {
    const result: { [key: string]: string } = {};

    dotenv.config({
      processEnv: result,
      path: [".env", ".env.local", ".env.development.local"].map((p) => resolve(process.cwd(), p)),
    });

    process.env.TRIGGER_API_URL && (result.TRIGGER_API_URL = process.env.TRIGGER_API_URL);

    // remove TRIGGER_API_URL and TRIGGER_SECRET_KEY, since those should be coming from the worker
    delete result.TRIGGER_API_URL;
    delete result.TRIGGER_SECRET_KEY;

    return result;
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

  constructor(
    private runId: string,
    private isTest: boolean,
    private path: string,
    private env: NodeJS.ProcessEnv,
    private metadata: BackgroundWorkerProperties,
    private worker: BackgroundWorkerParams,
    private messageId?: string
  ) {
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

  async initialize() {
    const fullEnv = {
      ...(this.isTest ? { TRIGGER_LOG_LEVEL: "debug" } : {}),
      ...this.env,
      OTEL_RESOURCE_ATTRIBUTES: JSON.stringify({
        [SemanticInternalAttributes.PROJECT_DIR]: this.worker.projectConfig.projectDir,
      }),
      OTEL_EXPORTER_OTLP_COMPRESSION: "none",
      ...(this.worker.debugOtel ? { OTEL_LOG_LEVEL: "debug" } : {}),
    };

    const cwd = dirname(this.path);

    logger.debug(`[${this.runId}] initializing task run process`, {
      env: fullEnv,
      path: this.path,
      cwd,
    });

    this._child = fork(this.path, {
      stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
      cwd,
      env: fullEnv,
      execArgv: this.worker.debuggerOn
        ? ["--inspect-brk", "--trace-uncaught", "--no-warnings=ExperimentalWarning"]
        : ["--trace-uncaught", "--no-warnings=ExperimentalWarning"],
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

    switch (message.type) {
      case "TASK_RUN_COMPLETED": {
        const { result, execution } = message.payload;

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
        if (this.messageId) {
          this.onTaskRunHeartbeat.post(this.messageId);
        } else {
          this.onTaskHeartbeat.post(message.payload.id);
        }

        break;
      }
      case "TASKS_READY": {
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

function formatErrorLog(error: TaskRunError) {
  switch (error.type) {
    case "INTERNAL_ERROR": {
      return "";
    }
    case "STRING_ERROR": {
      return `\n\n${chalkError("X Error:")} ${error.raw}\n`;
    }
    case "CUSTOM_ERROR": {
      return `\n\n${chalkError("X Error:")} ${error.raw}\n`;
    }
    case "BUILT_IN_ERROR": {
      return `\n\n${error.stackTrace.replace(/^Error: /, chalkError("X Error: "))}\n`;
    }
  }
}
