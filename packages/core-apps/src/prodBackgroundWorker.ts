import {
  BackgroundWorkerProperties,
  BackgroundWorkerServerMessages,
  CreateBackgroundWorkerResponse,
  ProdTaskRunExecutionPayload,
  TaskMetadataWithFilePath,
  TaskRunBuiltInError,
  TaskRunError,
  TaskRunExecution,
  TaskRunExecutionPayload,
  TaskRunExecutionResult,
  ZodMessageHandler,
  ZodMessageSender,
  childToWorkerMessages,
  workerToChildMessages,
} from "@trigger.dev/core/v3";
import { Evt } from "evt";
import { ChildProcess, fork } from "node:child_process";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { SourceMapConsumer, type RawSourceMap } from "source-map";

export class ProdBackgroundWorkerCoordinator {
  public onTaskCompleted: Evt<{
    backgroundWorkerId: string;
    completion: TaskRunExecutionResult;
    worker: ProdBackgroundWorker;
    execution: TaskRunExecution;
  }> = new Evt();

  public onWorkerRegistered: Evt<{
    worker: ProdBackgroundWorker;
    id: string;
    record: CreateBackgroundWorkerResponse;
  }> = new Evt();

  public onWorkerDeprecated: Evt<{ worker: ProdBackgroundWorker; id: string }> = new Evt();
  private _backgroundWorkers: Map<string, ProdBackgroundWorker> = new Map();
  private _records: Map<string, CreateBackgroundWorkerResponse> = new Map();

  constructor(private baseURL: string) {
    this.onTaskCompleted.attach(async ({ completion, execution }) => {
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
    }));
  }

  async registerWorker(record: CreateBackgroundWorkerResponse, worker: ProdBackgroundWorker) {
    for (const [workerId, existingWorker] of this._backgroundWorkers.entries()) {
      if (workerId === record.id) {
        continue;
      }

      this.onWorkerDeprecated.post({ worker: existingWorker, id: workerId });
    }

    this._backgroundWorkers.set(record.id, worker);
    this._records.set(record.id, record);
    this.onWorkerRegistered.post({ worker, id: record.id, record });
  }

  close() {
    for (const worker of this._backgroundWorkers.values()) {
      worker.close();
    }

    this._backgroundWorkers.clear();
    this._records.clear();
  }

  async handleMessage(id: string, message: BackgroundWorkerServerMessages) {
    switch (message.type) {
      case "EXECUTE_RUNS": {
        await Promise.all(message.payloads.map((payload) => this.#executeTaskRun(id, payload)));
      }
    }
  }

  async #executeTaskRun(id: string, payload: TaskRunExecutionPayload) {
    const worker = this._backgroundWorkers.get(id);

    if (!worker) {
      console.error(`Could not find worker ${id}`);
      return;
    }

    const record = this._records.get(id);

    if (!record) {
      console.error(`Could not find worker record ${id}`);
      return;
    }

    const { execution } = payload;

    const link = `view logs: ${this.baseURL}/runs/${execution.run.id}`;
    const workerPrefix = `[worker:${record.version}]`;
    const taskPrefix = `[task:${execution.task.id}]`;
    const runId = execution.run.id;
    const attempt = `.${execution.attempt.number}`;

    console.log(`${workerPrefix}${taskPrefix} ${runId}${attempt} ${link}`);

    const now = performance.now();

    const completion = await worker.executeTaskRun(payload as ProdTaskRunExecutionPayload);

    const elapsed = performance.now() - now;

    const resultText = !completion.ok ? "error" : "success";

    const errorText = !completion.ok
      ? `\n\n\t${"Error"} ${this.#formatErrorLog(completion.error)}`
      : "";

    const elapsedText = `(${elapsed.toFixed(2)}ms)`;

    console.log(
      `${workerPrefix}${taskPrefix} ${runId}${attempt} ${resultText} ${elapsedText} ${link}${errorText}`
    );

    this.onTaskCompleted.post({
      completion,
      execution,
      worker,
      backgroundWorkerId: id,
    });
  }

  #formatErrorLog(error: TaskRunError) {
    switch (error.type) {
      case "INTERNAL_ERROR": {
        return `Internal error: ${error.code}`;
      }
      case "STRING_ERROR": {
        return error.raw;
      }
      case "CUSTOM_ERROR": {
        return error.raw;
      }
      case "BUILT_IN_ERROR": {
        return `${error.name === "Error" ? "" : `(${error.name})`} ${
          error.message
        }\n${error.stackTrace
          .split("\n")
          .map((line) => `\t  ${line}`)
          .join("\n")}\n`;
      }
    }
  }
}

