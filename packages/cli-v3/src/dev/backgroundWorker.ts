import { Evt } from "evt";
import { fork } from "node:child_process";
import { z } from "zod";
import { TaskRunCompletion } from "../types";
import { ChildMessages, TaskMetadataWithFilePath, TaskRun } from "./schemas";
import { CreateBackgroundWorkerResponse } from "@trigger.dev/core/v3";

const backgroundWorkerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("PENDING_TASK_RUNS"),
    taskRuns: TaskRun.array(),
  }),
]);

export type CurrentWorkers = BackgroundWorkerCoordinator["currentWorkers"];
export class BackgroundWorkerCoordinator {
  public onTaskCompleted: Evt<{
    backgroundWorkerId: string;
    execution: TaskRunCompletion;
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

  constructor() {}

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

  async handleMessage(id: string, rawMessage: unknown) {
    const message = backgroundWorkerMessageSchema.safeParse(rawMessage);

    if (!message.success) {
      console.log("Received invalid message", { rawMessage });
      return;
    }

    switch (message.data.type) {
      case "PENDING_TASK_RUNS": {
        await Promise.all(
          message.data.taskRuns.map((taskRun) => this.#executeTaskRun(id, taskRun))
        );
      }
    }
  }

  async #executeTaskRun(id: string, taskRun: any) {
    const worker = this._backgroundWorkers.get(id);

    if (!worker) {
      console.error(`Could not find worker ${id}`);
      return;
    }

    const execution = await worker.executeTaskRun(taskRun);

    this.onTaskCompleted.post({ execution, worker, backgroundWorkerId: id });
  }
}

export class BackgroundWorker {
  child: undefined | ReturnType<typeof fork>;
  tasks: undefined | Array<TaskMetadataWithFilePath>;
  onClosed: Evt<void> = new Evt();

  private _stopping: boolean = false;
  private _processClosing: boolean = false;

  _taskExecutions: Map<
    string,
    { resolve: (value: TaskRunCompletion) => void; reject: (err?: any) => void }
  > = new Map();

  constructor(
    public path: string,
    private env: Record<string, string>
  ) {}

  async executeTaskRun(taskRun: any) {
    if (!this.child) {
      throw new Error("Worker not started");
    }

    if (this.child.exitCode !== null) {
      throw new Error(`Worker is killed with exit code ${this.child.exitCode}`);
    }

    const promise = new Promise<TaskRunCompletion>((resolve, reject) => {
      this._taskExecutions.set(taskRun.id, { resolve, reject });
    });

    this.child?.send({
      type: "EXECUTE_TASK_RUN",
      taskRun,
    });

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
      this.child = fork(this.path, {
        stdio: "inherit",
        env: {
          ...this.env,
        },
      });

      this.child.on("message", (msg: any) => {
        const message = ChildMessages.safeParse(msg);

        if (!message.success) {
          console.log("Received invalid message", { rawMessage: msg });
          return;
        }

        switch (message.data.type) {
          case "TASKS_READY": {
            this.tasks = message.data.tasks;
            resolve();

            break;
          }
          case "TASK_RUN_COMPLETED": {
            const taskExecutor = this._taskExecutions.get(message.data.result.id);

            if (!taskExecutor) {
              console.error(`Could not find task executor for task ${message.data.result.id}`);
              return;
            }

            this._taskExecutions.delete(message.data.result.id);

            taskExecutor.resolve(message.data.result);

            if (this._stopping && this._taskExecutions.size === 0) {
              this.#kill();
            }

            break;
          }
        }
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
