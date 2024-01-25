import { TaskRunContext, TaskRunExecution, TaskRunExecutionResult } from "../schemas";
import { RuntimeManager } from "./manager";

export class DevRuntimeManager implements RuntimeManager {
  _taskWaits: Map<
    string,
    { resolve: (value: TaskRunExecutionResult) => void; reject: (err?: any) => void }
  > = new Map();

  disable(): void {
    // do nothing
  }

  async waitUntil(date: Date): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, date.getTime() - Date.now());
    });
  }

  async waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    const promise = new Promise<TaskRunExecutionResult>((resolve, reject) => {
      this._taskWaits.set(params.id, { resolve, reject });
    });

    return promise;
  }

  resumeTask(completion: TaskRunExecutionResult, execution: TaskRunExecution): void {
    const wait = this._taskWaits.get(execution.run.id);

    if (wait) {
      wait.resolve(completion);
      this._taskWaits.delete(execution.run.id);
    }
  }
}
