import {
  BatchTaskRunExecutionResult,
  TaskRunContext,
  TaskRunExecutionResult,
  WaitpointTokenResult,
} from "../schemas/index.js";

export type EventWaitResult = {
  id: string;
  results: Record<string, TaskRunExecutionResult>;
};

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
  waitForEvent(params: {
    eventId: string;
    runs: Array<{ friendlyId: string; taskSlug: string }>;
    ctx: TaskRunContext;
  }): Promise<EventWaitResult>;
}
