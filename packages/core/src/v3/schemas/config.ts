import { z } from "zod";

export const ConfigManifest = z.object({
  projectRef: z.string(),
  dirs: z.string().array(),
  external: z.string().array().optional(),
});

export type ConfigManifest = z.infer<typeof ConfigManifest>;

export const BuildRuntime = z.enum(["node20", "bun"]);

export type BuildRuntime = z.infer<typeof BuildRuntime>;
