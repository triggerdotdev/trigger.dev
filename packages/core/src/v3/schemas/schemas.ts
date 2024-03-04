import { z } from "zod";
import { RequireKeys } from "../types";
import { TaskRunExecution, TaskRunExecutionResult } from "./common";
import { ProdTaskRunExecution } from "./messages";
import { TaskResource } from "./resources";

export const Config = z.object({
  project: z.string(),
  triggerDirectories: z.string().array().optional(),
  triggerUrl: z.string().optional(),
  projectDir: z.string().optional(),
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
  LOG: z.object({
    version: z.literal("v1").default("v1"),
    data: z.string(),
  }),
};

export const PlatformToProviderMessages = {
  HEALTH: z.object({
    // TODO: callback: (ack: { status: "ok" }) => void
    version: z.literal("v1").default("v1"),
  }),
  INDEX: z.object({
    version: z.literal("v1").default("v1"),
    imageTag: z.string(),
    contentHash: z.string(),
    envId: z.string(),
  }),
  INVOKE: z.object({
    version: z.literal("v1").default("v1"),
    name: z.string(),
    machine: Machine,
  }),
  RESTORE: z.object({
    version: z.literal("v1").default("v1"),
    id: z.string(),
    attemptId: z.string(),
    type: z.enum(["DOCKER", "KUBERNETES"]),
    location: z.string(),
    reason: z.string().optional(),
  }),
  DELETE: z.object({
    // TODO: callback: (ack: { message: string }) => void
    version: z.literal("v1").default("v1"),
    name: z.string(),
  }),
  GET: z.object({
    version: z.literal("v1").default("v1"),
    name: z.string(),
  }),
};

export const CoordinatorToPlatformMessages = {
  LOG: z.object({
    version: z.literal("v1").default("v1"),
    metadata: z.any(),
    text: z.string(),
  }),
  CREATE_WORKER: z.object({
    version: z.literal("v1").default("v1"),
    projectRef: z.string(),
    envId: z.string(),
    metadata: z.object({
      cliPackageVersion: z.string(),
      contentHash: z.string(),
      packageVersion: z.string(),
      tasks: TaskResource.array(),
    }),
  }),
  // TODO: callback: (ack: { success: false } | { success: true; payload: ProdTaskRunExecutionPayload }) => void
  READY_FOR_EXECUTION: z.object({
    version: z.literal("v1").default("v1"),
    attemptId: z.string(),
  }),
  TASK_RUN_COMPLETED: z.object({
    version: z.literal("v1").default("v1"),
    execution: ProdTaskRunExecution,
    completion: TaskRunExecutionResult,
  }),
  TASK_HEARTBEAT: z.object({
    version: z.literal("v1").default("v1"),
    attemptFriendlyId: z.string(),
  }),
  CHECKPOINT_CREATED: z.object({
    version: z.literal("v1").default("v1"),
    attemptId: z.string(),
    docker: z.boolean(),
    location: z.string(),
    reason: z.string().optional(),
  }),
};

export const PlatformToCoordinatorMessages = {
  RESUME: z.object({
    version: z.literal("v1").default("v1"),
    attemptId: z.string(),
    image: z.string(),
    completions: TaskRunExecutionResult.array(),
    executions: TaskRunExecution.array(),
  }),
};
