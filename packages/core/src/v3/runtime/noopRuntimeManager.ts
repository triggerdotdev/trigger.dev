import {
  BatchTaskRunExecutionResult,
  TaskRunContext,
  TaskRunErrorCodes,
  TaskRunExecutionResult,
} from "../schemas/index.js";
import { RuntimeManager } from "./manager.js";

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
      error: {
        type: "INTERNAL_ERROR",
        code: TaskRunErrorCodes.CONFIGURED_INCORRECTLY,
      },
    });
  }

  waitForBatch(params: {
    id: string;
    runCount: number;
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult> {
    return Promise.resolve({
      id: params.id,
      items: [],
    });
  }
}
