import { z } from "zod";

export const BuildSettingsSchema = z.object({
  rootDirectory: z.string().optional(),
  installCommand: z.string().optional(),
  triggerConfigFile: z.string().optional(),
});

export type BuildSettings = z.infer<typeof BuildSettingsSchema>;
