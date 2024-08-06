import { z } from "zod";
import { ConfigManifest } from "./config.js";

export const TaskFile = z.object({
  entry: z.string(),
  out: z.string(),
});

export type TaskFile = z.infer<typeof TaskFile>;

export const BuildExternal = z.object({
  name: z.string(),
  version: z.string(),
});

export type BuildExternal = z.infer<typeof BuildExternal>;

export const BuildTarget = z.enum(["dev", "deploy"]);

export type BuildTarget = z.infer<typeof BuildTarget>;

export const BuildRuntime = z.enum(["node20", "bun"]);

export type BuildRuntime = z.infer<typeof BuildRuntime>;

export const BuildManifest = z.object({
  target: BuildTarget,
  runtime: BuildRuntime,
  config: ConfigManifest,
  files: z.array(TaskFile),
  outputPath: z.string(),
  workerEntryPath: z.string(),
  workerForkPath: z.string(),
  loaderPath: z.string().optional(),
  configPath: z.string(),
  externals: BuildExternal.array().optional(),
  build: z.object({
    env: z.record(z.string()).optional(),
    commands: z.array(z.string()).optional(),
  }),
  deploy: z.object({
    env: z.record(z.string()).optional(),
  }),
});

export type BuildManifest = z.infer<typeof BuildManifest>;

export const IndexMessage = z.object({
  type: z.literal("index"),
  data: z.object({
    build: BuildManifest,
  }),
});

export type IndexMessage = z.infer<typeof IndexMessage>;

export const TaskManifest = z.object({
  id: z.string(),
  exportName: z.string(),
  file: TaskFile,
});

export type TaskManifest = z.infer<typeof TaskManifest>;

export const ExecuteTaskMessage = z.object({
  type: z.literal("execute-task"),
  data: z.object({
    task: TaskManifest,
    payload: z.unknown(),
    projectRef: z.string(),
    configPath: z.string(),
  }),
});

export type ExecuteTaskMessage = z.infer<typeof ExecuteTaskMessage>;

export const RunExecution = z.object({
  task: TaskManifest,
  payload: z.unknown(),
  projectRef: z.string(),
  configPath: z.string(),
  entryPath: z.string(),
  loaderPath: z.string().optional(),
  env: z.record(z.string()),
  cwd: z.string().optional(),
});

export type RunExecution = z.infer<typeof RunExecution>;

export const ParentToChildMessages = z.discriminatedUnion("type", [
  IndexMessage,
  ExecuteTaskMessage,
]);

export type ParentToChildMessages = z.infer<typeof ParentToChildMessages>;

export const WorkerManifest = z.object({
  tasks: TaskManifest.array(),
});

export type WorkerManifest = z.infer<typeof WorkerManifest>;

export const WorkerManifestMessage = z.object({
  type: z.literal("worker-manifest"),
  data: z.object({
    manifest: WorkerManifest,
  }),
});

export type WorkerManifestMessage = z.infer<typeof WorkerManifestMessage>;

export const FailedTaskCompletion = z.object({
  ok: z.literal(false),
  error: z.object({
    message: z.string(),
    stack: z.string().optional(),
    name: z.string().optional(),
  }),
});

export type FailedTaskCompletion = z.infer<typeof FailedTaskCompletion>;

export const SuccessfulTaskCompletion = z.object({
  ok: z.literal(true),
  output: z.unknown(),
});

export type SuccessfulTaskCompletion = z.infer<typeof SuccessfulTaskCompletion>;

export const TaskCompletion = z.discriminatedUnion("ok", [
  FailedTaskCompletion,
  SuccessfulTaskCompletion,
]);

export type TaskCompletion = z.infer<typeof TaskCompletion>;

export const CompletedTask = z.object({
  id: z.string(),
  completion: TaskCompletion,
  spans: z.array(z.any()),
});

export type CompletedTask = z.infer<typeof CompletedTask>;

export const CompletedTaskMessage = z.object({
  type: z.literal("completed-task"),
  data: CompletedTask,
});

export type CompletedTaskMessage = z.infer<typeof CompletedTaskMessage>;

export const ChildToParentMessages = z.discriminatedUnion("type", [
  WorkerManifestMessage,
  CompletedTaskMessage,
]);

export type ChildToParentMessages = z.infer<typeof ChildToParentMessages>;

export const TriggerTaskResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    output: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }),
]);

export type TriggerTaskResult = z.infer<typeof TriggerTaskResult>;
