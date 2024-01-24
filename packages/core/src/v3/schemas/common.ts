import { z } from "zod";

export const TaskRun = z.object({
  id: z.string(),
  payload: z.string(),
  payloadType: z.string(),
  context: z.any(),
  tags: z.array(z.string()),
  createdAt: z.coerce.date(),
});

export type TaskRun = z.infer<typeof TaskRun>;

export const TaskRunExecutionTask = z.object({
  id: z.string(),
  filePath: z.string(),
  exportName: z.string(),
});

export type TaskRunExecutionTask = z.infer<typeof TaskRunExecutionTask>;

export const TaskRunExecutionAttempt = z.object({
  id: z.string(),
  number: z.number(),
  startedAt: z.coerce.date(),
  backgroundWorkerId: z.string(),
  backgroundWorkerTaskId: z.string(),
  status: z.string(),
});

export type TaskRunExecutionAttempt = z.infer<typeof TaskRunExecutionAttempt>;

export const TaskRunExecutionEnvironment = z.object({
  id: z.string(),
  slug: z.string(),
  type: z.enum(["PRODUCTION", "STAGING", "DEVELOPMENT", "PREVIEW"]),
});

export type TaskRunExecutionEnvironment = z.infer<typeof TaskRunExecutionEnvironment>;

export const TaskRunExecutionOrganization = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});

export type TaskRunExecutionOrganization = z.infer<typeof TaskRunExecutionOrganization>;

export const TaskRunExecutionProject = z.object({
  id: z.string(),
  ref: z.string(),
  slug: z.string(),
  name: z.string(),
});

export type TaskRunExecutionProject = z.infer<typeof TaskRunExecutionProject>;

export const TaskRunExecution = z.object({
  task: TaskRunExecutionTask,
  attempt: TaskRunExecutionAttempt,
  run: TaskRun,
  environment: TaskRunExecutionEnvironment,
  organization: TaskRunExecutionOrganization,
  project: TaskRunExecutionProject,
});

export type TaskRunExecution = z.infer<typeof TaskRunExecution>;

export const TaskRunContext = z.object({
  task: TaskRunExecutionTask,
  attempt: TaskRunExecutionAttempt.omit({ backgroundWorkerId: true, backgroundWorkerTaskId: true }),
  run: TaskRun.omit({ payload: true, payloadType: true }),
  environment: TaskRunExecutionEnvironment,
  organization: TaskRunExecutionOrganization,
  project: TaskRunExecutionProject,
});

export type TaskRunContext = z.infer<typeof TaskRunContext>;

export const TaskRunFailedExecutionResult = z.object({
  ok: z.literal(false),
  id: z.string(),
  error: z.string(),
});

export type TaskRunFailedExecutionResult = z.infer<typeof TaskRunFailedExecutionResult>;

export const TaskRunSuccessfulExecutionResult = z.object({
  ok: z.literal(true),
  id: z.string(),
  output: z.string(),
  outputType: z.string(),
});

export type TaskRunSuccessfulExecutionResult = z.infer<typeof TaskRunSuccessfulExecutionResult>;

export const TaskRunExecutionResult = z.discriminatedUnion("ok", [
  TaskRunSuccessfulExecutionResult,
  TaskRunFailedExecutionResult,
]);

export type TaskRunExecutionResult = z.infer<typeof TaskRunExecutionResult>;
