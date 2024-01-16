import { z } from "zod";

export const TaskResource = z.object({
  id: z.string(),
  filePath: z.string(),
  exportName: z.string(),
});

export type TaskResource = z.infer<typeof TaskResource>;

export const BackgroundWorkerMetadata = z.object({
  packageVersion: z.string(),
  cliPackageVersion: z.string(),
  tasks: z.array(TaskResource),
});

export type BackgroundWorkerMetadata = z.infer<typeof BackgroundWorkerMetadata>;
