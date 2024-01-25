import { z } from "zod";

export const CommonCommandOptions = z.object({
  logLevel: z.enum(["debug", "info", "log", "warn", "error", "none"]).default("log"),
});

export type CommonCommandOptions = z.infer<typeof CommonCommandOptions>;
