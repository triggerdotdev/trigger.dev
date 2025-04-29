import { assertExhaustive } from "../../utils.js";
import { clock } from "../clock-api.js";
import { lifecycleHooks } from "../lifecycle-hooks-api.js";
import {
  BatchTaskRunExecutionResult,
  CompletedWaitpoint,
  TaskRunContext,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunSuccessfulExecutionResult,
  WaitpointTokenResult,
} from "../schemas/index.js";
import { ExecutorToWorkerProcessConnection } from "../zodIpc.js";
import { RuntimeManager } from "./manager.js";
import { preventMultipleWaits } from "./preventMultipleWaits.js";

type Resolver = (value: CompletedWaitpoint) => void;

export class SharedRuntimeManager implements RuntimeManager {
  // Maps a resolver ID to a resolver function
  private readonly resolversById: Map<string, Resolver> = new Map();

  private _preventMultipleWaits = preventMultipleWaits();

  constructor(
    private ipc: ExecutorToWorkerProcessConnection,
    private showLogs: boolean
  ) {
    // Log out the runtime status on a long interval to help debug stuck executions
    setInterval(() => {
      this.log("[DEBUG] SharedRuntimeManager status", this.status);
    }, 300_000);
  }

  disable(): void {
    // do nothing
  }

  async waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    return this._preventMultipleWaits(async () => {
      const promise = new Promise<CompletedWaitpoint>((resolve) => {
        this.resolversById.set(params.id, resolve);
      });

      await lifecycleHooks.callOnWaitHookListeners({
        type: "task",
        runId: params.id,
      });

      const waitpoint = await promise;
      const result = this.waitpointToTaskRunExecutionResult(waitpoint);

      await lifecycleHooks.callOnResumeHookListeners({
        type: "task",
        runId: params.id,
      });

      return result;
    });
  }

  async waitForBatch(params: {
    id: string;
    runCount: number;
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult> {
    return this._preventMultipleWaits(async () => {
      if (!params.runCount) {
        return Promise.resolve({ id: params.id, items: [] });
      }

      const promises = Array.from({ length: params.runCount }, (_, index) => {
        const resolverId = `${params.id}_${index}`;

        return new Promise<CompletedWaitpoint>((resolve, reject) => {
          this.resolversById.set(resolverId, resolve);
        });
      });

      await lifecycleHooks.callOnWaitHookListeners({
        type: "batch",
        batchId: params.id,
        runCount: params.runCount,
      });

      const waitpoints = await Promise.all(promises);

      await lifecycleHooks.callOnResumeHookListeners({
        type: "batch",
        batchId: params.id,
        runCount: params.runCount,
      });

      return {
        id: params.id,
        items: waitpoints.map(this.waitpointToTaskRunExecutionResult),
      };
    });
  }

  async waitForWaitpoint({
    waitpointFriendlyId,
    finishDate,
  }: {
    waitpointFriendlyId: string;
    finishDate?: Date;
  }): Promise<WaitpointTokenResult> {
    return this._preventMultipleWaits(async () => {
      const promise = new Promise<CompletedWaitpoint>((resolve) => {
        this.resolversById.set(waitpointFriendlyId, resolve);
      });

      if (finishDate) {
        await lifecycleHooks.callOnWaitHookListeners({
          type: "duration",
          date: finishDate,
        });
      } else {
        await lifecycleHooks.callOnWaitHookListeners({
          type: "token",
          token: waitpointFriendlyId,
        });
      }

      const waitpoint = await promise;

      if (finishDate) {
        await lifecycleHooks.callOnResumeHookListeners({
          type: "duration",
          date: finishDate,
        });
      } else {
        await lifecycleHooks.callOnResumeHookListeners({
          type: "token",
          token: waitpointFriendlyId,
        });
      }

      return {
        ok: !waitpoint.outputIsError,
        output: waitpoint.output,
        outputType: waitpoint.outputType,
      };
    });
  }

  async resolveWaitpoints(waitpoints: CompletedWaitpoint[]): Promise<void> {
    await Promise.all(waitpoints.map((waitpoint) => this.resolveWaitpoint(waitpoint)));
  }

  private resolverIdFromWaitpoint(waitpoint: CompletedWaitpoint): string | null {
    switch (waitpoint.type) {
      case "RUN": {
        if (!waitpoint.completedByTaskRun) {
          this.log("No completedByTaskRun for RUN waitpoint", waitpoint);
          return null;
        }

        if (waitpoint.completedByTaskRun.batch) {
          // This run is part of a batch
          return `${waitpoint.completedByTaskRun.batch.friendlyId}_${waitpoint.index}`;
        } else {
          // This run is NOT part of a batch
          return waitpoint.completedByTaskRun.friendlyId;
        }
      }
      case "BATCH": {
        if (!waitpoint.completedByBatch) {
          this.log("No completedByBatch for BATCH waitpoint", waitpoint);
          return null;
        }

        return waitpoint.completedByBatch.friendlyId;
      }
      case "MANUAL":
      case "DATETIME": {
        return waitpoint.friendlyId;
      }
      default: {
        assertExhaustive(waitpoint.type);
      }
    }
  }

  private resolveWaitpoint(waitpoint: CompletedWaitpoint): void {
    this.log("resolveWaitpoint", waitpoint);

    if (waitpoint.type === "BATCH") {
      // We currently ignore these, they're not required to resume after a batch completes
      this.log("Ignoring BATCH waitpoint", waitpoint);
      return;
    }

    const resolverId = this.resolverIdFromWaitpoint(waitpoint);

    if (!resolverId) {
      this.log("No resolverId found for waitpoint", { ...this.status, ...waitpoint });
      return;
    }

    const resolve = this.resolversById.get(resolverId);

    if (!resolve) {
      this.log("No resolver found for resolverId", { ...this.status, resolverId });
      return;
    }

    this.log("Resolving waitpoint", waitpoint);

    // Ensure current time is accurate before resolving the waitpoint
    clock.reset();

    resolve(waitpoint);

    this.resolversById.delete(resolverId);
  }

  private waitpointToTaskRunExecutionResult(waitpoint: CompletedWaitpoint): TaskRunExecutionResult {
    if (!waitpoint.completedByTaskRun?.friendlyId) throw new Error("Missing completedByTaskRun");

    if (waitpoint.outputIsError) {
      return {
        ok: false,
        id: waitpoint.completedByTaskRun.friendlyId,
        error: waitpoint.output
          ? JSON.parse(waitpoint.output)
          : {
              type: "STRING_ERROR",
              message: "Missing error output",
            },
      } satisfies TaskRunFailedExecutionResult;
    } else {
      return {
        ok: true,
        id: waitpoint.completedByTaskRun.friendlyId,
        output: waitpoint.output,
        outputType: waitpoint.outputType ?? "application/json",
      } satisfies TaskRunSuccessfulExecutionResult;
    }
  }

  private log(message: string, ...args: any[]) {
    if (!this.showLogs) return;
    console.log(`[${new Date().toISOString()}] ${message}`, args);
  }

  private get status() {
    return {
      resolversById: Array.from(this.resolversById.keys()),
    };
  }
}
