import { Evt } from "evt";
import { resolve as importResolve } from "import-meta-resolve";
import { fork } from "node:child_process";
import { z } from "zod";
import { TaskRunCompletion } from "../types";
import { ChildMessages, TaskMetadataWithFilePath, TaskRun } from "./schemas";

const backgroundWorkerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("PENDING_TASK_RUNS"),
    taskRuns: TaskRun.array(),
  }),
]);

export class BackgroundWorkerCoordinator {
  public onTaskCompleted: Evt<TaskRunCompletion> = new Evt();
  public onWorkerClosed: Evt<void> = new Evt();

  constructor(
    public id: string,
    private backgroundWorker: BackgroundWorker
  ) {
    this.backgroundWorker.onClose.attachOnce(() => {
      this.onWorkerClosed.post();
    });
  }

  async handleMessage(rawMessage: unknown) {
    const message = backgroundWorkerMessageSchema.safeParse(rawMessage);

    if (!message.success) {
      console.log("Received invalid message", { rawMessage });
      return;
    }

    switch (message.data.type) {
      case "PENDING_TASK_RUNS": {
        await Promise.all(message.data.taskRuns.map((taskRun) => this.#executeTaskRun(taskRun)));
      }
    }
  }

  async #executeTaskRun(taskRun: any) {
    const execution = await this.backgroundWorker.executeTaskRun(taskRun);

    this.onTaskCompleted.post(execution);
  }
}

export class BackgroundWorker {
  child: undefined | ReturnType<typeof fork>;
  tasks: undefined | Array<TaskMetadataWithFilePath>;
  onClose: Evt<void> = new Evt();

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

            break;
          }
        }
      });

      this.child.on("exit", (code) => {
        this.onClose.post();
      });
    });
  }
}
