import { BatchTaskRunExecutionResult, TaskRunContext, TaskRunExecutionResult } from "../schemas";
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
    return Promise.resolve({
      ok: false,
      id: params.id,
      error: { type: "INTERNAL_ERROR", code: "CONFIGURED_INCORRECTLY" },
    });
  }

  waitForBatch(params: {
    id: string;
    runs: string[];
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult> {
    return Promise.resolve({
      id: params.id,
      items: [],
    });
  }
}
