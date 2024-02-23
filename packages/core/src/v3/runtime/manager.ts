import {
  BatchTaskRunExecutionResult,
  TaskMetadataWithFilePath,
  TaskRunContext,
  TaskRunExecutionResult,
} from "../schemas";

export interface RuntimeManager {
  disable(): void;
  registerTasks(tasks: TaskMetadataWithFilePath[]): void;
  getTaskMetadata(id: string): TaskMetadataWithFilePath | undefined;
  waitUntil(date: Date): Promise<void>;
  waitForDuration(ms: number): Promise<void>;
  waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult>;
  waitForBatch(params: {
    id: string;
    runs: string[];
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult>;
}
