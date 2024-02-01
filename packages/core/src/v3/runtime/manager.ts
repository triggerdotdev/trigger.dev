import { TaskRunContext, TaskRunExecutionResult } from "../schemas";

export interface RuntimeManager {
  disable(): void;
  waitUntil(date: Date): Promise<void>;
  waitForDuration(ms: number): Promise<void>;
  waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult>;
}
