import { z } from "zod";

export const LogLevelSchema = z
  .enum(["debug", "info", "log", "warn", "error", "none"])
  .default("log");
export type Loglevel = z.infer<typeof LogLevelSchema>;
export const PackageManagerSchema = z.enum(["bun", "npm", "pnpm", "yarn"]).default("npm");
export type PackageManager = z.infer<typeof PackageManagerSchema>;
