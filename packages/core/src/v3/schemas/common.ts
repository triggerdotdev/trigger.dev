import { z } from "zod";

export const TaskRunBuiltInError = z.object({
  type: z.literal("BUILT_IN_ERROR"),
  name: z.string(),
  message: z.string(),
  stackTrace: z.string(),
});

export type TaskRunBuiltInError = z.infer<typeof TaskRunBuiltInError>;

export const TaskRunCustomErrorObject = z.object({
  type: z.literal("CUSTOM_ERROR"),
  raw: z.string(),
});

export type TaskRunCustomErrorObject = z.infer<typeof TaskRunCustomErrorObject>;

export const TaskRunStringError = z.object({
  type: z.literal("STRING_ERROR"),
  raw: z.string(),
});

export type TaskRunStringError = z.infer<typeof TaskRunStringError>;

export const TaskRunErrorCodes = {
  COULD_NOT_FIND_EXECUTOR: "COULD_NOT_FIND_EXECUTOR",
  COULD_NOT_FIND_TASK: "COULD_NOT_FIND_TASK",
  CONFIGURED_INCORRECTLY: "CONFIGURED_INCORRECTLY",
  TASK_ALREADY_RUNNING: "TASK_ALREADY_RUNNING",
  TASK_EXECUTION_FAILED: "TASK_EXECUTION_FAILED",
  TASK_EXECUTION_ABORTED: "TASK_EXECUTION_ABORTED",
  TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE: "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE",
  TASK_RUN_CANCELLED: "TASK_RUN_CANCELLED",
  TASK_OUTPUT_ERROR: "TASK_OUTPUT_ERROR",
  HANDLE_ERROR_ERROR: "HANDLE_ERROR_ERROR",
  GRACEFUL_EXIT_TIMEOUT: "GRACEFUL_EXIT_TIMEOUT",
} as const;

export const TaskRunInternalError = z.object({
  type: z.literal("INTERNAL_ERROR"),
  code: z.enum([
    "COULD_NOT_FIND_EXECUTOR",
    "COULD_NOT_FIND_TASK",
    "CONFIGURED_INCORRECTLY",
    "TASK_ALREADY_RUNNING",
    "TASK_EXECUTION_FAILED",
    "TASK_EXECUTION_ABORTED",
    "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE",
    "TASK_RUN_CANCELLED",
    "TASK_OUTPUT_ERROR",
    "HANDLE_ERROR_ERROR",
    "GRACEFUL_EXIT_TIMEOUT"
  ]),
  message: z.string().optional(),
});

export type TaskRunInternalError = z.infer<typeof TaskRunInternalError>;

export const TaskRunError = z.discriminatedUnion("type", [
  TaskRunBuiltInError,
  TaskRunCustomErrorObject,
  TaskRunStringError,
  TaskRunInternalError,
]);

export type TaskRunError = z.infer<typeof TaskRunError>;

export const TaskRun = z.object({
  id: z.string(),
  payload: z.string(),
  payloadType: z.string(),
  context: z.any(),
  tags: z.array(z.string()),
  isTest: z.boolean().default(false),
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

export const TaskRunExecutionQueue = z.object({
  id: z.string(),
  name: z.string(),
});

export type TaskRunExecutionQueue = z.infer<typeof TaskRunExecutionQueue>;

export const TaskRunExecutionBatch = z.object({
  id: z.string(),
});

export const TaskRunExecution = z.object({
  task: TaskRunExecutionTask,
  attempt: TaskRunExecutionAttempt,
  run: TaskRun,
  queue: TaskRunExecutionQueue,
  environment: TaskRunExecutionEnvironment,
  organization: TaskRunExecutionOrganization,
  project: TaskRunExecutionProject,
  batch: TaskRunExecutionBatch.optional(),
});

export type TaskRunExecution = z.infer<typeof TaskRunExecution>;

export const TaskRunContext = z.object({
  task: TaskRunExecutionTask,
  attempt: TaskRunExecutionAttempt.omit({
    backgroundWorkerId: true,
    backgroundWorkerTaskId: true,
  }),
  run: TaskRun.omit({ payload: true, payloadType: true }),
  queue: TaskRunExecutionQueue,
  environment: TaskRunExecutionEnvironment,
  organization: TaskRunExecutionOrganization,
  project: TaskRunExecutionProject,
  batch: TaskRunExecutionBatch.optional(),
});

export type TaskRunContext = z.infer<typeof TaskRunContext>;

export const TaskRunExecutionRetry = z.object({
  timestamp: z.number(),
  delay: z.number(),
  error: z.unknown().optional(),
});

export type TaskRunExecutionRetry = z.infer<typeof TaskRunExecutionRetry>;

export const TaskRunFailedExecutionResult = z.object({
  ok: z.literal(false),
  id: z.string(),
  error: TaskRunError,
  retry: TaskRunExecutionRetry.optional(),
  skippedRetrying: z.boolean().optional(),
});

export type TaskRunFailedExecutionResult = z.infer<typeof TaskRunFailedExecutionResult>;

export const TaskRunSuccessfulExecutionResult = z.object({
  ok: z.literal(true),
  id: z.string(),
  output: z.string().optional(),
  outputType: z.string(),
});

export type TaskRunSuccessfulExecutionResult = z.infer<typeof TaskRunSuccessfulExecutionResult>;

export const TaskRunExecutionResult = z.discriminatedUnion("ok", [
  TaskRunSuccessfulExecutionResult,
  TaskRunFailedExecutionResult,
]);

export type TaskRunExecutionResult = z.infer<typeof TaskRunExecutionResult>;

export const BatchTaskRunExecutionResult = z.object({
  id: z.string(),
  items: TaskRunExecutionResult.array(),
});

export type BatchTaskRunExecutionResult = z.infer<typeof BatchTaskRunExecutionResult>;
