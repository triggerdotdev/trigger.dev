import { z } from "zod";

export const ConfigManifest = z.object({
  project: z.string(),
  dirs: z.string().array(),
});

export type ConfigManifest = z.infer<typeof ConfigManifest>;
