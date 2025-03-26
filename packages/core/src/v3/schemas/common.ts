import { z } from "zod";
import { DeserializedJsonSchema } from "../../schemas/json.js";
import type { RuntimeEnvironmentType as DBRuntimeEnvironmentType } from "@trigger.dev/database";

export type Enum<T extends string> = { [K in T]: K };

export const RunMetadataUpdateOperation = z.object({
  type: z.literal("update"),
  value: z.record(z.unknown()),
});

export type RunMetadataUpdateOperation = z.infer<typeof RunMetadataUpdateOperation>;

export const RunMetadataSetKeyOperation = z.object({
  type: z.literal("set"),
  key: z.string(),
  value: DeserializedJsonSchema,
});

export type RunMetadataSetKeyOperation = z.infer<typeof RunMetadataSetKeyOperation>;

export const RunMetadataDeleteKeyOperation = z.object({
  type: z.literal("delete"),
  key: z.string(),
});

export type RunMetadataDeleteKeyOperation = z.infer<typeof RunMetadataDeleteKeyOperation>;

export const RunMetadataAppendKeyOperation = z.object({
  type: z.literal("append"),
  key: z.string(),
  value: DeserializedJsonSchema,
});

export type RunMetadataAppendKeyOperation = z.infer<typeof RunMetadataAppendKeyOperation>;

export const RunMetadataRemoveFromKeyOperation = z.object({
  type: z.literal("remove"),
  key: z.string(),
  value: DeserializedJsonSchema,
});

export type RunMetadataRemoveFromKeyOperation = z.infer<typeof RunMetadataRemoveFromKeyOperation>;

export const RunMetadataIncrementKeyOperation = z.object({
  type: z.literal("increment"),
  key: z.string(),
  value: z.number(),
});

export type RunMetadataIncrementKeyOperation = z.infer<typeof RunMetadataIncrementKeyOperation>;

export const RunMetadataChangeOperation = z.discriminatedUnion("type", [
  RunMetadataUpdateOperation,
  RunMetadataSetKeyOperation,
  RunMetadataDeleteKeyOperation,
  RunMetadataAppendKeyOperation,
  RunMetadataRemoveFromKeyOperation,
  RunMetadataIncrementKeyOperation,
]);

export type RunMetadataChangeOperation = z.infer<typeof RunMetadataChangeOperation>;

export const FlushedRunMetadata = z.object({
  metadata: z.record(DeserializedJsonSchema).optional(),
  operations: z.array(RunMetadataChangeOperation).optional(),
  parentOperations: z.array(RunMetadataChangeOperation).optional(),
  rootOperations: z.array(RunMetadataChangeOperation).optional(),
});

export type FlushedRunMetadata = z.infer<typeof FlushedRunMetadata>;

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
    "TASK_MIDDLEWARE_ERROR",
    "HANDLE_ERROR_ERROR",
    "GRACEFUL_EXIT_TIMEOUT",
    "TASK_RUN_HEARTBEAT_TIMEOUT",
    "TASK_RUN_CRASHED",
    "MAX_DURATION_EXCEEDED",
    "DISK_SPACE_EXCEEDED",
    "POD_EVICTED",
    "POD_UNKNOWN_ERROR",
    "TASK_HAS_N0_EXECUTION_SNAPSHOT",
    "TASK_DEQUEUED_INVALID_STATE",
    "TASK_DEQUEUED_QUEUE_NOT_FOUND",
    "TASK_RUN_DEQUEUED_MAX_RETRIES",
    "TASK_RUN_STALLED_EXECUTING",
    "TASK_RUN_STALLED_EXECUTING_WITH_WAITPOINTS",
    "OUTDATED_SDK_VERSION",
    "TASK_DID_CONCURRENT_WAIT",
    "RECURSIVE_WAIT_DEADLOCK",
  ]),
  message: z.string().optional(),
  stackTrace: z.string().optional(),
});

export type TaskRunInternalError = z.infer<typeof TaskRunInternalError>;

