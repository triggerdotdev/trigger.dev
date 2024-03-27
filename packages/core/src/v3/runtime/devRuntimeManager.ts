import {
  BatchTaskRunExecutionResult,
  TaskMetadataWithFilePath,
  TaskRunContext,
  TaskRunExecution,
  TaskRunExecutionResult,
} from "../schemas";
import { conditionallyImportPacket } from "../utils/ioSerialization";
import { RuntimeManager } from "./manager";

export class DevRuntimeManager implements RuntimeManager {
  _taskWaits: Map<
    string,
    { resolve: (value: TaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  _batchWaits: Map<
    string,
    { resolve: (value: BatchTaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  _tasks: Map<string, TaskMetadataWithFilePath> = new Map();

  _pendingCompletionNotifications: Map<string, TaskRunExecutionResult> = new Map();

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
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async waitUntil(date: Date): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, date.getTime() - Date.now());
    });
  }

  async waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    const pendingCompletion = this._pendingCompletionNotifications.get(params.id);

    if (pendingCompletion) {
      this._pendingCompletionNotifications.delete(params.id);

      return pendingCompletion;
    }

    const promise = new Promise<TaskRunExecutionResult>((resolve, reject) => {
      this._taskWaits.set(params.id, { resolve, reject });
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
          const pendingCompletion = this._pendingCompletionNotifications.get(runId);

          if (pendingCompletion) {
            this._pendingCompletionNotifications.delete(runId);

            if (pendingCompletion.ok) {
              resolve(pendingCompletion);
            } else {
              reject(pendingCompletion);
            }

            return;
          }

          this._taskWaits.set(runId, { resolve, reject });
        });
      })
    );

    const results = await promise;

    return {
      id: params.id,
      items: results,
    };
  }

  resumeTask(completion: TaskRunExecutionResult, execution: TaskRunExecution): void {
    const wait = this._taskWaits.get(execution.run.id);

    if (!wait) {
      // We need to store the completion in case the task is awaited later
      this._pendingCompletionNotifications.set(execution.run.id, completion);

      return;
    }

    if (completion.ok) {
      wait.resolve(completion);
    } else {
      wait.reject(completion);
    }

    this._taskWaits.delete(execution.run.id);
  }
}
