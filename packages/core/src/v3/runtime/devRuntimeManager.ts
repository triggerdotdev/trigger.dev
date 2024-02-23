import {
  BatchTaskRunExecutionResult,
  TaskRunContext,
  TaskRunExecution,
  TaskRunExecutionResult,
} from "../schemas";
import { SemanticInternalAttributes } from "../semanticInternalAttributes";
import { TriggerTracer } from "../tracer";
import { formatDurationMilliseconds } from "../utils/durations";
import { RuntimeManager } from "./manager";

export type DevRuntimeManagerOptions = {
  tracer: TriggerTracer;
};

export class DevRuntimeManager implements RuntimeManager {
  _taskWaits: Map<
    string,
    { resolve: (value: TaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  _batchWaits: Map<
    string,
    { resolve: (value: BatchTaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  constructor(private readonly options: DevRuntimeManagerOptions) {}

  disable(): void {
    // do nothing
  }

  async waitForDuration(ms: number): Promise<void> {
    return this.options.tracer.startActiveSpan(
      `Wait for ${formatDurationMilliseconds(ms, { style: "short" })}`,
      async (span) => {
        return new Promise((resolve) => {
          setTimeout(resolve, ms);
        });
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "wait",
        },
      }
    );
  }

  async waitUntil(date: Date): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, date.getTime() - Date.now());
    });
  }

  async waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    return this.options.tracer.startActiveSpan("wait for task", async (span) => {
      span.setAttribute("trigger.task.run.id", params.id);

      const promise = new Promise<TaskRunExecutionResult>((resolve, reject) => {
        this._taskWaits.set(params.id, { resolve, reject });
      });

      return await promise;
    });
  }

  async waitForBatch(params: {
    id: string;
    runs: string[];
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult> {
    return this.options.tracer.startActiveSpan("wait for batch", async (span) => {
      span.setAttribute("batch.id", params.id);
      span.setAttribute("batch.runs", params.runs.length);

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

      const results = await promise;

      return {
        id: params.id,
        items: results,
      };
    });
  }

  resumeTask(completion: TaskRunExecutionResult, execution: TaskRunExecution): void {
    const wait = this._taskWaits.get(execution.run.id);

    if (wait) {
      wait.resolve(completion);
      this._taskWaits.delete(execution.run.id);
    }
  }
}
