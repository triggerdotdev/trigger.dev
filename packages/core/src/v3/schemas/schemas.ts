import { z } from "zod";
import { RequireKeys } from "../types/index.js";
import { MachineConfig, MachinePreset, MachinePresetName, TaskRunExecution } from "./common.js";

/*
    WARNING: Never import anything from ./messages here. If it's needed in both, put it here instead.
*/
export const EnvironmentType = z.enum(["PRODUCTION", "STAGING", "DEVELOPMENT", "PREVIEW"]);
export type EnvironmentType = z.infer<typeof EnvironmentType>;

export const RunEngineVersionSchema = z.enum(["V1", "V2"]);

export const TaskRunExecutionMetric = z.object({
  name: z.string(),
  event: z.string(),
  timestamp: z.number(),
  duration: z.number(),
});

export type TaskRunExecutionMetric = z.infer<typeof TaskRunExecutionMetric>;

export const TaskRunExecutionMetrics = z.array(TaskRunExecutionMetric);

export type TaskRunExecutionMetrics = z.infer<typeof TaskRunExecutionMetrics>;

export const TaskRunExecutionPayload = z.object({
  execution: TaskRunExecution,
  traceContext: z.record(z.unknown()),
  environment: z.record(z.string()).optional(),
  metrics: TaskRunExecutionMetrics.optional(),
});

export type TaskRunExecutionPayload = z.infer<typeof TaskRunExecutionPayload>;

// **IMPORTANT NOTE**: If you change this schema, make sure it is backwards compatible with the previous version as this also used when a worker signals to the coordinator that a TaskRun is complete.
// Strategies for not breaking backwards compatibility:
// 1. Add new fields as optional
// 2. If a field is required, add a default value
export const ProdTaskRunExecution = TaskRunExecution.extend({
  worker: z.object({
    id: z.string(),
    contentHash: z.string(),
    version: z.string(),
    type: RunEngineVersionSchema.optional(),
  }),
  machine: MachinePreset.default({ name: "small-1x", cpu: 1, memory: 1, centsPerMs: 0 }),
});

export type ProdTaskRunExecution = z.infer<typeof ProdTaskRunExecution>;

export const ProdTaskRunExecutionPayload = z.object({
  execution: ProdTaskRunExecution,
  traceContext: z.record(z.unknown()),
  environment: z.record(z.string()).optional(),
  metrics: TaskRunExecutionMetrics.optional(),
});

export type ProdTaskRunExecutionPayload = z.infer<typeof ProdTaskRunExecutionPayload>;

export const FixedWindowRateLimit = z.object({
  type: z.literal("fixed-window"),
  limit: z.number(),
  window: z.union([
    z.object({
      seconds: z.number(),
    }),
    z.object({
      minutes: z.number(),
    }),
    z.object({
      hours: z.number(),
    }),
  ]),
});

export const SlidingWindowRateLimit = z.object({
  type: z.literal("sliding-window"),
  limit: z.number(),
  window: z.union([
    z.object({
      seconds: z.number(),
    }),
    z.object({
      minutes: z.number(),
    }),
    z.object({
      hours: z.number(),
    }),
  ]),
});

export const RateLimitOptions = z.discriminatedUnion("type", [
  FixedWindowRateLimit,
  SlidingWindowRateLimit,
]);

export type RateLimitOptions = z.infer<typeof RateLimitOptions>;

export const RetryOptions = z.object({
  /** The number of attempts before giving up */
  maxAttempts: z.number().int().optional(),
  /** The exponential factor to use when calculating the next retry time.
   *
   * Each subsequent retry will be calculated as `previousTimeout * factor`
   */
  factor: z.number().optional(),
  /** The minimum time to wait before retrying */
  minTimeoutInMs: z.number().int().optional(),
  /** The maximum time to wait before retrying */
  maxTimeoutInMs: z.number().int().optional(),
  /** Randomize the timeout between retries.
   *
   * This can be useful to prevent the thundering herd problem where all retries happen at the same time.
   */
  randomize: z.boolean().optional(),

  /** If a run fails with an Out Of Memory (OOM) error and you have this set, it will retry with the machine you specify.
   * Note: it will not default to this [machine](https://trigger.dev/docs/machines) for new runs, only for failures caused by OOM errors.
   * So if you frequently have attempts failing with OOM errors, you should set the [default machine](https://trigger.dev/docs/machines) to be higher.
   */
  outOfMemory: z
    .object({
      machine: MachinePresetName.optional(),
    })
    .optional(),
});

export type RetryOptions = z.infer<typeof RetryOptions>;

