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
} from "@trigger.dev/core";
import { logger } from "../utilities/logger";
import chalk from "chalk";
import terminalLink from "terminal-link";

export type CurrentWorkers = BackgroundWorkerCoordinator["currentWorkers"];
export class BackgroundWorkerCoordinator {
  public onTaskCompleted: Evt<{
    backgroundWorkerId: string;
    completion: TaskRunExecutionResult;
    worker: BackgroundWorker;
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

  constructor(private baseURL: string) {}

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

    const link = terminalLink("view logs", `${this.baseURL}/runs/${execution.run.id}`);

    logger.log(
      `[worker:${record.version}][${execution.task.id}] Executing ${execution.run.id} (attempt #${execution.attempt.number}) ${link}`
    );

    const now = performance.now();

    const completion = await worker.executeTaskRun(execution);

    const elapsed = performance.now() - now;

    logger.log(
      `[worker:${record.version}][${execution.task.id}] Execution complete ${execution.run.id}: ${
        !completion.ok ? chalk.red(`error: ${completion.error}`) : chalk.green("success")
      } (${elapsed.toFixed(2)}ms) ${link}`
    );

    this.onTaskCompleted.post({ completion, worker, backgroundWorkerId: id });
  }
}

export class BackgroundWorker {
  child: undefined | ReturnType<typeof fork>;
  tasks: undefined | Array<TaskMetadataWithFilePath>;
  onClosed: Evt<void> = new Evt();

  private _stopping: boolean = false;
  private _processClosing: boolean = false;
  private _sender: ZodMessageSender<typeof workerToChildMessages>;
  private _handler: ZodMessageHandler<typeof childToWorkerMessages>;

  private _startResolver: undefined | (() => void);

  _taskExecutions: Map<
    string,
    { resolve: (value: TaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  constructor(
    public path: string,
    private env: Record<string, string>
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

    return promise;
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
        stdio: "inherit",
        env: {
          ...this.env,
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
    });
  }
}
