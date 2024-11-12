import { EnvironmentType, MachinePreset, TaskRunInternalError } from "@trigger.dev/core/v3";
import { z } from "zod";

export const WorkerToPlatformMessages = {
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
      /** This means we should only update the error if one exists */
      overrideCompletion: z.boolean().optional(),
      errorCode: TaskRunInternalError.shape.code.optional(),
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
        stderr: z.string().optional(),
      }),
      overrideCompletion: z.boolean().optional(),
    }),
  },
};

export const PlatformToWorkerMessages = {
  RESTORE: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      type: z.enum(["DOCKER", "KUBERNETES"]),
      location: z.string(),
      reason: z.string().optional(),
      imageRef: z.string(),
      attemptNumber: z.number().optional(),
      machine: MachinePreset,
      // identifiers
      checkpointId: z.string(),
      envId: z.string(),
      envType: EnvironmentType,
      orgId: z.string(),
      projectId: z.string(),
      runId: z.string(),
    }),
  },
  PRE_PULL_DEPLOYMENT: {
    message: z.object({
      version: z.literal("v1").default("v1"),
      imageRef: z.string(),
      shortCode: z.string(),
      // identifiers
      envId: z.string(),
      envType: EnvironmentType,
      orgId: z.string(),
      projectId: z.string(),
      deploymentId: z.string(),
    }),
  },
};
