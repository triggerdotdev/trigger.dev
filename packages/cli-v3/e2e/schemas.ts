import { z } from "zod";

const LogLevelSchema = z.enum(["debug", "info", "log", "warn", "error", "none"]).default("log");
const PackageManagerSchema = z.enum(["npm", "pnpm", "yarn"]);
export const E2EOptionsSchema = z.object({
  logLevel: LogLevelSchema,
  packageManager: PackageManagerSchema.optional(),
});
export type E2EOptions = z.infer<typeof E2EOptionsSchema>;
