import { z } from "zod";
import { ImportTaskFileErrors, WorkerManifest } from "./build.js";
import { TaskRunExecution, TaskRunExecutionResult } from "./common.js";
import { RunEngineVersionSchema, TaskRunExecutionMetrics } from "./schemas.js";
import { CompletedWaitpoint } from "./runEngine.js";
import { DebugLogPropertiesInput } from "../runEngineWorker/supervisor/schemas.js";

export const ServerBackgroundWorker = z.object({
  id: z.string(),
  version: z.string(),
  contentHash: z.string(),
  engine: RunEngineVersionSchema.optional(),
});

export type ServerBackgroundWorker = z.infer<typeof ServerBackgroundWorker>;

export const UncaughtExceptionMessage = z.object({
  version: z.literal("v1").default("v1"),
  error: z.object({
    name: z.string(),
    message: z.string(),
    stack: z.string().optional(),
  }),
  origin: z.enum(["uncaughtException", "unhandledRejection"]),
});

export const TaskMetadataFailedToParseData = z.object({
  version: z.literal("v1").default("v1"),
  tasks: z.unknown(),
  zodIssues: z.custom<z.ZodIssue[]>((v) => {
    return Array.isArray(v) && v.every((issue) => typeof issue === "object" && "message" in issue);
  }),
});

export const indexerToWorkerMessages = {
  INDEX_COMPLETE: z.object({
    version: z.literal("v1").default("v1"),
    manifest: WorkerManifest,
    importErrors: ImportTaskFileErrors,
  }),
  TASKS_FAILED_TO_PARSE: TaskMetadataFailedToParseData,
  TASKS_FAILED_TO_INDEX: z.object({
    version: z.literal("v1").default("v1"),
    collisions: z.array(z.object({ id: z.string(), filePaths: z.array(z.string()) })),
  }),
  UNCAUGHT_EXCEPTION: UncaughtExceptionMessage,
};

export const ExecutorToWorkerMessageCatalog = {
  TASK_RUN_COMPLETED: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      execution: TaskRunExecution,
      result: TaskRunExecutionResult,
    }),
  },
  TASK_HEARTBEAT: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      id: z.string(),
    }),
  },
  UNCAUGHT_EXCEPTION: {
    message: UncaughtExceptionMessage,
  },
  SEND_DEBUG_LOG: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      message: z.string(),
      properties: DebugLogPropertiesInput.optional(),
    }),
  },
  SET_SUSPENDABLE: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      suspendable: z.boolean(),
    }),
  },
  MAX_DURATION_EXCEEDED: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      maxDurationInSeconds: z.number(),
      elapsedTimeInSeconds: z.number(),
    }),
  },
};

export const WorkerToExecutorMessageCatalog = {
  EXECUTE_TASK_RUN: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      execution: TaskRunExecution,
      traceContext: z.record(z.unknown()),
      metadata: ServerBackgroundWorker,
      metrics: TaskRunExecutionMetrics.optional(),
      env: z.record(z.string()).optional(),
      isWarmStart: z.boolean().optional(),
    }),
  },
  FLUSH: {
    message: z.object({
      timeoutInMs: z.number(),
      disableContext: z.boolean().optional(),
    }),
    callback: z.void(),
  },
  CANCEL: {
    message: z.object({
      timeoutInMs: z.number(),
    }),
    callback: z.void(),
  },
  RESOLVE_WAITPOINT: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      waitpoint: CompletedWaitpoint,
    }),
  },
};
