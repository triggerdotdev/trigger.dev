import { z } from "zod";
import { ConfigManifest } from "./config.js";
import { QueueManifest, TaskFile, TaskManifest } from "./schemas.js";

export const BuildExternal = z.object({
  name: z.string(),
  version: z.string(),
});

export type BuildExternal = z.infer<typeof BuildExternal>;

export const BuildTarget = z.enum(["dev", "deploy", "unmanaged"]);

export type BuildTarget = z.infer<typeof BuildTarget>;

export const BuildRuntime = z.enum(["node", "node-22", "bun"]);

export type BuildRuntime = z.infer<typeof BuildRuntime>;

export const BuildManifest = z.object({
  target: BuildTarget,
  packageVersion: z.string(),
  cliPackageVersion: z.string(),
  contentHash: z.string(),
  runtime: BuildRuntime,
  environment: z.string(),
  branch: z.string().optional(),
  config: ConfigManifest,
  files: z.array(TaskFile),
  sources: z.record(
    z.object({
      contents: z.string(),
      contentHash: z.string(),
    })
  ),
  outputPath: z.string(),
  runWorkerEntryPoint: z.string(), // Dev & Deploy has a runWorkerEntryPoint
  runControllerEntryPoint: z.string().optional(), // Only deploy has a runControllerEntryPoint
  indexWorkerEntryPoint: z.string(), // Dev & Deploy has a indexWorkerEntryPoint
  indexControllerEntryPoint: z.string().optional(), // Only deploy has a indexControllerEntryPoint
  loaderEntryPoint: z.string().optional(),
  initEntryPoint: z.string().optional(), // Optional init.ts entry point
  configPath: z.string(),
  externals: BuildExternal.array().optional(),
  build: z.object({
    env: z.record(z.string()).optional(),
    commands: z.array(z.string()).optional(),
  }),
  customConditions: z.array(z.string()).optional(),
  deploy: z.object({
    env: z.record(z.string()).optional(),
    sync: z
      .object({
        env: z.record(z.string()).optional(),
        parentEnv: z.record(z.string()).optional(),
      })
      .optional(),
  }),
  image: z
    .object({
      pkgs: z.array(z.string()).optional(),
      instructions: z.array(z.string()).optional(),
    })
    .optional(),
  otelImportHook: z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
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
  queues: QueueManifest.array().optional(),
  workerEntryPoint: z.string(),
  controllerEntryPoint: z.string().optional(),
  loaderEntryPoint: z.string().optional(),
  initEntryPoint: z.string().optional(), // Optional init.ts entry point
  runtime: BuildRuntime,
  customConditions: z.array(z.string()).optional(),
  timings: z.record(z.number()).optional(),
  processKeepAlive: z
    .object({
      enabled: z.boolean(),
      maxExecutionsPerProcess: z.number().optional(),
    })
    .optional(),

  otelImportHook: z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
});

export type WorkerManifest = z.infer<typeof WorkerManifest>;

export const WorkerManifestMessage = z.object({
  type: z.literal("worker-manifest"),
  data: z.object({
    manifest: WorkerManifest,
  }),
});

export type WorkerManifestMessage = z.infer<typeof WorkerManifestMessage>;

export const ImportError = z.object({
  message: z.string(),
  file: z.string(),
  stack: z.string().optional(),
  name: z.string().optional(),
});

export type ImportError = z.infer<typeof ImportError>;

export const ImportTaskFileErrors = z.array(ImportError);

export type ImportTaskFileErrors = z.infer<typeof ImportTaskFileErrors>;
