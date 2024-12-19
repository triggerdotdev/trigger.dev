import {
  BatchTaskRunExecutionResult,
  CompletedWaitpoint,
  RuntimeWait,
  TaskRunContext,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunSuccessfulExecutionResult,
} from "../schemas/index.js";
import { ExecutorToWorkerProcessConnection } from "../zodIpc.js";
import { RuntimeManager } from "./manager.js";

type Resolver = (value: CompletedWaitpoint) => void;

export class ManagedRuntimeManager implements RuntimeManager {
  // Maps a resolver ID to a resolver function
  private readonly resolversByWaitId: Map<string, Resolver> = new Map();
  // Maps a waitpoint ID to a wait ID
  private readonly resolversByWaitpoint: Map<string, string> = new Map();

  constructor(private ipc: ExecutorToWorkerProcessConnection) {
    setTimeout(() => {
      console.log("Runtime status", {
        resolversbyWaitId: this.resolversByWaitId.keys(),
        resolversByWaitpoint: this.resolversByWaitpoint.keys(),
      });
    }, 1000);
  }

  disable(): void {
    // do nothing
  }

  async waitForDuration(ms: number): Promise<void> {
    const wait = {
      type: "DATETIME",
      id: crypto.randomUUID(),
      date: new Date(Date.now() + ms),
    } satisfies RuntimeWait;

    const promise = new Promise<CompletedWaitpoint>((resolve) => {
      this.resolversByWaitId.set(wait.id, resolve);
    });

    // Send wait to parent process
    this.ipc.send("WAIT", { wait });

    await promise;
  }

  async waitUntil(date: Date): Promise<void> {
    return this.waitForDuration(date.getTime() - Date.now());
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
    runs: string[];
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult> {
    console.log("waitForBatch", params);

    if (!params.runs.length) {
      return Promise.resolve({ id: params.id, items: [] });
    }

    const promise = Promise.all(
      params.runs.map((runId) => {
        return new Promise<CompletedWaitpoint>((resolve, reject) => {
          this.resolversByWaitId.set(runId, resolve);
        });
      })
    );

    const waitpoints = await promise;

    return {
      id: params.id,
      items: waitpoints.map(this.waitpointToTaskRunExecutionResult),
    };
  }

  associateWaitWithWaitpoint(waitId: string, waitpointId: string) {
    this.resolversByWaitpoint.set(waitpointId, waitId);
  }

  async completeWaitpoints(waitpoints: CompletedWaitpoint[]): Promise<void> {
    await Promise.all(waitpoints.map((waitpoint) => this.completeWaitpoint(waitpoint)));
  }

  private completeWaitpoint(waitpoint: CompletedWaitpoint): void {
    console.log("completeWaitpoint", waitpoint);

    const waitId =
      waitpoint.completedByTaskRun?.friendlyId ?? this.resolversByWaitpoint.get(waitpoint.id);

    if (!waitId) {
      // TODO: Handle failures better
      console.log("No waitId found for waitpoint", waitpoint);
      return;
    }

    const resolve = this.resolversByWaitId.get(waitId);

    if (!resolve) {
      // TODO: Handle failures better
      console.log("No resolver found for waitId", waitId);
      return;
    }

    console.log("Resolving waitpoint", waitpoint);

    resolve(waitpoint);

    this.resolversByWaitId.delete(waitId);
  }

  private waitpointToTaskRunExecutionResult(waitpoint: CompletedWaitpoint): TaskRunExecutionResult {
    if (waitpoint.outputIsError) {
      return {
        ok: false,
        id: waitpoint.id,
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
        id: waitpoint.id,
        output: waitpoint.output,
        outputType: waitpoint.outputType ?? "application/json",
      } satisfies TaskRunSuccessfulExecutionResult;
    }
  }
}
