import { z } from "zod";
import { RequireKeys } from "../types";

export const Config = z.object({
  project: z.string(),
  triggerDirectories: z.string().array().optional(),
  triggerUrl: z.string().optional(),
  projectDir: z.string().optional(),
});

export type Config = z.infer<typeof Config>;
export type ResolvedConfig = RequireKeys<
  Config,
  "triggerDirectories" | "triggerUrl" | "projectDir"
>;

export const Machine = z.object({
  cpu: z.string().default("1").optional(),
  memory: z.string().default("500Mi").optional(),
});

export type Machine = z.infer<typeof Machine>;
