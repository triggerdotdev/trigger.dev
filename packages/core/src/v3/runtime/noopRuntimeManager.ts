import { TaskRunContext, TaskRunExecutionResult } from "../schemas";
import { RuntimeManager } from "./manager";

export class NoopRuntimeManager implements RuntimeManager {
  disable(): void {
    // do nothing
  }

  waitForDuration(ms: number): Promise<void> {
    return Promise.resolve();
  }

  waitUntil(date: Date): Promise<void> {
    return Promise.resolve();
  }

  waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    throw new Error("Method not implemented.");
  }
}
