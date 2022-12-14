import { z } from "zod";

export const WorkflowEventPropertiesSchema = z.object({
  "x-workflow-id": z.string(),
  "x-org-id": z.string(),
  "x-api-key": z.string(),
});

export const RetryOptionsSchema = z.object({
  retries: z.number().default(10),
  factor: z.number().default(2),
  minTimeout: z.number().default(1 * 1000),
  maxTimeout: z.number().default(60 * 1000),
  randomize: z.boolean().default(true),
});
