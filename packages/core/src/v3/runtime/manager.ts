import {
  BatchTaskRunExecutionResult,
  TaskRunContext,
  TaskRunExecutionResult,
  WaitpointTokenResult,
} from "../schemas/index.js";

export interface RuntimeManager {
  disable(): void;
  waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult>;
  waitForBatch(params: {
    id: string;
    runCount: number;
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult>;
  waitForWaitpoint(params: {
    waitpointFriendlyId: string;
    finishDate?: Date;
  }): Promise<WaitpointTokenResult>;
}
