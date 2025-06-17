import { assertExhaustive } from "../../utils.js";
import { clock } from "../clock-api.js";
import { lifecycleHooks } from "../lifecycle-hooks-api.js";
import { DebugLogPropertiesInput } from "../runEngineWorker/index.js";
import {
  BatchTaskRunExecutionResult,
  CompletedWaitpoint,
  TaskRunContext,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunSuccessfulExecutionResult,
  WaitpointTokenResult,
} from "../schemas/index.js";
import { tryCatch } from "../tryCatch.js";
import { ExecutorToWorkerProcessConnection } from "../zodIpc.js";
import { RuntimeManager } from "./manager.js";
import { preventMultipleWaits } from "./preventMultipleWaits.js";

/** A function that resolves a waitpoint */
type Resolver = (value: CompletedWaitpoint) => void;

/** Branded type for resolver IDs to keep us from doing anything stupid */
type ResolverId = string & { readonly __brand: unique symbol };

export class SharedRuntimeManager implements RuntimeManager {
  /** Maps a resolver ID to a resolver function */
  private readonly resolversById = new Map<ResolverId, Resolver>();

  /** Stores waitpoints that arrive before their resolvers have been created */
  private readonly waitpointsByResolverId = new Map<ResolverId, CompletedWaitpoint>();

  private _preventMultipleWaits = preventMultipleWaits();

  constructor(
    private ipc: ExecutorToWorkerProcessConnection,
    private showLogs: boolean
  ) {
    // Log out the runtime status on a long interval to help debug stuck executions
    setInterval(() => {
      this.debugLog("SharedRuntimeManager status");
    }, 300_000);
  }

  reset(): void {
    this.resolversById.clear();
    this.waitpointsByResolverId.clear();
  }

  disable(): void {
    // do nothing
  }

  async waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    return this._preventMultipleWaits(async () => {
      const promise = new Promise<CompletedWaitpoint>((resolve) => {
        this.resolversById.set(params.id as ResolverId, resolve);
      });

      // Resolve any waitpoints we received before the resolver was created
      this.resolvePendingWaitpoints();

      await lifecycleHooks.callOnWaitHookListeners({
        type: "task",
        runId: params.id,
      });

      const waitpoint = await this.suspendable(promise);
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
        const resolverId = `${params.id}_${index}` as ResolverId;

        return new Promise<CompletedWaitpoint>((resolve, reject) => {
          this.resolversById.set(resolverId, resolve);
        });
      });

      // Resolve any waitpoints we received before the resolvers were created
      this.resolvePendingWaitpoints();

      await lifecycleHooks.callOnWaitHookListeners({
        type: "batch",
        batchId: params.id,
        runCount: params.runCount,
      });

      const waitpoints = await this.suspendable(Promise.all(promises));

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
        this.resolversById.set(waitpointFriendlyId as ResolverId, resolve);
      });

      // Resolve any waitpoints we received before the resolver was created
      this.resolvePendingWaitpoints();

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

      const waitpoint = await this.suspendable(promise);

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

  private resolverIdFromWaitpoint(waitpoint: CompletedWaitpoint): ResolverId | null {
    let id: string;

    switch (waitpoint.type) {
      case "RUN": {
        if (!waitpoint.completedByTaskRun) {
          this.debugLog("no completedByTaskRun for RUN waitpoint", {
            waitpoint: this.waitpointForDebugLog(waitpoint),
          });
          return null;
        }

        if (waitpoint.completedByTaskRun.batch) {
          // This run is part of a batch
          id = `${waitpoint.completedByTaskRun.batch.friendlyId}_${waitpoint.index}`;
        } else {
          // This run is NOT part of a batch
          id = waitpoint.completedByTaskRun.friendlyId;
        }

        break;
      }
      case "BATCH": {
        if (!waitpoint.completedByBatch) {
          this.debugLog("no completedByBatch for BATCH waitpoint", {
            waitpoint: this.waitpointForDebugLog(waitpoint),
          });
          return null;
        }

        id = waitpoint.completedByBatch.friendlyId;
        break;
      }
      case "MANUAL":
      case "DATETIME": {
        id = waitpoint.friendlyId;
        break;
      }
      default: {
        assertExhaustive(waitpoint.type);
      }
    }

    return id as ResolverId;
  }

  private resolveWaitpoint(waitpoint: CompletedWaitpoint, resolverId?: ResolverId | null): void {
    // This is spammy, don't make this a debug log
    this.log("resolveWaitpoint", waitpoint);

    if (waitpoint.type === "BATCH") {
      // We currently ignore these, they're not required to resume after a batch completes
      this.debugLog("ignoring BATCH waitpoint", {
        waitpoint: this.waitpointForDebugLog(waitpoint),
      });
      return;
    }

    resolverId = resolverId ?? this.resolverIdFromWaitpoint(waitpoint);

    if (!resolverId) {
      this.debugLog("no resolverId for waitpoint", {
        waitpoint: this.waitpointForDebugLog(waitpoint),
      });

      // No need to store the waitpoint, we'll never be able to resolve it
      return;
    }

    const resolve = this.resolversById.get(resolverId);

    if (!resolve) {
      this.debugLog("no resolver found for resolverId", {
        resolverId,
        waitpoint: this.waitpointForDebugLog(waitpoint),
      });

      // Store the waitpoint for later if we can't find a resolver
      this.waitpointsByResolverId.set(resolverId, waitpoint);

      return;
    }

    // Ensure current time is accurate before resolving the waitpoint
    clock.reset();

    resolve(waitpoint);

    this.resolversById.delete(resolverId);
    this.waitpointsByResolverId.delete(resolverId);
  }

  private resolvePendingWaitpoints(): void {
    for (const [resolverId, waitpoint] of this.waitpointsByResolverId.entries()) {
      this.resolveWaitpoint(waitpoint, resolverId);
    }
  }

  private setSuspendable(suspendable: boolean): void {
    this.ipc.send("SET_SUSPENDABLE", { suspendable });
  }

  private async suspendable<T>(promise: Promise<T>): Promise<T> {
    this.setSuspendable(true);
    const [error, result] = await tryCatch(promise);
    this.setSuspendable(false);

    if (error) {
      this.debugLog("error in suspendable wrapper", { error: String(error) });
      throw error;
    }

    return result;
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

  private waitpointForDebugLog(waitpoint: CompletedWaitpoint): DebugLogPropertiesInput {
    const { completedAfter, completedAt, output, ...rest } = waitpoint;

    return {
      ...rest,
      output: output?.slice(0, 100),
      completedAfter: completedAfter?.toISOString(),
      completedAt: completedAt?.toISOString(),
      completedAfterDate: completedAfter,
      completedAtDate: completedAt,
    };
  }

  private debugLog(message: string, properties?: DebugLogPropertiesInput) {
    if (this.showLogs) {
      console.log(`[${new Date().toISOString()}] ${message}`, {
        runtimeStatus: this.status,
        ...properties,
      });
    }

    this.ipc.send("SEND_DEBUG_LOG", {
      message,
      properties: {
        runtimeStatus: this.status,
        ...properties,
      },
    });
  }

  private log(message: string, ...args: any[]) {
    if (!this.showLogs) return;
    console.log(`[${new Date().toISOString()}] ${message}`, args);
  }

  private get status() {
    return {
      resolversById: Array.from(this.resolversById.keys()),
      waitpointsByResolverId: Array.from(this.waitpointsByResolverId.keys()),
    };
  }
}