export const TaskRunErrorCodes = TaskRunInternalError.shape.code.enum;
export type TaskRunErrorCodes = TaskRunInternalError["code"];

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
  tags: z.array(z.string()),
  isTest: z.boolean().default(false),
  createdAt: z.coerce.date(),
  startedAt: z.coerce.date().default(() => new Date()),
  idempotencyKey: z.string().optional(),
  maxAttempts: z.number().optional(),
  version: z.string().optional(),
  metadata: z.record(DeserializedJsonSchema).optional(),
  maxDuration: z.number().optional(),
  /** @deprecated */
  context: z.any(),
  /**
   * @deprecated For live values use the `usage` SDK functions
   * @link https://trigger.dev/docs/run-usage
   */
  durationMs: z.number().default(0),
  /**
   * @deprecated For live values use the `usage` SDK functions
   * @link https://trigger.dev/docs/run-usage
   */
  costInCents: z.number().default(0),
  /**
   * @deprecated For live values use the `usage` SDK functions
   * @link https://trigger.dev/docs/run-usage
   */
  baseCostInCents: z.number().default(0),
  /** The priority of the run. Wih a value of 10 it will be dequeued before runs that were triggered 9 seconds before it (assuming they had no priority set).  */
  priority: z.number().optional(),
});

export type TaskRun = z.infer<typeof TaskRun>;

export const TaskRunExecutionTask = z.object({
  id: z.string(),
  filePath: z.string(),
  exportName: z.string().optional(),
});

export type TaskRunExecutionTask = z.infer<typeof TaskRunExecutionTask>;

export const TaskRunExecutionAttempt = z.object({
  number: z.number(),
  startedAt: z.coerce.date(),
  /** @deprecated */
  id: z.string(),
  /** @deprecated */
  backgroundWorkerId: z.string(),
  /** @deprecated */
  backgroundWorkerTaskId: z.string(),
  /** @deprecated */
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
  run: TaskRun.and(
    z.object({
      traceContext: z.record(z.unknown()).optional(),
    })
  ),
  queue: TaskRunExecutionQueue,
  environment: TaskRunExecutionEnvironment,
  organization: TaskRunExecutionOrganization,
  project: TaskRunExecutionProject,
  batch: TaskRunExecutionBatch.optional(),
  machine: MachinePreset,
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
  /** Retry delay in milliseconds */
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
  // Optional for now for backwards compatibility
  taskIdentifier: z.string().optional(),
  metadata: FlushedRunMetadata.optional(),
});

export type TaskRunFailedExecutionResult = z.infer<typeof TaskRunFailedExecutionResult>;

export const TaskRunSuccessfulExecutionResult = z.object({
  ok: z.literal(true),
  id: z.string(),
  output: z.string().optional(),
  outputType: z.string(),
  usage: TaskRunExecutionUsage.optional(),
  // Optional for now for backwards compatibility
  taskIdentifier: z.string().optional(),
  metadata: FlushedRunMetadata.optional(),
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

export const WaitpointTokenResult = z.object({
  ok: z.boolean(),
  output: z.string().optional(),
  outputType: z.string().optional(),
});
export type WaitpointTokenResult = z.infer<typeof WaitpointTokenResult>;

export type WaitpointTokenTypedResult<T> =
  | {
      ok: true;
      output: T;
    }
  | {
      ok: false;
      error: Error;
    };

export const SerializedError = z.object({
  message: z.string(),
  name: z.string().optional(),
  stackTrace: z.string().optional(),
});

export type SerializedError = z.infer<typeof SerializedError>;

export const RuntimeEnvironmentType = {
  PRODUCTION: "PRODUCTION",
  STAGING: "STAGING",
  DEVELOPMENT: "DEVELOPMENT",
  PREVIEW: "PREVIEW",
} satisfies Enum<DBRuntimeEnvironmentType>;

export type RuntimeEnvironmentType =
  (typeof RuntimeEnvironmentType)[keyof typeof RuntimeEnvironmentType];

export const RuntimeEnvironmentTypeSchema = z.enum(
  Object.values(RuntimeEnvironmentType) as [DBRuntimeEnvironmentType]
);
