import {
  BatchTaskRunExecutionResult,
  CompletedWaitpoint,
  RuntimeWait,
  TaskRunContext,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunSuccessfulExecutionResult,
  WaitpointTokenResult,
} from "../schemas/index.js";
import { ExecutorToWorkerProcessConnection } from "../zodIpc.js";
import { RuntimeManager } from "./manager.js";

type Resolver = (value: CompletedWaitpoint) => void;

export class ManagedRuntimeManager implements RuntimeManager {
  // Maps a resolver ID to a resolver function
  private readonly resolversByWaitId: Map<string, Resolver> = new Map();
  // Maps a waitpoint ID to a wait ID
  private readonly resolversByWaitpoint: Map<string, string> = new Map();

  constructor(
    private ipc: ExecutorToWorkerProcessConnection,
    private showLogs: boolean
  ) {
    setTimeout(() => {
      this.log("Runtime status", {
        resolversbyWaitId: this.resolversByWaitId.keys(),
        resolversByWaitpoint: this.resolversByWaitpoint.keys(),
      });
    }, 1000);
  }

  disable(): void {
    // do nothing
  }

  async waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    const promise = new Promise<CompletedWaitpoint>((resolve) => {
      this.resolversByWaitId.set(params.id, resolve);
    });

    const waitpoint = await promise;
    const result = this.waitpointToTaskRunExecutionResult(waitpoint);

    return result;
  }

  async waitForBatch(params: {
    id: string;
    runCount: number;
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult> {
    if (!params.runCount) {
      return Promise.resolve({ id: params.id, items: [] });
    }

    const promise = Promise.all(
      Array.from({ length: params.runCount }, (_, index) => {
        const resolverId = `${params.id}_${index}`;
        return new Promise<CompletedWaitpoint>((resolve, reject) => {
          this.resolversByWaitId.set(resolverId, resolve);
        });
      })
    );

    const waitpoints = await promise;

    return {
      id: params.id,
      items: waitpoints.map(this.waitpointToTaskRunExecutionResult),
    };
  }

  async waitForWaitpoint({
    waitpointFriendlyId,
    finishDate,
  }: {
    waitpointFriendlyId: string;
    finishDate?: Date;
  }): Promise<WaitpointTokenResult> {
    const promise = new Promise<CompletedWaitpoint>((resolve) => {
      this.resolversByWaitId.set(waitpointFriendlyId, resolve);
    });

    const waitpoint = await promise;

    return {
      ok: !waitpoint.outputIsError,
      output: waitpoint.output,
      outputType: waitpoint.outputType,
    };
  }

  associateWaitWithWaitpoint(waitId: string, waitpointId: string) {
    this.resolversByWaitpoint.set(waitpointId, waitId);
  }

  async completeWaitpoints(waitpoints: CompletedWaitpoint[]): Promise<void> {
    await Promise.all(waitpoints.map((waitpoint) => this.completeWaitpoint(waitpoint)));
  }

  private completeWaitpoint(waitpoint: CompletedWaitpoint): void {
    this.log("completeWaitpoint", waitpoint);

    let waitId: string | undefined;

    if (waitpoint.completedByTaskRun) {
      if (waitpoint.completedByTaskRun.batch) {
        waitId = `${waitpoint.completedByTaskRun.batch.friendlyId}_${waitpoint.index}`;
      } else {
        waitId = waitpoint.completedByTaskRun.friendlyId;
      }
    } else if (waitpoint.completedByBatch) {
      //no waitpoint resolves associated with batch completions
      //a batch completion isn't when all the runs from a batch are completed
      return;
    } else if (waitpoint.type === "MANUAL" || waitpoint.type === "DATETIME") {
      waitId = waitpoint.friendlyId;
    } else {
      waitId = this.resolversByWaitpoint.get(waitpoint.id);
    }

    if (!waitId) {
      // TODO: Handle failures better
      this.log("No waitId found for waitpoint", waitpoint);
      return;
    }

    const resolve = this.resolversByWaitId.get(waitId);

    if (!resolve) {
      // TODO: Handle failures better
      this.log("No resolver found for waitId", waitId);
      return;
    }

    this.log("Resolving waitpoint", waitpoint);

    resolve(waitpoint);

    this.resolversByWaitId.delete(waitId);
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
}
