import { z } from "zod";

export const TestTaskData = z
  .discriminatedUnion("triggerSource", [
    z.object({
      triggerSource: z.literal("STANDARD"),
      payload: z
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
    }),
    z.object({
      triggerSource: z.literal("SCHEDULED"),
      timestamp: z.preprocess((val) => (val === "" ? undefined : val), z.coerce.date()),
      lastTimestamp: z.preprocess(
        (val) => (val === "" ? undefined : val),
        z.coerce.date().optional()
      ),
      timezone: z.string(),
      externalId: z.preprocess((val) => (val === "" ? undefined : val), z.string().optional()),
    }),
  ])
  .and(
    z.object({
      taskIdentifier: z.string(),
      environmentId: z.string(),
    })
  );

export type TestTaskData = z.infer<typeof TestTaskData>;
