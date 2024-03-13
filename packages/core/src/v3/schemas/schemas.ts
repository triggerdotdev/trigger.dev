import { z } from "zod";
import { RequireKeys } from "../types";
import { TaskRunExecution, TaskRunExecutionResult } from "./common";
import {
  BackgroundWorkerClientMessages,
  BackgroundWorkerServerMessages,
  ProdTaskRunExecution,
  ProdTaskRunExecutionPayload,
  RetryOptions,
} from "./messages";
import { TaskResource } from "./resources";

export const Config = z.object({
  project: z.string(),
  triggerDirectories: z.string().array().optional(),
  triggerUrl: z.string().optional(),
  projectDir: z.string().optional(),
  retries: z
    .object({
      enabledInDev: z.boolean().default(true),
      default: RetryOptions.optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof Config>;
export type ResolvedConfig = RequireKeys<
  Config,
  "triggerDirectories" | "triggerUrl" | "projectDir"
>;

export const Machine = z.object({
  cpu: z.string().default("1").optional(),
  memory: z.string().default("500Mi").optional(),
});

export type Machine = z.infer<typeof Machine>;

export const ProviderToPlatformMessages = {
  LOG: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      data: z.string(),
    }),
  },
  LOG_WITH_ACK: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      data: z.string(),
    }),
    callback: z.object({
      status: z.literal("ok"),
    }),
  },
};

export const PlatformToProviderMessages = {
  HEALTH: {
    message: z.object({
      version: z.literal("v1").default("v1"),
    }),
    callback: z.object({
      status: z.literal("ok"),
    }),
  },
  INDEX: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      imageTag: z.string(),
      contentHash: z.string(),
      envId: z.string(),
      apiKey: z.string(),
      apiUrl: z.string(),
    }),
  },
  INVOKE: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      name: z.string(),
      machine: Machine,
    }),
  },
  RESTORE: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      id: z.string(),
      attemptId: z.string(),
      type: z.enum(["DOCKER", "KUBERNETES"]),
      location: z.string(),
      reason: z.string().optional(),
    }),
  },
  DELETE: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      name: z.string(),
    }),
    callback: z.object({
      message: z.string(),
    }),
  },
  GET: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      name: z.string(),
    }),
  },
};

export const CoordinatorToPlatformMessages = {
  LOG: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      metadata: z.any(),
      text: z.string(),
    }),
  },
  CREATE_WORKER: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      projectRef: z.string(),
      envId: z.string(),
      deploymentId: z.string(),
      metadata: z.object({
        cliPackageVersion: z.string().optional(),
        contentHash: z.string(),
        packageVersion: z.string(),
        tasks: TaskResource.array(),
      }),
    }),
    callback: z.discriminatedUnion("success", [
      z.object({
        success: z.literal(false),
      }),
      z.object({
        success: z.literal(true),
      }),
    ]),
  },
  READY_FOR_EXECUTION: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptId: z.string(),
    }),
    callback: z.discriminatedUnion("success", [
      z.object({
        success: z.literal(false),
      }),
      z.object({
        success: z.literal(true),
        payload: ProdTaskRunExecutionPayload,
      }),
    ]),
  },
  READY_FOR_RESUME: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptId: z.string(),
      type: z.enum(["WAIT_FOR_DURATION", "WAIT_FOR_TASK", "WAIT_FOR_BATCH"]),
    }),
  },
  TASK_RUN_COMPLETED: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      execution: ProdTaskRunExecution,
      completion: TaskRunExecutionResult,
    }),
  },
  TASK_HEARTBEAT: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptFriendlyId: z.string(),
    }),
  },
  CHECKPOINT_CREATED: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptId: z.string(),
      docker: z.boolean(),
      location: z.string(),
      reason: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("WAIT_FOR_DURATION"),
          ms: z.number(),
        }),
        z.object({
          type: z.literal("WAIT_FOR_BATCH"),
          id: z.string(),
        }),
        z.object({
          type: z.literal("WAIT_FOR_TASK"),
          id: z.string(),
        }),
      ]),
    }),
  },
  INDEXING_FAILED: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      deploymentId: z.string(),
      error: z.object({
        name: z.string(),
        message: z.string(),
        stack: z.string().optional(),
      }),
    }),
  },
};

export const PlatformToCoordinatorMessages = {
  RESUME: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptId: z.string(),
      completions: TaskRunExecutionResult.array(),
      executions: TaskRunExecution.array(),
    }),
  },
  RESUME_AFTER_DURATION: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptId: z.string(),
    }),
  },
};

export const ClientToSharedQueueMessages = {
  READY_FOR_TASKS: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      backgroundWorkerId: z.string(),
    }),
  },
  BACKGROUND_WORKER_DEPRECATED: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      backgroundWorkerId: z.string(),
    }),
  },
  BACKGROUND_WORKER_MESSAGE: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      backgroundWorkerId: z.string(),
      data: BackgroundWorkerClientMessages,
    }),
  },
};

export const SharedQueueToClientMessages = {
  SERVER_READY: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      id: z.string(),
    }),
  },
  BACKGROUND_WORKER_MESSAGE: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      backgroundWorkerId: z.string(),
      data: BackgroundWorkerServerMessages,
    }),
  },
};

export const ProdWorkerToCoordinatorMessages = {
  LOG: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      text: z.string(),
    }),
    callback: z.void(),
  },
  INDEX_TASKS: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      deploymentId: z.string(),
      tasks: TaskResource.array(),
      packageVersion: z.string(),
    }),
    callback: z.discriminatedUnion("success", [
      z.object({
        success: z.literal(false),
      }),
      z.object({
        success: z.literal(true),
      }),
    ]),
  },
  READY_FOR_EXECUTION: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptId: z.string(),
    }),
  },
  READY_FOR_RESUME: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptId: z.string(),
      type: z.enum(["WAIT_FOR_DURATION", "WAIT_FOR_TASK", "WAIT_FOR_BATCH"]),
    }),
  },
  TASK_HEARTBEAT: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptFriendlyId: z.string(),
    }),
  },
  TASK_RUN_COMPLETED: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      execution: ProdTaskRunExecution,
      completion: TaskRunExecutionResult,
    }),
    callback: z.void(),
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
    callback: z.object({
      willCheckpointAndRestore: z.boolean(),
    }),
  },
  WAIT_FOR_BATCH: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      id: z.string(),
      runs: z.string().array(),
    }),
    callback: z.object({
      willCheckpointAndRestore: z.boolean(),
    }),
  },
  INDEXING_FAILED: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      deploymentId: z.string(),
      error: z.object({
        name: z.string(),
        message: z.string(),
        stack: z.string().optional(),
      }),
    }),
  },
};

export const CoordinatorToProdWorkerMessages = {
  RESUME: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptId: z.string(),
      completions: TaskRunExecutionResult.array(),
      executions: TaskRunExecution.array(),
    }),
  },
  RESUME_AFTER_DURATION: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptId: z.string(),
    }),
  },
  EXECUTE_TASK_RUN: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      executionPayload: ProdTaskRunExecutionPayload,
    }),
  },
};

export const ProdWorkerSocketData = z.object({
  contentHash: z.string(),
  projectRef: z.string(),
  envId: z.string(),
  attemptId: z.string(),
  podName: z.string(),
  deploymentId: z.string(),
});
