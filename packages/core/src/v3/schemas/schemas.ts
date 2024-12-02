import { z } from "zod";
import { RequireKeys } from "../types/index.js";
import { MachineConfig, MachinePreset, TaskRunExecution } from "./common.js";

/*
    WARNING: Never import anything from ./messages here. If it's needed in both, put it here instead.
*/
export const EnvironmentType = z.enum(["PRODUCTION", "STAGING", "DEVELOPMENT", "PREVIEW"]);
export type EnvironmentType = z.infer<typeof EnvironmentType>;

export const TaskRunExecutionPayload = z.object({
  execution: TaskRunExecution,
  traceContext: z.record(z.unknown()),
  environment: z.record(z.string()).optional(),
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
  }),
  machine: MachinePreset.default({ name: "small-1x", cpu: 1, memory: 1, centsPerMs: 0 }),
});

export type ProdTaskRunExecution = z.infer<typeof ProdTaskRunExecution>;

export const ProdTaskRunExecutionPayload = z.object({
  execution: ProdTaskRunExecution,
  traceContext: z.record(z.unknown()),
  environment: z.record(z.string()).optional(),
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
});

export type RetryOptions = z.infer<typeof RetryOptions>;

export const QueueOptions = z.object({
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
  name: z.string().optional(),
  /** An optional property that specifies the maximum number of concurrent run executions.
   *
   * If this property is omitted, the task can potentially use up the full concurrency of an environment. */
  concurrencyLimit: z.number().int().min(0).max(1000).optional(),
});

export type QueueOptions = z.infer<typeof QueueOptions>;

export const ScheduleMetadata = z.object({
  cron: z.string(),
  timezone: z.string(),
});

const taskMetadata = {
  id: z.string(),
  description: z.string().optional(),
  queue: QueueOptions.optional(),
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
  exportName: z.string(),
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
});

export type TaskRunExecutionLazyAttemptPayload = z.infer<typeof TaskRunExecutionLazyAttemptPayload>;
