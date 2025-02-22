import {
  BatchTaskRunExecutionResult,
  TaskRunContext,
  TaskRunExecutionResult,
  WaitForWaitpointTokenRequestBody,
  WaitpointTokenResult,
} from "../schemas/index.js";

export interface RuntimeManager {
  disable(): void;
  waitUntil(date: Date): Promise<void>;
  waitForDuration(ms: number): Promise<void>;
  waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult>;
  waitForBatch(params: {
    id: string;
    runCount: number;
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult>;
  waitForToken(
    waitpointFriendlyId: string,
    options?: WaitForWaitpointTokenRequestBody
  ): Promise<WaitpointTokenResult>;
}
