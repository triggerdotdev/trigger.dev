import { z } from "zod";

export const BuildSettingsSchema = z.object({
  triggerConfigFilePath: z.string().optional(),
  installCommand: z.string().optional(),
  preBuildCommand: z.string().optional(),
  // Opt-out flag: the native build server is used by default. Only set when a
  // project explicitly disables it. Absence means native build server enabled.
  disableNativeBuildServer: z.boolean().optional(),
});

export type BuildSettings = z.infer<typeof BuildSettingsSchema>;
