import { z } from "zod";

export const TestTaskData = z
  .discriminatedUnion("triggerSource", [
    z.object({
      triggerSource: z.literal("STANDARD"),
      payload: z.string().transform((payload, ctx) => {
        try {
          const data = JSON.parse(payload);
          return data as any;
        } catch (e) {
          console.log("parsing error", e);

          if (e instanceof Error) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: e.message,
            });
          } else {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "This is invalid JSON",
            });
          }
        }
      }),
      metadata: z.string().transform((metadata, ctx) => {
        try {
          const data = JSON.parse(metadata);
          return data as any;
        } catch (e) {
          console.log("parsing error", e);

          if (e instanceof Error) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: e.message,
            });
          } else {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "This is invalid JSON",
            });
          }
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
