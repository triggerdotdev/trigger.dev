import { Submission } from "@conform-to/react";
import { z } from "zod";

const schema = z.object({
  intent: z.string(),
  payload: z.record(z.unknown()),
  error: z.record(z.array(z.string())),
  value: z.any().nullable().optional(),
});

export function isSubmissionResult(obj: unknown): obj is Submission {
  return schema.safeParse(obj).success;
}
