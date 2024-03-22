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
  TaskRunExecutionPayload,
  TaskRunExecutionResult,
  ZodMessageHandler,
  ZodMessageSender,
  childToWorkerMessages,
  correctErrorStackTrace,
  workerToChildMessages,
} from "@trigger.dev/core/v3";
import chalk from "chalk";
import dotenv from "dotenv";
import { Evt } from "evt";
import { ChildProcess, fork } from "node:child_process";
import { dirname, resolve } from "node:path";
import terminalLink from "terminal-link";
import { safeDeleteFileSync } from "../../utilities/fileSystem.js";
import { installPackages } from "../../utilities/installPackages.js";
import { logger } from "../../utilities/logger.js";
import { UncaughtExceptionError } from "../common/errors.js";

export type CurrentWorkers = BackgroundWorkerCoordinator["currentWorkers"];
export class BackgroundWorkerCoordinator {
  public onTaskCompleted: Evt<{
    backgroundWorkerId: string;
    completion: TaskRunExecutionResult;
    worker: BackgroundWorker;
    execution: TaskRunExecution;
  }> = new Evt();
  public onWorkerRegistered: Evt<{
    worker: BackgroundWorker;
    id: string;
    record: CreateBackgroundWorkerResponse;
  }> = new Evt();
  public onWorkerTaskHeartbeat: Evt<{
    id: string;
    backgroundWorkerId: string;
    worker: BackgroundWorker;
  }> = new Evt();
  public onWorkerDeprecated: Evt<{ worker: BackgroundWorker; id: string }> = new Evt();
  private _backgroundWorkers: Map<string, BackgroundWorker> = new Map();
  private _records: Map<string, CreateBackgroundWorkerResponse> = new Map();
  private _deprecatedWorkers: Set<string> = new Set();

  constructor(private baseURL: string) {
    this.onTaskCompleted.attach(async ({ completion, execution }) => {
      if (!completion.ok && typeof completion.retry !== "undefined") {
        return;
      }

      await this.#notifyWorkersOfTaskCompletion(completion, execution);
    });
  }

  async #notifyWorkersOfTaskCompletion(
    completion: TaskRunExecutionResult,
    execution: TaskRunExecution
  ) {
    for (const worker of this._backgroundWorkers.values()) {
      await worker.taskRunCompletedNotification(completion, execution);
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
  }

  close() {
    for (const worker of this._backgroundWorkers.values()) {
      worker.close();
    }

    this._backgroundWorkers.clear();
    this._records.clear();
  }

  async handleMessage(id: string, message: BackgroundWorkerServerMessages) {
    logger.debug(`Received message from worker ${id}`, { workerMessage: message });

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
      }
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

    const { execution } = payload;

    const logsUrl = `${this.baseURL}/runs/${execution.run.id}`;

    const link = chalk.bgBlueBright(terminalLink("view logs", logsUrl));
    let timestampPrefix = chalk.gray(new Date().toISOString());
    const workerPrefix = chalk.green(`[worker:${record.version}]`);
    const taskPrefix = chalk.yellow(`[task:${execution.task.id}]`);
    const runId = chalk.blue(execution.run.id);
    const attempt = chalk.blue(`.${execution.attempt.number}`);

    logger.log(`${timestampPrefix} ${workerPrefix}${taskPrefix} ${runId}${attempt} ${link}`);

    const now = performance.now();

    const completion = await worker.executeTaskRun(payload);

    const elapsed = performance.now() - now;

    const retryingText =
      !completion.ok && completion.skippedRetrying
        ? " (retrying skipped)"
        : !completion.ok && completion.retry !== undefined
        ? ` (retrying in ${completion.retry.delay}ms)`
        : "";

    const resultText = !completion.ok
      ? completion.error.type === "INTERNAL_ERROR" &&
        (completion.error.code === TaskRunErrorCodes.TASK_EXECUTION_ABORTED ||
          completion.error.code === TaskRunErrorCodes.TASK_RUN_CANCELLED)
        ? chalk.yellow("cancelled")
        : chalk.red(`error${retryingText}`)
      : chalk.green("success");

    const errorText = !completion.ok
      ? this.#formatErrorLog(completion.error)
      : "retry" in completion
      ? `retry in ${completion.retry}ms`
      : "";

    const elapsedText = chalk.dim(`(${elapsed.toFixed(2)}ms)`);

    timestampPrefix = chalk.gray(new Date().toISOString());

    logger.log(
      `${timestampPrefix} ${workerPrefix}${taskPrefix} ${runId}${attempt} ${resultText} ${elapsedText} ${link}${errorText}`
    );

    this.onTaskCompleted.post({ completion, execution, worker, backgroundWorkerId: id });
  }

  #formatErrorLog(error: TaskRunError) {
    switch (error.type) {
      case "INTERNAL_ERROR": {
        return "";
      }
      case "STRING_ERROR": {
        return `\n\n${error.raw}\n`;
      }
      case "CUSTOM_ERROR": {
        return `\n\n${error.raw}\n`;
      }
      case "BUILT_IN_ERROR": {
        return `\n\n${error.stackTrace}\n`;
      }
    }
  }
}

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

