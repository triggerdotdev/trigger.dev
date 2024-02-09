import { TaskRunContext, TaskRunExecution, TaskRunExecutionResult } from "../schemas";
import { TriggerTracer } from "../tracer";
import { RuntimeManager } from "./manager";

export type DevRuntimeManagerOptions = {
  tracer: TriggerTracer;
};

export class DevRuntimeManager implements RuntimeManager {
  _taskWaits: Map<
    string,
    { resolve: (value: TaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  constructor(private readonly options: DevRuntimeManagerOptions) {}

  disable(): void {
    // do nothing
  }

  async waitForDuration(ms: number): Promise<void> {
    return this.options.tracer.startActiveSpan("wait for duration", async (span) => {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    });
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

  resumeTask(completion: TaskRunExecutionResult, execution: TaskRunExecution): void {
    const wait = this._taskWaits.get(execution.run.id);

    if (wait) {
      wait.resolve(completion);
      this._taskWaits.delete(execution.run.id);
    }
  }
}
