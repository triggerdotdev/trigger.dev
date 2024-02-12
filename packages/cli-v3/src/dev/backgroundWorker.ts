import {
  BackgroundWorkerRecord,
  BackgroundWorkerServerMessages,
  CreateBackgroundWorkerResponse,
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
import chalk from "chalk";
import { Evt } from "evt";
import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { SourceMapConsumer, type RawSourceMap } from "source-map";
import terminalLink from "terminal-link";
import { logger } from "../utilities/logger.js";

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
  public onWorkerDeprecated: Evt<{ worker: BackgroundWorker; id: string }> = new Evt();
  private _backgroundWorkers: Map<string, BackgroundWorker> = new Map();
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
      await worker.handleTaskRunCompletion(completion, execution);
    }
  }

  get currentWorkers() {
    return Array.from(this._backgroundWorkers.entries()).map(([id, worker]) => ({
      id,
      worker,
      record: this._records.get(id)!,
    }));
  }

  async registerWorker(record: CreateBackgroundWorkerResponse, worker: BackgroundWorker) {
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
      logger.error(`Could not find worker ${id}`);
      return;
    }

    const record = this._records.get(id);

    if (!record) {
      logger.error(`Could not find worker record ${id}`);
      return;
    }

    const { execution } = payload;

    const link = chalk.bgBlueBright(
      terminalLink("view logs", `${this.baseURL}/runs/${execution.run.id}`)
    );
    const workerPrefix = chalk.green(`[worker:${record.version}]`);
    const taskPrefix = chalk.yellow(`[task:${execution.task.id}]`);
    const runId = chalk.blue(execution.run.id);
    const attempt = chalk.blue(`.${execution.attempt.number}`);

    logger.log(`${workerPrefix}${taskPrefix} ${runId}${attempt} ${link}`);

    const now = performance.now();

    const completion = await worker.executeTaskRun(payload);

    const elapsed = performance.now() - now;

    const resultText = !completion.ok ? chalk.red("error") : chalk.green("success");

    const errorText = !completion.ok
      ? `\n\n\t${chalk.bgRed("Error")} ${this.#formatErrorLog(completion.error)}`
      : "";

    const elapsedText = chalk.dim(`(${elapsed.toFixed(2)}ms)`);

    logger.log(
      `${workerPrefix}${taskPrefix} ${runId}${attempt} ${resultText} ${elapsedText} ${link}${errorText}`
    );

    this.onTaskCompleted.post({ completion, execution, worker, backgroundWorkerId: id });
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

export type BackgroundWorkerParams = {
  env: Record<string, string>;
  projectDir: string;
};
export class BackgroundWorker {
  private _rawSourceMap: RawSourceMap;
  private _initialized: boolean = false;
  private _handler = new ZodMessageHandler({
    schema: childToWorkerMessages,
  });
  private _onTaskCompleted: Evt<{
    completion: TaskRunExecutionResult;
    execution: TaskRunExecution;
  }> = new Evt();
  private _onClose: Evt<void> = new Evt();

  public tasks: Array<TaskMetadataWithFilePath> = [];
  public metadata: BackgroundWorkerRecord | undefined;

  _taskExecutions: Map<
    string,
    { resolve: (value: TaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  constructor(
    public path: string,
    private params: BackgroundWorkerParams
  ) {
    this._rawSourceMap = JSON.parse(readFileSync(`${path}.map`, "utf-8"));
  }

  close() {
    this._onClose.post();
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
        logger.log(data.toString());
      });

      child.stderr?.on("data", (data) => {
        logger.error(data.toString());
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

  async handleTaskRunCompletion(completion: TaskRunExecutionResult, execution: TaskRunExecution) {
    this._onTaskCompleted.post({ completion, execution });
  }

  // We need to fork the process before we can execute any tasks
  async executeTaskRun(payload: TaskRunExecutionPayload): Promise<TaskRunExecutionResult> {
    const metadata = this.metadata;

    if (!metadata) {
      throw new Error("Worker not registered");
    }

    const { execution, traceContext } = payload;

    const child = fork(this.path, {
      stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
      env: {
        ...this.params.env,
      },
    });

    const sender = new ZodMessageSender({
      schema: workerToChildMessages,
      sender: async (message) => {
        if (!child.connected) {
          return;
        }

        child.send(message);
      },
    });

    const ctx = Evt.newCtx();

    // This will notify this task of the completion of any other tasks
    this._onTaskCompleted.attach(ctx, async (taskCompletion) => {
      if (execution.attempt.id === taskCompletion.execution.attempt.id) {
        return;
      }

      await sender.send("TASK_RUN_COMPLETED", taskCompletion);
    });

    this._onClose.attachOnce(ctx, () => {
      child.kill();
    });

    let resolved = false;
    let resolver: (value: TaskRunExecutionResult) => void;
    let rejecter: (err?: any) => void;

    const promise = new Promise<TaskRunExecutionResult>((resolve, reject) => {
      resolver = resolve;
      rejecter = reject;
    });

    child.on("message", async (msg: any) => {
      const message = this._handler.parseMessage(msg);

      if (message.type === "TASK_RUN_COMPLETED") {
        resolved = true;
        resolver(message.payload.result);
        this._onTaskCompleted.detach(ctx);
        this._onClose.detach(ctx);

        await sender.send("CLEANUP", { flush: true });
      } else if (message.type === "READY_TO_DISPOSE") {
        if (!child.killed) {
          child.kill();
        }
      }
    });

    child.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        this._onTaskCompleted.detach(ctx);
        this._onClose.detach(ctx);
        rejecter(new Error(`Worker exited with code ${code}`));
      }
    });

    child.stdout?.on("data", (data) => {
      logger.log(
        `[${metadata.version}][${execution.run.id}.${execution.attempt.number}] ${data.toString()}`
      );
    });

    await sender.send("EXECUTE_TASK_RUN", { execution, traceContext, metadata });

    const result = await promise;

    if (result.ok) {
      return result;
    }

    const error = result.error;

    if (error.type === "BUILT_IN_ERROR") {
      const mappedError = await this.#correctError(error, execution);

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

    return false;
  }
}
