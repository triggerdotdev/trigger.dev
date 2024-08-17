import { z } from "zod";
import { ConfigManifest } from "./config.js";
import { TaskFile, TaskManifest } from "./schemas.js";

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
  packageVersion: z.string(),
  cliPackageVersion: z.string(),
  contentHash: z.string(),
  runtime: BuildRuntime,
  environment: z.string(),
  config: ConfigManifest,
  files: z.array(TaskFile),
  sources: z.record(
    z.object({
      contents: z.string(),
      contentHash: z.string(),
    })
  ),
  outputPath: z.string(),
  indexerEntryPoint: z.string(),
  workerEntryPoint: z.string(),
  loaderEntryPoint: z.string().optional(),
  configPath: z.string(),
  externals: BuildExternal.array().optional(),
  build: z.object({
    env: z.record(z.string()).optional(),
    commands: z.array(z.string()).optional(),
  }),
  deploy: z.object({
    env: z.record(z.string()).optional(),
    needsSyncing: z.boolean().optional(),
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

export const WorkerManifest = z.object({
  configPath: z.string(),
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
