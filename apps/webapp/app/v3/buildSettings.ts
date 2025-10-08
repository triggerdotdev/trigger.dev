import { z } from "zod";

export const BuildSettingsSchema = z.object({
  triggerConfigFilePath: z.string().optional(),
  installCommand: z.string().optional(),
  preBuildCommand: z.string().optional(),
});

export type BuildSettings = z.infer<typeof BuildSettingsSchema>;
