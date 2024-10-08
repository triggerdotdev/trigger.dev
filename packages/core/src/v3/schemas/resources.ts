import { z } from "zod";
import { QueueOptions, RetryOptions, ScheduleMetadata } from "./schemas.js";
import { MachineConfig } from "./common.js";

export const TaskResource = z.object({
  id: z.string(),
  filePath: z.string(),
  exportName: z.string(),
  queue: QueueOptions.optional(),
  retry: RetryOptions.optional(),
  machine: MachineConfig.optional(),
  triggerSource: z.string().optional(),
  schedule: ScheduleMetadata.optional(),
});

export type TaskResource = z.infer<typeof TaskResource>;

export const BackgroundWorkerSourceFileMetadata = z.object({
  filePath: z.string(),
  contents: z.string(),
  contentHash: z.string(),
  taskIds: z.array(z.string()),
});

export type BackgroundWorkerSourceFileMetadata = z.infer<typeof BackgroundWorkerSourceFileMetadata>;

export const BackgroundWorkerMetadata = z.object({
  packageVersion: z.string(),
  contentHash: z.string(),
  cliPackageVersion: z.string().optional(),
  tasks: z.array(TaskResource),
  sourceFiles: z.array(BackgroundWorkerSourceFileMetadata).optional(),
});

export type BackgroundWorkerMetadata = z.infer<typeof BackgroundWorkerMetadata>;

export const ImageDetailsMetadata = z.object({
  contentHash: z.string(),
  imageTag: z.string(),
});

export type ImageDetailsMetadata = z.infer<typeof ImageDetailsMetadata>;
