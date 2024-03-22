import {
  BatchTaskRunExecutionResult,
  ProdChildToWorkerMessages,
  ProdWorkerToChildMessages,
  TaskMetadataWithFilePath,
  TaskRunContext,
  TaskRunExecution,
  TaskRunExecutionResult,
} from "../schemas";
import { ZodIpcConnection } from "../zodIpc";
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

  _waitForRestore: { resolve: (value?: any) => void; reject: (err?: any) => void } | undefined;

  _tasks: Map<string, TaskMetadataWithFilePath> = new Map();

  constructor(
    private ipc: ZodIpcConnection<
      typeof ProdWorkerToChildMessages,
      typeof ProdChildToWorkerMessages
    >
  ) {}

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
    let timeout: NodeJS.Timeout | undefined;

    const now = Date.now();

    const resolveAfterDuration = new Promise((resolve) => {
      timeout = setTimeout(resolve, ms);
    });

    if (ms < 10_000) {
      await resolveAfterDuration;
      return;
    }

    const waitForRestore = new Promise<TaskRunExecutionResult>((resolve, reject) => {
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

    clearTimeout(timeout);
  }

  resumeAfterRestore(): void {
    if (!this._waitForRestore) {
      return;
    }

    this._waitForRestore.resolve();
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

    await this.ipc.send("WAIT_FOR_BATCH", {
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

    if (!wait) {
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
