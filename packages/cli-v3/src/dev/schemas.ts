import { z } from "zod";

export const TaskRun = z.object({
  id: z.string(),
  taskIdentifier: z.string(),
  payload: z.string(),
  payloadType: z.string(),
  context: z.any(),
  status: z.string(),
});

export type TaskRun = z.infer<typeof TaskRun>;

export const WorkerMessages = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("EXECUTE_TASK_RUN"),
    taskRun: TaskRun,
  }),
]);

export const TaskRunCompletion = z.object({
  id: z.string(),
  error: z.string().optional(),
  output: z.string().optional(),
  outputType: z.string().optional(),
});

export type TaskRunCompletion = z.infer<typeof TaskRunCompletion>;

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

export const ChildMessages = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("TASK_RUN_COMPLETED"),
    result: TaskRunCompletion,
  }),
  z.object({
    type: z.literal("TASKS_READY"),
    tasks: TaskMetadataWithFilePath.array(),
  }),
]);
