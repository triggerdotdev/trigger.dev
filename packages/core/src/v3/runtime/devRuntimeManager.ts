import { runMetadata } from "../run-metadata-api.js";
import {
  BatchTaskRunExecutionResult,
  TaskRunContext,
  TaskRunExecutionResult,
} from "../schemas/index.js";
import { unboundedTimeout } from "../utils/timers.js";
import { RuntimeManager } from "./manager.js";
import { preventMultipleWaits } from "./preventMultipleWaits.js";

export class DevRuntimeManager implements RuntimeManager {
  _taskWaits: Map<string, { resolve: (value: TaskRunExecutionResult) => void }> = new Map();

  _batchWaits: Map<
    string,
    { resolve: (value: BatchTaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  _pendingCompletionNotifications: Map<string, TaskRunExecutionResult> = new Map();

  _preventMultipleWaits = preventMultipleWaits();

  disable(): void {
    // do nothing
  }

  async waitForDuration(ms: number): Promise<void> {
    await this._preventMultipleWaits(() => unboundedTimeout(ms));
  }

  async waitUntil(date: Date): Promise<void> {
    return this.waitForDuration(date.getTime() - Date.now());
  }

  async waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    return this._preventMultipleWaits(async () => {
      const pendingCompletion = this._pendingCompletionNotifications.get(params.id);

      if (pendingCompletion) {
        this._pendingCompletionNotifications.delete(params.id);

        return pendingCompletion;
      }

      const promise = new Promise<TaskRunExecutionResult>((resolve) => {
        this._taskWaits.set(params.id, { resolve });
      });

      await this.#tryFlushMetadata();

      return await promise;
    });
  }

  async waitForBatch(params: {
    id: string;
    runCount: number;
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult> {
    throw new Error("Method not implemented.");

    // return this._preventMultipleWaits(async () => {
    //   if (!params.runs.length) {
    //     return Promise.resolve({ id: params.id, items: [] });
    //   }

    //   const promise = Promise.all(
    //     params.runs.map((runId) => {
    //       return new Promise<TaskRunExecutionResult>((resolve, reject) => {
    //         const pendingCompletion = this._pendingCompletionNotifications.get(runId);

    //         if (pendingCompletion) {
    //           this._pendingCompletionNotifications.delete(runId);

    //           resolve(pendingCompletion);

    //           return;
    //         }

    //         this._taskWaits.set(runId, { resolve });
    //       });
    //     })
    //   );

    //   await this.#tryFlushMetadata();

    //   const results = await promise;

    //   return {
    //     id: params.id,
    //     items: results,
    //   };
    // });
  }

  resumeTask(completion: TaskRunExecutionResult, runId: string): void {
    const wait = this._taskWaits.get(runId);

    if (!wait) {
      // We need to store the completion in case the task is awaited later
      this._pendingCompletionNotifications.set(runId, completion);

      return;
    }

    wait.resolve(completion);

    this._taskWaits.delete(runId);
  }

  async #tryFlushMetadata() {
    try {
      await runMetadata.flush();
    } catch (err) {}
  }
}
