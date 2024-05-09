import { z } from "zod";
import { TaskRunExecution, TaskRunExecutionResult } from "./common";
import {
  EnvironmentType,
  Machine,
  ProdTaskRunExecution,
  ProdTaskRunExecutionPayload,
  TaskMetadataWithFilePath,
  TaskRunExecutionPayload,
  WaitReason,
} from "./schemas";
import { TaskResource } from "./resources";

export const BackgroundWorkerServerMessages = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("EXECUTE_RUNS"),
    payloads: z.array(TaskRunExecutionPayload),
  }),
  z.object({
    type: z.literal("CANCEL_ATTEMPT"),
    taskAttemptId: z.string(),
    taskRunId: z.string(),
  }),
  z.object({
    type: z.literal("SCHEDULE_ATTEMPT"),
    image: z.string(),
    version: z.string(),
    machine: Machine,
    // identifiers
    id: z.string(), // attempt
    envId: z.string(),
    envType: EnvironmentType,
    orgId: z.string(),
    projectId: z.string(),
    runId: z.string(),
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
  TASKS_FAILED_TO_PARSE: TaskMetadataFailedToParseData,
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
  UNCAUGHT_EXCEPTION: UncaughtExceptionMessage,
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
  TASKS_FAILED_TO_PARSE: {
    message: TaskMetadataFailedToParseData,
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
  READY_FOR_CHECKPOINT: {
    message: z.object({
      version: z.literal("v1").default("v1"),
    }),
  },
  CANCEL_CHECKPOINT: {
    message: z
      .discriminatedUnion("version", [
        z.object({
          version: z.literal("v1"),
        }),
        z.object({
          version: z.literal("v2"),
          reason: WaitReason.optional(),
        }),
      ])
      .default({ version: "v1" }),
    callback: z.object({
      // TODO: Figure out how best to handle callback schema parsing in zod IPC
      version: z.literal("v2") /* .default("v2") */,
      checkpointCanceled: z.boolean(),
      reason: WaitReason.optional(),
    }),
  },
  WAIT_FOR_DURATION: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      ms: z.number(),
      now: z.number(),
    }),
    callback: z.object({
      willCheckpointAndRestore: z.boolean(),
    }),
  },
  WAIT_FOR_TASK: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      friendlyId: z.string(),
    }),
  },
  WAIT_FOR_BATCH: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      batchFriendlyId: z.string(),
      runFriendlyIds: z.string().array(),
    }),
  },
  UNCAUGHT_EXCEPTION: {
    message: UncaughtExceptionMessage,
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
    callback: z.void(),
  },
  WAIT_COMPLETED_NOTIFICATION: {
    message: z.object({
      version: z.literal("v1").default("v1"),
    }),
  },
};

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
  WORKER_CRASHED: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      runId: z.string(),
      reason: z.string().optional(),
      exitCode: z.number().optional(),
      message: z.string().optional(),
      logs: z.string().optional(),
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
      deploymentId: z.string(),
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
  RUN_CRASHED: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      runId: z.string(),
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
    message: z
      .discriminatedUnion("version", [
        z.object({
          version: z.literal("v1"),
        }),
        z.object({
          version: z.literal("v2"),
          reason: WaitReason.optional(),
        }),
      ])
      .default({ version: "v1" }),
    callback: z.object({
      version: z.literal("v2").default("v2"),
      checkpointCanceled: z.boolean(),
      reason: WaitReason.optional(),
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
  UNRECOVERABLE_ERROR: {
    message: z.object({
      version: z.literal("v1").default("v1"),
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
