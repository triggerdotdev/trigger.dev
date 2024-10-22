import { z } from "zod";
import { DeserializedJsonSchema } from "../../schemas/json.js";

// Defaults to 0.5
export const MachineCpu = z.union([
  z.literal(0.25),
  z.literal(0.5),
  z.literal(1),
  z.literal(2),
  z.literal(4),
]);

export type MachineCpu = z.infer<typeof MachineCpu>;

// Defaults to 1
export const MachineMemory = z.union([
  z.literal(0.25),
  z.literal(0.5),
  z.literal(1),
  z.literal(2),
  z.literal(4),
  z.literal(8),
]);

export type MachineMemory = z.infer<typeof MachineMemory>;

// Default is small-1x
export const MachinePresetName = z.enum([
  "micro",
  "small-1x",
  "small-2x",
  "medium-1x",
  "medium-2x",
  "large-1x",
  "large-2x",
]);

export type MachinePresetName = z.infer<typeof MachinePresetName>;

export const MachineConfig = z.object({
  cpu: MachineCpu.optional(),
  memory: MachineMemory.optional(),
  preset: MachinePresetName.optional(),
});

export type MachineConfig = z.infer<typeof MachineConfig>;

export const MachinePreset = z.object({
  name: MachinePresetName,
  cpu: z.number(),
  memory: z.number(),
  centsPerMs: z.number(),
});

export type MachinePreset = z.infer<typeof MachinePreset>;

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

export const TaskRunInternalError = z.object({
  type: z.literal("INTERNAL_ERROR"),
  code: z.enum([
    "COULD_NOT_FIND_EXECUTOR",
    "COULD_NOT_FIND_TASK",
    "COULD_NOT_IMPORT_TASK",
    "CONFIGURED_INCORRECTLY",
    "TASK_ALREADY_RUNNING",
    "TASK_EXECUTION_FAILED",
    "TASK_EXECUTION_ABORTED",
    "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE",
    "TASK_PROCESS_SIGKILL_TIMEOUT",
    "TASK_PROCESS_SIGSEGV",
    "TASK_PROCESS_SIGTERM",
    "TASK_PROCESS_OOM_KILLED",
    "TASK_PROCESS_MAYBE_OOM_KILLED",
    "TASK_RUN_CANCELLED",
    "TASK_INPUT_ERROR",
    "TASK_OUTPUT_ERROR",
    "HANDLE_ERROR_ERROR",
    "GRACEFUL_EXIT_TIMEOUT",
    "TASK_RUN_HEARTBEAT_TIMEOUT",
    "TASK_RUN_CRASHED",
    "MAX_DURATION_EXCEEDED",
    "DISK_SPACE_EXCEEDED",
    "POD_EVICTED",
    "POD_UNKNOWN_ERROR",
  ]),
  message: z.string().optional(),
  stackTrace: z.string().optional(),
});

export type TaskRunInternalError = z.infer<typeof TaskRunInternalError>;

export const TaskRunErrorCodes = TaskRunInternalError.shape.code.enum;

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
  startedAt: z.coerce.date().default(() => new Date()),
  idempotencyKey: z.string().optional(),
  maxAttempts: z.number().optional(),
  durationMs: z.number().default(0),
  costInCents: z.number().default(0),
  baseCostInCents: z.number().default(0),
  version: z.string().optional(),
  metadata: z.record(DeserializedJsonSchema).optional(),
  maxDuration: z.number().optional(),
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
  machine: MachinePreset.optional(),
});

export type TaskRunExecution = z.infer<typeof TaskRunExecution>;

export const TaskRunContext = z.object({
  task: TaskRunExecutionTask,
  attempt: TaskRunExecutionAttempt.omit({
    backgroundWorkerId: true,
    backgroundWorkerTaskId: true,
  }),
  run: TaskRun.omit({ payload: true, payloadType: true, metadata: true }),
  queue: TaskRunExecutionQueue,
  environment: TaskRunExecutionEnvironment,
  organization: TaskRunExecutionOrganization,
  project: TaskRunExecutionProject,
  batch: TaskRunExecutionBatch.optional(),
  machine: MachinePreset.optional(),
});

export type TaskRunContext = z.infer<typeof TaskRunContext>;

export const TaskRunExecutionRetry = z.object({
  timestamp: z.number(),
  delay: z.number(),
  error: z.unknown().optional(),
});

export type TaskRunExecutionRetry = z.infer<typeof TaskRunExecutionRetry>;

export const TaskRunExecutionUsage = z.object({
  durationMs: z.number(),
});

export type TaskRunExecutionUsage = z.infer<typeof TaskRunExecutionUsage>;

export const TaskRunFailedExecutionResult = z.object({
  ok: z.literal(false),
  id: z.string(),
  error: TaskRunError,
  retry: TaskRunExecutionRetry.optional(),
  skippedRetrying: z.boolean().optional(),
  usage: TaskRunExecutionUsage.optional(),
});

export type TaskRunFailedExecutionResult = z.infer<typeof TaskRunFailedExecutionResult>;

export const TaskRunSuccessfulExecutionResult = z.object({
  ok: z.literal(true),
  id: z.string(),
  output: z.string().optional(),
  outputType: z.string(),
  usage: TaskRunExecutionUsage.optional(),
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

export const SerializedError = z.object({
  message: z.string(),
  name: z.string().optional(),
  stackTrace: z.string().optional(),
});

export type SerializedError = z.infer<typeof SerializedError>;
