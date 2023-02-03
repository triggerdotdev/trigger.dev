import { z } from "zod";
import { SerializableJsonSchema } from "./json";

export const InitializeRunOnceSchema = z.object({
  type: z.enum(["REMOTE", "LOCAL_ONLY"]),
});

export const CompleteRunOnceSchema = z.object({
  type: z.enum(["REMOTE", "LOCAL_ONLY"]),
  idempotencyKey: z.string(),
  output: z.string().optional(),
});

export const ResolveRunOnceOuputSchema = z.object({
  idempotencyKey: z.string(),
  hasRun: z.boolean(),
  output: SerializableJsonSchema.optional(),
});
