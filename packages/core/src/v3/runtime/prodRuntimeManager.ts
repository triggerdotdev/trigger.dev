import { clock } from "../clock-api";
import { logger } from "../logger-api";
import {
  BatchTaskRunExecutionResult,
  ProdChildToWorkerMessages,
  ProdWorkerToChildMessages,
  TaskRunContext,
  TaskRunExecution,
  TaskRunExecutionResult,
} from "../schemas";
import { unboundedTimeout } from "../utils/timers";
import { ZodIpcConnection } from "../zodIpc";
import { RuntimeManager } from "./manager";

export type ProdRuntimeManagerOptions = {
  waitThresholdInMs?: number;
};

export class ProdRuntimeManager implements RuntimeManager {
  _taskWaits: Map<string, { resolve: (value: TaskRunExecutionResult) => void }> = new Map();

  _batchWaits: Map<
    string,
    { resolve: (value: BatchTaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  _waitForDuration:
    | { resolve: (value: "external") => void; reject: (err?: any) => void }
    | undefined;

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

    const internalTimeout = unboundedTimeout(ms, "internal" as const);

    if (ms <= this.waitThresholdInMs) {
      await internalTimeout;
      return;
    }

    const externalResume = new Promise<"external">((resolve, reject) => {
      this._waitForDuration = { resolve, reject };
    });

    const { willCheckpointAndRestore } = await this.ipc.sendWithAck("WAIT_FOR_DURATION", {
      ms,
      now,
    });

    if (!willCheckpointAndRestore) {
      await internalTimeout;
      return;
    }

    const getTimes = () => {
      return {
        date: Date.now(), // ms
        clock: clock.preciseNow()[0] * 1000, // seconds
        perf: performance.now(), // ms
      };
    };

    const preWait = getTimes();

    this.ipc.send("READY_FOR_CHECKPOINT", {});

    await internalTimeout;

    // The internal timer is up, let's check for missing time
    const postWait = getTimes();

    // Resets the clock to the current time
    clock.reset();

    const postReset = getTimes();

    const diffs = {
      t1: {
        date: postWait.date - preWait.date,
        clock: postWait.clock - preWait.clock,
        perf: postWait.perf - preWait.perf,
      },
      t2: {
        date: postReset.date - postWait.date,
        clock: postReset.clock - postWait.clock,
        perf: postReset.perf - postWait.perf,
      },
    };

    console.log({
      preWait,
      postWait,
      postReset,
      diffs,
    });

    logger.debug("diffs", {
      preWait,
      postWait,
      postReset,
      diffs,
    });

    // The coordinator should cancel any in-progress checkpoints
    const { checkpointCanceled, version } = await this.ipc.sendWithAck("CANCEL_CHECKPOINT", {
      version: "v2",
      reason: "WAIT_FOR_DURATION",
    });

    console.log({ checkpointCanceled, version });
    logger.debug("cancel checkpoint", { checkpointCanceled, version });

    if (checkpointCanceled) {
      // There won't be a checkpoint or external resume and we've already completed our internal timeout
      return;
    }

    console.log("Waiting for external resume");

    // No checkpoint was canceled, so we were checkpointed. We need to wait for the external resume message.
    await externalResume;

    console.log("Done waiting for external resume");
  }

  resumeAfterDuration(): void {
    if (!this._waitForDuration) {
      return;
    }

    process.stdout.write("pre");
    process.stdout.write(JSON.stringify(clock.preciseNow()));

    console.log("pre", clock.preciseNow());

    // Resets the clock to the current time
    clock.reset();

    console.log("post", clock.preciseNow());

    process.stdout.write("post");
    process.stdout.write(JSON.stringify(clock.preciseNow()));

    this._waitForDuration.resolve("external");
    this._waitForDuration = undefined;
  }

  async waitUntil(date: Date): Promise<void> {
    return this.waitForDuration(date.getTime() - Date.now());
  }

  async waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    const promise = new Promise<TaskRunExecutionResult>((resolve) => {
      this._taskWaits.set(params.id, { resolve });
    });

    await this.ipc.send("WAIT_FOR_TASK", {
      friendlyId: params.id,
    });

    const result = await promise;

    clock.reset();

    return result;
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

    clock.reset();

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

    wait.resolve(completion);

    this._taskWaits.delete(execution.run.id);
  }

  private get waitThresholdInMs(): number {
    return this.options.waitThresholdInMs ?? 30_000;
  }
}