type BackgroundWorkerParams = {
  env: Record<string, string>;
  projectDir: string;
  contentHash: string;
};

export class ProdBackgroundWorker {
  private _rawSourceMap: RawSourceMap;
  private _initialized: boolean = false;
  private _handler = new ZodMessageHandler({
    schema: childToWorkerMessages,
  });

  public onTaskHeartbeat: Evt<string> = new Evt();

  public onWaitForBatch: Evt<{ version?: "v1"; id: string; runs: string[] }> = new Evt();
  public onWaitForDuration: Evt<{ version?: "v1"; ms: number }> = new Evt();
  public onWaitForTask: Evt<{ version?: "v1"; id: string }> = new Evt();

  public tasks: Array<TaskMetadataWithFilePath> = [];

  _taskRunProcesses: Map<string, TaskRunProcess> = new Map();

  constructor(
    public path: string,
    private params: BackgroundWorkerParams
  ) {
    this._rawSourceMap = JSON.parse(readFileSync(`${path}.map`, "utf-8"));
  }

  close() {
    this.onTaskHeartbeat.detach();

    // We need to close all the task run processes
    for (const taskRunProcess of this._taskRunProcesses.values()) {
      taskRunProcess.cleanup(true);
    }
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
      const taskRunProcess = new TaskRunProcess(this.path, this.params.env, metadata);

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
      stackTrace: await this.#correctErrorStackTrace(error.stackTrace, execution),
    };
  }

  async #correctErrorStackTrace(stackTrace: string, execution: TaskRunExecution): Promise<string> {
    // Split the stack trace into lines
    const lines = stackTrace.split("\n");

    // Remove the first line
    lines.shift();

    // Use SourceMapConsumer.with to handle the source map for the entire stack trace
    return SourceMapConsumer.with(this._rawSourceMap, null, (consumer) =>
      lines
        .map((line) => this.#correctStackTraceLine(line, consumer, execution))
        .filter(Boolean)
        .join("\n")
    );
  }

  #correctStackTraceLine(
    line: string,
    consumer: SourceMapConsumer,
    execution: TaskRunExecution
  ): string | undefined {
    // Split the line into parts
    const regex = /at (.*?) \(file:\/\/(\/.*?\.mjs):(\d+):(\d+)\)/;

    const match = regex.exec(line);

    if (!match) {
      return line;
    }

    const [_, identifier, path, lineNum, colNum] = match;

    const originalPosition = consumer.originalPositionFor({
      line: Number(lineNum),
      column: Number(colNum),
    });

    if (!originalPosition.source) {
      return line;
    }

    const { source, line: originalLine, column: originalColumn } = originalPosition;

    if (this.#shouldFilterLine({ identifier, path: source })) {
      return;
    }

    const sourcePath = path
      ? nodePath.relative(this.params.projectDir, nodePath.resolve(nodePath.dirname(path), source))
      : source;

    return `at ${
      identifier === "Object.run" ? `${execution.task.exportName}.run` : identifier
    } (${sourcePath}:${originalLine}:${originalColumn})`;
  }

  #shouldFilterLine(line: { identifier?: string; path?: string }): boolean {
    const filename = nodePath.basename(line.path ?? "");

    if (filename === "__entryPoint.ts") {
      return true;
    }

    if (line.identifier === "async ZodMessageHandler.handleMessage") {
      return true;
    }

    if (line.identifier === "async ConsoleInterceptor.intercept") {
      return true;
    }

    if (line.path?.includes("packages/core/src")) {
      return true;
    }

    return false;
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
    private metadata: BackgroundWorkerProperties
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
      env: this.env,
    });

    this._child.on("message", this.#handleMessage.bind(this));
    this._child.on("exit", this.#handleExit.bind(this));
    this._child.stdout?.on("data", this.#handleLog.bind(this));
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

  #kill() {
    if (this._child && !this._child.killed) {
      this._child?.kill();
    }
  }
}
