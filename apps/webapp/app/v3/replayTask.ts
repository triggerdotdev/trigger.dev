import { z } from "zod";
import { RunOptionsData } from "./testTask";

export const ReplayRunData = z
  .object({
    environment: z.string().optional(),
    payload: z
      .string()
      .optional()
      .transform((val, ctx) => {
        if (!val) {
          return "{}";
        }

        try {
          JSON.parse(val);
          return val;
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Payload must be a valid JSON string",
          });
          return z.NEVER;
        }
      }),
    metadata: z
      .string()
      .optional()
      .transform((val, ctx) => {
        if (!val) {
          return {};
        }

        try {
          return JSON.parse(val);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Metadata must be a valid JSON string",
          });
          return z.NEVER;
        }
      }),
    failedRedirect: z.string(),
  })
  .and(RunOptionsData);

export type ReplayRunData = z.infer<typeof ReplayRunData>;
