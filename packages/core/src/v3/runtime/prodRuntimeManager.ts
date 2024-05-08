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
import { checkpointSafeTimeout, unboundedTimeout } from "../utils/timers";
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
    const checkpointSafeInternalTimeout = checkpointSafeTimeout(ms);

    if (ms <= this.waitThresholdInMs) {
      await internalTimeout;
      return;
    }

    const externalResume = new Promise<"external">((resolve, reject) => {
      this._waitForDuration = { resolve, reject };
    });

    const { willCheckpointAndRestore } = await this.ipc.sendWithAck(
      "WAIT_FOR_DURATION",
      {
        ms,
        now,
      },
      10_000
    );

    if (!willCheckpointAndRestore) {
      await internalTimeout;
      return;
    }

    this.ipc.send("READY_FOR_CHECKPOINT", {});

    // internalTimeout acts as a backup and will be accurate if the checkpoint never happens
    // checkpointSafeInternalTimeout is accurate even after non-simulated restores
    await Promise.race([internalTimeout, checkpointSafeInternalTimeout]);

    // Resets the clock to the current time
    clock.reset();

    try {
      // The coordinator should cancel any in-progress checkpoints
      const { checkpointCanceled, version } = await this.ipc.sendWithAck(
        "CANCEL_CHECKPOINT",
        {
          version: "v2",
          reason: "WAIT_FOR_DURATION",
        },
        10_000
      );

      if (checkpointCanceled) {
        // There won't be a checkpoint or external resume and we've already completed our internal timeout
        return;
      }
    } catch (error) {
      // If the cancellation times out, we will proceed as if the checkpoint was canceled
      logger.debug("Checkpoint cancellation timed out", { error });
      return;
    }

    // No checkpoint was canceled, so we were checkpointed. We need to wait for the external resume message.
    await externalResume;
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
