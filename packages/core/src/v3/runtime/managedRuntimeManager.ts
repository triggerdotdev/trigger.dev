import {
  BatchTaskRunExecutionResult,
  TaskRunContext,
  TaskRunExecutionResult,
} from "../schemas/index.js";
import { RuntimeManager } from "./manager.js";
import { unboundedTimeout } from "../utils/timers.js";

type Waitpoint = any;

export class ManagedRuntimeManager implements RuntimeManager {
  private readonly waitpoints: Map<string, Waitpoint> = new Map();

  _taskWaits: Map<string, { resolve: (value: TaskRunExecutionResult) => void }> = new Map();

  _batchWaits: Map<
    string,
    { resolve: (value: BatchTaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  disable(): void {
    // do nothing
  }

  async waitForDuration(ms: number): Promise<void> {
    await unboundedTimeout(ms);
  }

  async waitUntil(date: Date): Promise<void> {
    return this.waitForDuration(date.getTime() - Date.now());
  }

  async waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    const promise = new Promise<TaskRunExecutionResult>((resolve) => {
      this._taskWaits.set(params.id, { resolve });
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
          this._taskWaits.set(runId, { resolve });
        });
      })
    );

    const results = await promise;

    return {
      id: params.id,
      items: results,
    };
  }

  async completeWaitpoints(waitpoints: Waitpoint[]): Promise<void> {
    await Promise.all(waitpoints.map((waitpoint) => this.completeWaitpoint(waitpoint)));
  }

  private completeWaitpoint(waitpoint: Waitpoint): void {
    const wait = this._taskWaits.get(waitpoint.id);

    if (!wait) {
      return;
    }

    wait.resolve(waitpoint.completion);

    this._taskWaits.delete(waitpoint.id);
  }
}
