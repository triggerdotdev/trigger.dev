import { z } from "zod";
import { QueueOptions } from "./messages";

export const TaskResource = z.object({
  id: z.string(),
  filePath: z.string(),
  exportName: z.string(),
  queue: QueueOptions.optional(),
});

export type TaskResource = z.infer<typeof TaskResource>;

export const BackgroundWorkerMetadata = z.object({
  packageVersion: z.string(),
  contentHash: z.string(),
  cliPackageVersion: z.string(),
  tasks: z.array(TaskResource),
});

export type BackgroundWorkerMetadata = z.infer<typeof BackgroundWorkerMetadata>;
