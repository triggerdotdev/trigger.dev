import { setTimeout } from "node:timers/promises";
import { clock } from "../clock-api";
import {
  BatchTaskRunExecutionResult,
  ProdChildToWorkerMessages,
  ProdWorkerToChildMessages,
  TaskRunContext,
  TaskRunExecution,
  TaskRunExecutionResult,
} from "../schemas";
import { ZodIpcConnection } from "../zodIpc";
import { RuntimeManager } from "./manager";
import { unboundedTimeout } from "../utils/timers";

export type ProdRuntimeManagerOptions = {
  waitThresholdInMs?: number;
};

export class ProdRuntimeManager implements RuntimeManager {
  _taskWaits: Map<
    string,
    { resolve: (value: TaskRunExecutionResult) => void; reject?: (err?: any) => void }
  > = new Map();

  _batchWaits: Map<
    string,
    { resolve: (value: BatchTaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  _waitForRestore: { resolve: (value: "restore") => void; reject: (err?: any) => void } | undefined;

  constructor(
    private ipc: ZodIpcConnection<
      typeof ProdWorkerToChildMessages,
      typeof ProdChildToWorkerMessages
    >,
    private options: ProdRuntimeManagerOptions = {}
  ) {}

  disable(): void {
    // do nothing
  }

  async waitForDuration(ms: number): Promise<void> {
    const now = Date.now();

    const resolveAfterDuration = unboundedTimeout(ms, "duration" as const);

    if (ms <= this.waitThresholdInMs) {
      await resolveAfterDuration;
      return;
    }

    const waitForRestore = new Promise<"restore">((resolve, reject) => {
      this._waitForRestore = { resolve, reject };
    });

    const { willCheckpointAndRestore } = await this.ipc.sendWithAck("WAIT_FOR_DURATION", {
      ms,
      now,
    });

    if (!willCheckpointAndRestore) {
      await resolveAfterDuration;
      return;
    }

    this.ipc.send("READY_FOR_CHECKPOINT", {});

    // Don't wait for checkpoint beyond the requested wait duration
    await Promise.race([waitForRestore, resolveAfterDuration]);

    // The coordinator can then cancel any in-progress checkpoints
    this.ipc.send("CANCEL_CHECKPOINT", {});
  }

  resumeAfterRestore(): void {
    if (!this._waitForRestore) {
      return;
    }

    // Resets the clock to the current time
    clock.reset();

    this._waitForRestore.resolve("restore");
    this._waitForRestore = undefined;
  }

  async waitUntil(date: Date): Promise<void> {
    return this.waitForDuration(date.getTime() - Date.now());
  }

  async waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    const promise = new Promise<TaskRunExecutionResult>((resolve, reject) => {
      this._taskWaits.set(params.id, { resolve, reject });
    });

    await this.ipc.send("WAIT_FOR_TASK", {
      friendlyId: params.id,
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

    await this.ipc.send("WAIT_FOR_BATCH", {
      batchFriendlyId: params.id,
      runFriendlyIds: params.runs,
    });

    const results = await promise;

    return {
      id: params.id,
      items: results,
    };
  }

  resumeTask(completion: TaskRunExecutionResult, execution: TaskRunExecution): void {
    const wait = this._taskWaits.get(execution.run.id);

    if (!wait) {
      return;
    }

    if (!wait.reject) {
      wait.resolve(completion);
    } else {
      if (completion.ok) {
        wait.resolve(completion);
      } else {
        wait.reject(completion);
      }
    }

    this._taskWaits.delete(execution.run.id);
  }

  private get waitThresholdInMs(): number {
    return this.options.waitThresholdInMs ?? 30_000;
  }
}