export type BackgroundWorkerParams = {
  env: Record<string, string>;
  dependencies?: Record<string, string>;
  projectConfig: ResolvedConfig;
  debuggerOn: boolean;
  debugOtel?: boolean;
};
export class BackgroundWorker {
  private _initialized: boolean = false;
  private _handler = new ZodMessageHandler({
    schema: childToWorkerMessages,
  });

  public onTaskHeartbeat: Evt<string> = new Evt();
  private _onClose: Evt<void> = new Evt();

  public tasks: Array<TaskMetadataWithFilePath> = [];
  public metadata: BackgroundWorkerProperties | undefined;

  _taskRunProcesses: Map<string, TaskRunProcess> = new Map();

  private _closed: boolean = false;

  constructor(
    public path: string,
    private params: BackgroundWorkerParams
  ) {}

  close() {
    if (this._closed) {
      return;
    }

    this._closed = true;

    this.onTaskHeartbeat.detach();

    // We need to close all the task run processes
    for (const taskRunProcess of this._taskRunProcesses.values()) {
      taskRunProcess.cleanup(true);
    }

    // Delete worker files
    this._onClose.post();

    safeDeleteFileSync(this.path);
    safeDeleteFileSync(`${this.path}.map`);
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

    this.tasks = await new Promise<Array<TaskMetadataWithFilePath>>((resolve, reject) => {
      const child = fork(this.path, {
        stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
        env: {
          ...this.params.env,
          ...this.#readEnvVars(),
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
        }
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

  async #initializeTaskRunProcess(payload: TaskRunExecutionPayload): Promise<TaskRunProcess> {
    if (!this.metadata) {
      throw new Error("Worker not registered");
    }

    if (!this._taskRunProcesses.has(payload.execution.run.id)) {
      const taskRunProcess = new TaskRunProcess(
        payload.execution.run.id,
        this.path,
        {
          ...this.params.env,
          ...(payload.environment ?? {}),
          ...this.#readEnvVars(),
        },
        this.metadata,
        this.params
      );

      taskRunProcess.onExit.attach(() => {
        this._taskRunProcesses.delete(payload.execution.run.id);
      });

      taskRunProcess.onTaskHeartbeat.attach((id) => {
        this.onTaskHeartbeat.post(id);
      });

      await taskRunProcess.initialize();

      this._taskRunProcesses.set(payload.execution.run.id, taskRunProcess);
    }

    return this._taskRunProcesses.get(payload.execution.run.id) as TaskRunProcess;
  }

  async cancelRun(taskRunId: string) {
    const taskRunProcess = this._taskRunProcesses.get(taskRunId);

    if (!taskRunProcess) {
      return;
    }

    await taskRunProcess.cancel();
  }

  // We need to fork the process before we can execute any tasks
  async executeTaskRun(payload: TaskRunExecutionPayload): Promise<TaskRunExecutionResult> {
    try {
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

  constructor(
    private runId: string,
    private path: string,
    private env: NodeJS.ProcessEnv,
    private metadata: BackgroundWorkerProperties,
    private worker: BackgroundWorkerParams
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
    logger.debug(`[${this.runId}] initializing task run process`, {
      env: this.env,
      path: this.path,
    });

    this._child = fork(this.path, {
      stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
      cwd: dirname(this.path),
      env: {
        ...this.env,
        OTEL_RESOURCE_ATTRIBUTES: JSON.stringify({
          [SemanticInternalAttributes.PROJECT_DIR]: this.worker.projectConfig.projectDir,
        }),
        OTEL_EXPORTER_OTLP_COMPRESSION: "none",
        ...(this.worker.debugOtel ? { OTEL_LOG_LEVEL: "debug" } : {}),
      },
      execArgv: this.worker.debuggerOn
        ? ["--inspect-brk", "--trace-uncaught", "--no-warnings=ExperimentalWarning"]
        : ["--trace-uncaught", "--no-warnings=ExperimentalWarning"],
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

    logger.debug(`[${this.runId}] cleaning up task run process`, { kill });

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
    if (!completion.ok && typeof completion.retry !== "undefined") {
      return;
    }

    if (execution.run.id === this.runId) {
      // We don't need to notify the task run process if it's the same as the one we're running
      return;
    }

    logger.debug(`[${this.runId}] task run completed notification`, { completion, execution });

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
    }
  }

  async #handleExit(code: number) {
    logger.debug(`[${this.runId}] task run process exiting`, { code });

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

    logger.log(
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
      logger.error(`[${this.metadata.version}] ${data.toString()}`);

      return;
    }

    logger.error(
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
