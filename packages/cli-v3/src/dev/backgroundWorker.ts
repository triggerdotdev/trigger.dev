import { Evt } from "evt";
import { fork } from "node:child_process";
import {
  BackgroundWorkerServerMessages,
  CreateBackgroundWorkerResponse,
  TaskMetadataWithFilePath,
  TaskRunExecutionResult,
  TaskRunExecution,
  ZodMessageHandler,
  ZodMessageSender,
  childToWorkerMessages,
  workerToChildMessages,
  TaskRunError,
  TaskRunBuiltInError,
} from "@trigger.dev/core/v3";
import { logger } from "../utilities/logger.js";
import chalk from "chalk";
import terminalLink from "terminal-link";
import { readFileSync } from "node:fs";
import { SourceMapConsumer, type RawSourceMap } from "source-map";
import nodePath from "node:path";

export type CurrentWorkers = BackgroundWorkerCoordinator["currentWorkers"];
export class BackgroundWorkerCoordinator {
  public onTaskCompleted: Evt<{
    backgroundWorkerId: string;
    completion: TaskRunExecutionResult;
    worker: BackgroundWorker;
    execution: TaskRunExecution;
  }> = new Evt();
  public onWorkerClosed: Evt<{ worker: BackgroundWorker; id: string }> = new Evt();
  public onWorkerRegistered: Evt<{
    worker: BackgroundWorker;
    id: string;
    record: CreateBackgroundWorkerResponse;
  }> = new Evt();
  public onWorkerStopped: Evt<{ worker: BackgroundWorker; id: string }> = new Evt();
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
    return Array.from(this._backgroundWorkers.entries())
      .filter(([, worker]) => worker.isRunning)
      .map(([id, worker]) => ({
        id,
        worker,
        record: this._records.get(id)!,
      }));
  }

  async registerWorker(record: CreateBackgroundWorkerResponse, worker: BackgroundWorker) {
    // If the worker is already registered, drain the existing workers
    for (const [workerId, existingWorker] of this._backgroundWorkers.entries()) {
      if (workerId === record.id) {
        continue;
      }

      await existingWorker.stop();

      this.onWorkerStopped.post({ worker: existingWorker, id: workerId });
    }

    this._backgroundWorkers.set(record.id, worker);
    this._records.set(record.id, record);

    worker.onClosed.attachOnce(() => {
      this._backgroundWorkers.delete(record.id);
      this._records.delete(record.id);

      this.onWorkerClosed.post({ worker, id: record.id });
    });

    this.onWorkerRegistered.post({ worker, id: record.id, record });
  }

  close() {
    for (const worker of this._backgroundWorkers.values()) {
      worker.child?.kill();
    }

    this._backgroundWorkers.clear();
  }

  async handleMessage(id: string, message: BackgroundWorkerServerMessages) {
    switch (message.type) {
      case "EXECUTE_RUNS": {
        await Promise.all(
          message.executions.map((execution) => this.#executeTaskRun(id, execution))
        );
      }
    }
  }

  async #executeTaskRun(id: string, execution: TaskRunExecution) {
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

    const link = chalk.bgBlueBright(
      terminalLink("view logs", `${this.baseURL}/runs/${execution.run.id}`)
    );
    const workerPrefix = chalk.green(`[worker:${record.version}]`);
    const taskPrefix = chalk.yellow(`[task:${execution.task.id}]`);
    const runId = chalk.blue(execution.run.id);
    const attempt = `(attempt #${execution.attempt.number})`;

    logger.log(`${workerPrefix}${taskPrefix} ${runId} ${attempt} ${link}`);

    const now = performance.now();

    const completion = await worker.executeTaskRun(execution);

    const elapsed = performance.now() - now;

    const resultText = !completion.ok ? chalk.red("error") : chalk.green("success");

    const errorText = !completion.ok
      ? `\n\n\t${chalk.bgRed("Error")} ${this.#formatErrorLog(completion.error)}`
      : "";

    const elapsedText = chalk.dim(`(${elapsed.toFixed(2)}ms)`);

    logger.log(
      `${workerPrefix}${taskPrefix} ${runId} ${attempt} ${resultText} ${elapsedText} ${link}${errorText}`
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
  child: undefined | ReturnType<typeof fork>;
  tasks: undefined | Array<TaskMetadataWithFilePath>;
  onClosed: Evt<void> = new Evt();

  private _stopping: boolean = false;
  private _processClosing: boolean = false;
  private _sender: ZodMessageSender<typeof workerToChildMessages>;
  private _handler: ZodMessageHandler<typeof childToWorkerMessages>;
  private _startResolver: undefined | (() => void);
  private _rawSourceMap: RawSourceMap;

  _taskExecutions: Map<
    string,
    { resolve: (value: TaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  constructor(
    public path: string,
    private params: BackgroundWorkerParams
  ) {
    this._sender = new ZodMessageSender({
      schema: workerToChildMessages,
      sender: async (message) => {
        this.child?.send(message);
      },
    });

    this._handler = new ZodMessageHandler({
      schema: childToWorkerMessages,
      messages: {
        TASKS_READY: async (payload) => {
          this.tasks = payload;
          this._startResolver?.();
        },
        TASK_RUN_COMPLETED: async (payload) => {
          const taskExecutor = this._taskExecutions.get(payload.id);

          if (!taskExecutor) {
            console.error(`Could not find task executor for task ${payload.id}`);
            return;
          }

          this._taskExecutions.delete(payload.id);

          taskExecutor.resolve(payload);

          if (this._stopping && this._taskExecutions.size === 0) {
            this.#kill();
          }
        },
      },
    });

    this._rawSourceMap = JSON.parse(readFileSync(`${path}.map`, "utf-8"));
  }

  async handleTaskRunCompletion(completion: TaskRunExecutionResult, execution: TaskRunExecution) {
    if (!this.child) {
      throw new Error("Worker not started");
    }

    if (this.child.exitCode !== null) {
      throw new Error(`Worker is killed with exit code ${this.child.exitCode}`);
    }

    await this._sender.send("TASK_RUN_COMPLETED", { completion, execution });
  }

  async executeTaskRun(execution: TaskRunExecution) {
    if (!this.child) {
      throw new Error("Worker not started");
    }

    if (this.child.exitCode !== null) {
      throw new Error(`Worker is killed with exit code ${this.child.exitCode}`);
    }

    const promise = new Promise<TaskRunExecutionResult>((resolve, reject) => {
      this._taskExecutions.set(execution.attempt.id, { resolve, reject });
    });

    await this._sender.send("EXECUTE_TASK_RUN", execution);

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

  get isRunning() {
    return this.child?.exitCode === null;
  }

  async stop() {
    this._stopping = true;

    if (this._taskExecutions.size === 0) {
      this.#kill();
    }
  }

  #kill() {
    this.child?.kill();
  }

  async start() {
    await new Promise<void>((resolve) => {
      this._startResolver = resolve;

      this.child = fork(this.path, {
        stdio: [/*stdin*/ "ignore", /*stdout*/ "pipe", /*stderr*/ "pipe", "ipc"],
        env: {
          ...this.params.env,
        },
      });

      this.child.on("message", async (msg: any) => {
        await this._handler.handleMessage(msg);
      });

      this.child.on("exit", (code) => {
        if (this._processClosing) {
          return;
        }

        this.onClosed.post();
      });

      this.child.stdout?.on("data", (data) => {
        logger.log(data.toString());
      });
    });
  }
}
