import {
  BatchTaskRunExecutionResult,
  TaskMetadataWithFilePath,
  TaskRunContext,
  TaskRunExecution,
  TaskRunExecutionResult,
  childToWorkerMessages,
} from "../schemas";
import { ZodMessageSender } from "../zodMessageHandler";
import { RuntimeManager } from "./manager";

export class ProdRuntimeManager implements RuntimeManager {
  _taskWaits: Map<
    string,
    { resolve: (value: TaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  _batchWaits: Map<
    string,
    { resolve: (value: BatchTaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  _tasks: Map<string, TaskMetadataWithFilePath> = new Map();

  constructor(private sender: ZodMessageSender<typeof childToWorkerMessages>) {}

  disable(): void {
    // do nothing
  }

  registerTasks(tasks: TaskMetadataWithFilePath[]): void {
    for (const task of tasks) {
      this._tasks.set(task.id, task);
    }
  }

  getTaskMetadata(id: string): TaskMetadataWithFilePath | undefined {
    return this._tasks.get(id);
  }

  async waitForDuration(ms: number): Promise<void> {
    if (ms > 30_000) {
      // TODO: sender with ack support
      await this.sender.send("WAIT_FOR_DURATION", { ms });
      // TODO: resolve after resume signal instead
    }

    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async waitUntil(date: Date): Promise<void> {
    return this.waitForDuration(date.getTime() - Date.now());
  }

  async waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    const promise = new Promise<TaskRunExecutionResult>((resolve, reject) => {
      this._taskWaits.set(params.id, { resolve, reject });
    });

    await this.sender.send("WAIT_FOR_TASK", {
      id: params.id,
    });

    return await promise;
  }

  async waitForBatch(params: {
    id: string;
    runs: string[];
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult> {
    if (!params.runs.length) {
      return Promise.resolve({ id: params.id, items: [] });
    }

    const promise = Promise.all(
      params.runs.map((runId) => {
        return new Promise<TaskRunExecutionResult>((resolve, reject) => {
          this._taskWaits.set(runId, { resolve, reject });
        });
      })
    );

    await this.sender.send("WAIT_FOR_BATCH", {
      id: params.id,
      runs: params.runs,
    });

    const results = await promise;

    return {
      id: params.id,
      items: results,
    };
  }

  resumeTask(completion: TaskRunExecutionResult, execution: TaskRunExecution): void {
    const wait = this._taskWaits.get(execution.run.id);

    if (wait) {
      wait.resolve(completion);
      this._taskWaits.delete(execution.run.id);
    }
  }
}
