import { z } from "zod";
import { TaskRunExecutionResult, TaskRunExecution } from "./common";

export const BackgroundWorkerServerMessages = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("EXECUTE_RUNS"),
    executions: TaskRunExecution.array(),
  }),
]);

export type BackgroundWorkerServerMessages = z.infer<typeof BackgroundWorkerServerMessages>;

export const serverWebsocketMessages = {
  SERVER_READY: z.object({
    id: z.string(),
  }),
  BACKGROUND_WORKER_MESSAGE: z.object({
    backgroundWorkerId: z.string(),
    data: BackgroundWorkerServerMessages,
  }),
};

export const BackgroundWorkerClientMessages = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("TASK_RUN_COMPLETED"),
    completion: TaskRunExecutionResult,
  }),
]);

export type BackgroundWorkerClientMessages = z.infer<typeof BackgroundWorkerClientMessages>;

export const clientWebsocketMessages = {
  READY_FOR_TASKS: z.object({
    backgroundWorkerId: z.string(),
  }),
  WORKER_SHUTDOWN: z.object({
    backgroundWorkerId: z.string(),
  }),
  WORKER_STOPPED: z.object({
    backgroundWorkerId: z.string(),
  }),
  BACKGROUND_WORKER_MESSAGE: z.object({
    backgroundWorkerId: z.string(),
    data: BackgroundWorkerClientMessages,
  }),
};

export const workerToChildMessages = {
  EXECUTE_TASK_RUN: TaskRunExecution,
};

export const TaskMetadata = z.object({
  id: z.string(),
  exportName: z.string(),
  packageVersion: z.string(),
});

export type TaskMetadata = z.infer<typeof TaskMetadata>;

export const TaskMetadataWithFilePath = TaskMetadata.extend({
  filePath: z.string(),
});

export type TaskMetadataWithFilePath = z.infer<typeof TaskMetadataWithFilePath>;

export const childToWorkerMessages = {
  TASK_RUN_COMPLETED: TaskRunExecutionResult,
  TASKS_READY: TaskMetadataWithFilePath.array(),
};
