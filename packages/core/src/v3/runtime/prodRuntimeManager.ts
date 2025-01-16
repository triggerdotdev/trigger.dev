import { clock } from "../clock-api.js";
import {
  BatchTaskRunExecutionResult,
  TaskRunContext,
  TaskRunExecutionResult,
} from "../schemas/index.js";
import { ExecutorToWorkerProcessConnection } from "../zodIpc.js";
import { RuntimeManager } from "./manager.js";
import { preventMultipleWaits } from "./preventMultipleWaits.js";

export type ProdRuntimeManagerOptions = {
  waitThresholdInMs?: number;
};

export class ProdRuntimeManager implements RuntimeManager {
  _taskWaits: Map<string, { resolve: (value: TaskRunExecutionResult) => void }> = new Map();

  _batchWaits: Map<
    string,
    { resolve: (value: BatchTaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  _waitForDuration: { resolve: (value: void) => void; reject: (err?: any) => void } | undefined;

  _preventMultipleWaits = preventMultipleWaits();

  constructor(
    private ipc: ExecutorToWorkerProcessConnection,
    private options: ProdRuntimeManagerOptions = {}
  ) {}

  disable(): void {
    // do nothing
  }

  async waitForDuration(ms: number): Promise<void> {
    return this._preventMultipleWaits(async () => {
      const now = Date.now();

      const resume = new Promise<void>((resolve, reject) => {
        this._waitForDuration = { resolve, reject };
      });

      await this.ipc.send("WAIT_FOR_DURATION", {
        ms,
        now,
        waitThresholdInMs: this.waitThresholdInMs,
      });

      await resume;
    });
  }

  resumeAfterDuration(): void {
    if (!this._waitForDuration) {
      return;
    }

    // Resets the clock to the current time
    clock.reset();

    this._waitForDuration.resolve();
    this._waitForDuration = undefined;
  }

  async waitUntil(date: Date): Promise<void> {
    return this.waitForDuration(date.getTime() - Date.now());
  }

  async waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    return this._preventMultipleWaits(async () => {
      const promise = new Promise<TaskRunExecutionResult>((resolve) => {
        this._taskWaits.set(params.id, { resolve });
      });

      await this.ipc.send("WAIT_FOR_TASK", {
        friendlyId: params.id,
      });

      const result = await promise;

      clock.reset();

      return result;
    });
  }

  async waitForBatch(params: {
    id: string;
    runs: string[];
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult> {
    return this._preventMultipleWaits(async () => {
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

      await this.ipc.send("WAIT_FOR_BATCH", {
        batchFriendlyId: params.id,
        runFriendlyIds: params.runs,
      });

      const results = await promise;

      clock.reset();

      return {
        id: params.id,
        items: results,
      };
    });
  }

  resumeTask(completion: TaskRunExecutionResult): void {
    const wait = this._taskWaits.get(completion.id);

    if (!wait) {
      return;
    }

    wait.resolve(completion);

    this._taskWaits.delete(completion.id);
  }

  private get waitThresholdInMs(): number {
    return this.options.waitThresholdInMs ?? 30_000;
  }
}
