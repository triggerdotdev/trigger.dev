import { z } from "zod";
import { TaskRunExecution, TaskRunExecutionResult } from "./common";

export const TaskRunExecutionPayload = z.object({
  execution: TaskRunExecution,
  traceContext: z.record(z.unknown()),
  environment: z.record(z.string()).optional(),
});

export type TaskRunExecutionPayload = z.infer<typeof TaskRunExecutionPayload>;

export const ProdTaskRunExecution = TaskRunExecution.extend({
  worker: z.object({
    id: z.string(),
    contentHash: z.string(),
    version: z.string(),
  }),
});

export type ProdTaskRunExecution = z.infer<typeof ProdTaskRunExecution>;

export const ProdTaskRunExecutionPayload = z.object({
  execution: ProdTaskRunExecution,
  traceContext: z.record(z.unknown()),
  environment: z.record(z.string()).optional(),
});

export type ProdTaskRunExecutionPayload = z.infer<typeof ProdTaskRunExecutionPayload>;

export const BackgroundWorkerServerMessages = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("EXECUTE_RUNS"),
    payloads: z.array(TaskRunExecutionPayload),
  }),
  z.object({
    type: z.literal("SCHEDULE_ATTEMPT"),
    id: z.string(),
    image: z.string(),
    envId: z.string(),
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
    execution: TaskRunExecution,
  }),
  z.object({
    version: z.literal("v1").default("v1"),
    type: z.literal("TASK_HEARTBEAT"),
    id: z.string(),
  }),
]);

export type BackgroundWorkerClientMessages = z.infer<typeof BackgroundWorkerClientMessages>;

export const BackgroundWorkerProperties = z.object({
  id: z.string(),
  version: z.string(),
  contentHash: z.string(),
});

export type BackgroundWorkerProperties = z.infer<typeof BackgroundWorkerProperties>;

export const clientWebsocketMessages = {
  READY_FOR_TASKS: z.object({
    version: z.literal("v1").default("v1"),
    backgroundWorkerId: z.string(),
  }),
  BACKGROUND_WORKER_DEPRECATED: z.object({
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
    traceContext: z.record(z.unknown()),
    metadata: BackgroundWorkerProperties,
  }),
  TASK_RUN_COMPLETED_NOTIFICATION: z.object({
    version: z.literal("v1").default("v1"),
    completion: TaskRunExecutionResult,
    execution: TaskRunExecution,
  }),
  CLEANUP: z.object({
    version: z.literal("v1").default("v1"),
    flush: z.boolean().default(false),
    kill: z.boolean().default(true),
  }),
};

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

export const RetryOptions = z.object({
  maxAttempts: z.number().int().optional(),
  factor: z.number().optional(),
  minTimeoutInMs: z.number().int().optional(),
  maxTimeoutInMs: z.number().int().optional(),
  randomize: z.boolean().optional(),
});

export type RetryOptions = z.infer<typeof RetryOptions>;

export type RateLimitOptions = z.infer<typeof RateLimitOptions>;

export const QueueOptions = z.object({
  /** @deprecated This feature is coming soon */
  rateLimit: RateLimitOptions.optional(),
  concurrencyLimit: z.number().int().min(1).max(1000).optional(),
  name: z.string().optional(),
});

export type QueueOptions = z.infer<typeof QueueOptions>;

export const TaskMetadata = z.object({
  id: z.string(),
  exportName: z.string(),
  packageVersion: z.string(),
  queue: QueueOptions.optional(),
  retry: RetryOptions.required().optional(),
});

export type TaskMetadata = z.infer<typeof TaskMetadata>;

export const TaskMetadataWithFilePath = TaskMetadata.extend({
  filePath: z.string(),
});

export type TaskMetadataWithFilePath = z.infer<typeof TaskMetadataWithFilePath>;

export const childToWorkerMessages = {
  TASK_RUN_COMPLETED: z.object({
    version: z.literal("v1").default("v1"),
    execution: TaskRunExecution,
    result: TaskRunExecutionResult,
  }),
  TASKS_READY: z.object({
    version: z.literal("v1").default("v1"),
    tasks: TaskMetadataWithFilePath.array(),
  }),
  TASK_HEARTBEAT: z.object({
    version: z.literal("v1").default("v1"),
    id: z.string(),
  }),
  READY_TO_DISPOSE: z.undefined(),
  WAIT_FOR_DURATION: z.object({
    version: z.literal("v1").default("v1"),
    ms: z.number(),
  }),
  WAIT_FOR_TASK: z.object({
    version: z.literal("v1").default("v1"),
    id: z.string(),
  }),
  WAIT_FOR_BATCH: z.object({
    version: z.literal("v1").default("v1"),
    id: z.string(),
    runs: z.string().array(),
  }),
  UNCAUGHT_EXCEPTION: z.object({
    version: z.literal("v1").default("v1"),
    error: z.object({
      name: z.string(),
      message: z.string(),
      stack: z.string().optional(),
    }),
    origin: z.enum(["uncaughtException", "unhandledRejection"]),
  }),
};

export const ProdChildToWorkerMessages = {
  TASK_RUN_COMPLETED: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      execution: TaskRunExecution,
      result: TaskRunExecutionResult,
    }),
  },
  TASKS_READY: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      tasks: TaskMetadataWithFilePath.array(),
    }),
  },
  TASK_HEARTBEAT: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      id: z.string(),
    }),
  },
  READY_TO_DISPOSE: {
    message: z.undefined(),
  },
  WAIT_FOR_DURATION: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      ms: z.number(),
    }),
    callback: z.object({
      willCheckpointAndRestore: z.boolean(),
    }),
  },
  WAIT_FOR_TASK: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      id: z.string(),
    }),
  },
  WAIT_FOR_BATCH: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      id: z.string(),
      runs: z.string().array(),
    }),
  },
};

export const ProdWorkerToChildMessages = {
  EXECUTE_TASK_RUN: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      execution: TaskRunExecution,
      traceContext: z.record(z.unknown()),
      metadata: BackgroundWorkerProperties,
    }),
  },
  TASK_RUN_COMPLETED_NOTIFICATION: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      completion: TaskRunExecutionResult,
      execution: TaskRunExecution,
    }),
  },
  CLEANUP: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      flush: z.boolean().default(false),
      kill: z.boolean().default(true),
    }),
  },
  WAIT_COMPLETED_NOTIFICATION: {
    message: z.object({
      version: z.literal("v1").default("v1"),
    }),
  },
};