export const QueueManifest = z.object({
  /** You can define a shared queue and then pass the name in to your task.
   *
   * @example
   *
   * ```ts
   * const myQueue = queue({
      name: "my-queue",
      concurrencyLimit: 1,
    });

    export const task1 = task({
      id: "task-1",
      queue: {
        name: "my-queue",
      },
      run: async (payload: { message: string }) => {
        // ...
      },
    });

    export const task2 = task({
      id: "task-2",
      queue: {
        name: "my-queue",
      },
      run: async (payload: { message: string }) => {
        // ...
      },
    });
   * ```
   */
  name: z.string(),
  /** An optional property that specifies the maximum number of concurrent run executions.
   *
   * If this property is omitted, the task can potentially use up the full concurrency of an environment */
  concurrencyLimit: z.number().int().min(0).max(100000).optional().nullable(),
  /** An optional property that specifies whether to release concurrency on waitpoint.
   *
   * If this property is omitted, the task will not release concurrency on waitpoint.
   */
  releaseConcurrencyOnWaitpoint: z.boolean().optional(),
});

export type QueueManifest = z.infer<typeof QueueManifest>;

export const ScheduleMetadata = z.object({
  cron: z.string(),
  timezone: z.string(),
  environments: z.array(EnvironmentType).optional(),
});

const taskMetadata = {
  id: z.string(),
  description: z.string().optional(),
  queue: QueueManifest.extend({ name: z.string().optional() }).optional(),
  retry: RetryOptions.optional(),
  machine: MachineConfig.optional(),
  triggerSource: z.string().optional(),
  schedule: ScheduleMetadata.optional(),
  maxDuration: z.number().optional(),
};

export const TaskMetadata = z.object(taskMetadata);

export type TaskMetadata = z.infer<typeof TaskMetadata>;

export const TaskFile = z.object({
  entry: z.string(),
  out: z.string(),
});

export type TaskFile = z.infer<typeof TaskFile>;

const taskFileMetadata = {
  filePath: z.string(),
  exportName: z.string().optional(),
  entryPoint: z.string(),
};

export const TaskFileMetadata = z.object(taskFileMetadata);

export type TaskFileMetadata = z.infer<typeof TaskFileMetadata>;

export const TaskManifest = z.object({
  ...taskMetadata,
  ...taskFileMetadata,
});

export type TaskManifest = z.infer<typeof TaskManifest>;

export const PostStartCauses = z.enum(["index", "create", "restore"]);
export type PostStartCauses = z.infer<typeof PostStartCauses>;

export const PreStopCauses = z.enum(["terminate"]);
export type PreStopCauses = z.infer<typeof PreStopCauses>;

const RegexSchema = z.custom<RegExp>((val) => {
  try {
    // Check to see if val is a regex
    return typeof (val as RegExp).test === "function";
  } catch {
    return false;
  }
});

export const Config = z.object({
  project: z.string(),
  triggerDirectories: z.string().array().optional(),
  triggerUrl: z.string().optional(),
  projectDir: z.string().optional(),
  tsconfigPath: z.string().optional(),
  retries: z
    .object({
      enabledInDev: z.boolean().default(true),
      default: RetryOptions.optional(),
    })
    .optional(),
  additionalPackages: z.string().array().optional(),
  additionalFiles: z.string().array().optional(),
  dependenciesToBundle: z.array(z.union([z.string(), RegexSchema])).optional(),
  logLevel: z.string().optional(),
  enableConsoleLogging: z.boolean().optional(),
  postInstall: z.string().optional(),
  extraCACerts: z.string().optional(),
});

export type Config = z.infer<typeof Config>;
export type ResolvedConfig = RequireKeys<
  Config,
  "triggerDirectories" | "triggerUrl" | "projectDir" | "tsconfigPath"
>;

export const WaitReason = z.enum(["WAIT_FOR_DURATION", "WAIT_FOR_TASK", "WAIT_FOR_BATCH"]);

export type WaitReason = z.infer<typeof WaitReason>;

export const TaskRunExecutionLazyAttemptPayload = z.object({
  runId: z.string(),
  attemptCount: z.number().optional(),
  messageId: z.string(),
  isTest: z.boolean(),
  traceContext: z.record(z.unknown()),
  environment: z.record(z.string()).optional(),
  metrics: TaskRunExecutionMetrics.optional(),
});

export type TaskRunExecutionLazyAttemptPayload = z.infer<typeof TaskRunExecutionLazyAttemptPayload>;

export const ManualCheckpointMetadata = z.object({
  /** NOT a friendly ID */
  attemptId: z.string(),
  previousRunStatus: z.string(),
  previousAttemptStatus: z.string(),
});

export type ManualCheckpointMetadata = z.infer<typeof ManualCheckpointMetadata>;

export const RunChainState = z.object({
  concurrency: z
    .object({
      queues: z.array(z.object({ id: z.string(), name: z.string(), holding: z.number() })),
      environment: z.number().optional(),
    })
    .optional(),
});

export type RunChainState = z.infer<typeof RunChainState>;
