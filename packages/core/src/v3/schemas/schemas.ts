import { z } from "zod";
import { RequireKeys } from "../types";
import { TaskRunExecution, TaskRunExecutionResult } from "./common";
import {
  BackgroundWorkerClientMessages,
  BackgroundWorkerServerMessages,
  ProdTaskRunExecution,
  ProdTaskRunExecutionPayload,
  RetryOptions,
  Machine,
  EnvironmentType,
} from "./messages";
import { TaskResource } from "./resources";

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
});

export type Config = z.infer<typeof Config>;
export type ResolvedConfig = RequireKeys<
  Config,
  "triggerDirectories" | "triggerUrl" | "projectDir" | "tsconfigPath"
>;

export const WaitReason = z.enum(["WAIT_FOR_DURATION", "WAIT_FOR_TASK", "WAIT_FOR_BATCH"]);

export type WaitReason = z.infer<typeof WaitReason>;

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
      shortCode: z.string(),
      apiKey: z.string(),
      apiUrl: z.string(),
      // identifiers
      envId: z.string(),
      envType: EnvironmentType,
      orgId: z.string(),
      projectId: z.string(),
    }),
    callback: z.discriminatedUnion("success", [
      z.object({
        success: z.literal(false),
        error: z.object({
          name: z.string(),
          message: z.string(),
          stack: z.string().optional(),
        }),
      }),
      z.object({
        success: z.literal(true),
      }),
    ]),
  },
  // TODO: this should be a shared queue message instead
  RESTORE: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      type: z.enum(["DOCKER", "KUBERNETES"]),
      location: z.string(),
      reason: z.string().optional(),
      imageRef: z.string(),
      machine: Machine,
      // identifiers
      checkpointId: z.string(),
      envId: z.string(),
      envType: EnvironmentType,
      orgId: z.string(),
      projectId: z.string(),
      runId: z.string(),
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
      runId: z.string(),
      totalCompletions: z.number(),
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
      attemptFriendlyId: z.string(),
      type: WaitReason,
    }),
  },
  TASK_RUN_COMPLETED: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      execution: ProdTaskRunExecution,
      completion: TaskRunExecutionResult,
      checkpoint: z
        .object({
          docker: z.boolean(),
          location: z.string(),
        })
        .optional(),
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
      attemptFriendlyId: z.string(),
      docker: z.boolean(),
      location: z.string(),
      reason: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("WAIT_FOR_DURATION"),
          ms: z.number(),
          now: z.number(),
        }),
        z.object({
          type: z.literal("WAIT_FOR_BATCH"),
          batchFriendlyId: z.string(),
          runFriendlyIds: z.string().array(),
        }),
        z.object({
          type: z.literal("WAIT_FOR_TASK"),
          friendlyId: z.string(),
        }),
        z.object({
          type: z.literal("RETRYING_AFTER_FAILURE"),
          attemptNumber: z.number(),
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
  RESUME_AFTER_DEPENDENCY: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      runId: z.string(),
      attemptId: z.string(),
      attemptFriendlyId: z.string(),
      completions: TaskRunExecutionResult.array(),
      executions: TaskRunExecution.array(),
    }),
  },
  RESUME_AFTER_DURATION: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptId: z.string(),
      attemptFriendlyId: z.string(),
    }),
  },
  REQUEST_ATTEMPT_CANCELLATION: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptId: z.string(),
      attemptFriendlyId: z.string(),
    }),
  },
  READY_FOR_RETRY: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      runId: z.string(),
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
      runId: z.string(),
      totalCompletions: z.number(),
    }),
  },
  READY_FOR_RESUME: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptFriendlyId: z.string(),
      type: WaitReason,
    }),
  },
  READY_FOR_CHECKPOINT: {
    message: z.object({
      version: z.literal("v1").default("v1"),
    }),
  },
  CANCEL_CHECKPOINT: {
    message: z.object({
      version: z.literal("v1").default("v1"),
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
    callback: z.object({
      willCheckpointAndRestore: z.boolean(),
      shouldExit: z.boolean(),
    }),
  },
  WAIT_FOR_DURATION: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      ms: z.number(),
      now: z.number(),
      attemptFriendlyId: z.string(),
    }),
    callback: z.object({
      willCheckpointAndRestore: z.boolean(),
    }),
  },
  WAIT_FOR_TASK: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      friendlyId: z.string(),
      // This is the attempt that is waiting
      attemptFriendlyId: z.string(),
    }),
    callback: z.object({
      willCheckpointAndRestore: z.boolean(),
    }),
  },
  WAIT_FOR_BATCH: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      batchFriendlyId: z.string(),
      runFriendlyIds: z.string().array(),
      // This is the attempt that is waiting
      attemptFriendlyId: z.string(),
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
  RESUME_AFTER_DEPENDENCY: {
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
  REQUEST_ATTEMPT_CANCELLATION: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      attemptId: z.string(),
    }),
  },
  REQUEST_EXIT: {
    message: z.object({
      version: z.literal("v1").default("v1"),
    }),
  },
  READY_FOR_RETRY: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      runId: z.string(),
    }),
  },
};

export const ProdWorkerSocketData = z.object({
  contentHash: z.string(),
  projectRef: z.string(),
  envId: z.string(),
  runId: z.string(),
  attemptFriendlyId: z.string().optional(),
  podName: z.string(),
  deploymentId: z.string(),
  deploymentVersion: z.string(),
});
