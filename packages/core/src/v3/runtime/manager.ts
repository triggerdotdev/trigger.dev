import {
  BatchTaskRunExecutionResult,
  TaskRunContext,
  TaskRunExecutionResult,
} from "../schemas/index.js";

export interface RuntimeManager {
  disable(): void;
  waitUntil(date: Date): Promise<void>;
  waitForDuration(ms: number): Promise<void>;
  waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult>;
  waitForBatch(params: {
    id: string;
    runs: string[];
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult>;
}
