import { z } from "zod";
import { TaskRunExecutionResult, TaskRunExecution } from "./common";
import { BackgroundWorkerRecord } from "./api";

export const BackgroundWorkerServerMessages = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("EXECUTE_RUNS"),
    executions: TaskRunExecution.array(),
  }),
]);

export type BackgroundWorkerServerMessages = z.infer<typeof BackgroundWorkerServerMessages>;

export const serverWebsocketMessages = {
  SERVER_READY: z.object({
    version: z.literal("v1").default("v1"),
    id: z.string(),
  }),
  BACKGROUND_WORKER_MESSAGE: z.object({
    version: z.literal("v1").default("v1"),
    backgroundWorkerId: z.string(),
    data: BackgroundWorkerServerMessages,
  }),
};

export const BackgroundWorkerClientMessages = z.discriminatedUnion("type", [
  z.object({
    version: z.literal("v1").default("v1"),
    type: z.literal("TASK_RUN_COMPLETED"),
    completion: TaskRunExecutionResult,
  }),
]);

export type BackgroundWorkerClientMessages = z.infer<typeof BackgroundWorkerClientMessages>;

export const clientWebsocketMessages = {
  READY_FOR_TASKS: z.object({
    version: z.literal("v1").default("v1"),
    backgroundWorkerId: z.string(),
  }),
  WORKER_DEPRECATED: z.object({
    version: z.literal("v1").default("v1"),
    backgroundWorkerId: z.string(),
  }),
  BACKGROUND_WORKER_MESSAGE: z.object({
    version: z.literal("v1").default("v1"),
    backgroundWorkerId: z.string(),
    data: BackgroundWorkerClientMessages,
  }),
};

export const workerToChildMessages = {
  EXECUTE_TASK_RUN: z.object({
    version: z.literal("v1").default("v1"),
    execution: TaskRunExecution,
    metadata: BackgroundWorkerRecord,
  }),
  TASK_RUN_COMPLETED: z.object({
    version: z.literal("v1").default("v1"),
    completion: TaskRunExecutionResult,
    execution: TaskRunExecution,
  }),
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
  TASK_RUN_COMPLETED: z.object({
    version: z.literal("v1").default("v1"),
    result: TaskRunExecutionResult,
  }),
  TASKS_READY: z.object({
    version: z.literal("v1").default("v1"),
    tasks: TaskMetadataWithFilePath.array(),
  }),
};
