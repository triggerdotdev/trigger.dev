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
    }),
    z.object({
      triggerSource: z.literal("SCHEDULED"),
      timestamp: z.coerce.date(),
      lastTimestamp: z.coerce.date().optional(),
      externalId: z.string().optional(),
    }),
  ])
  .and(
    z.object({
      taskIdentifier: z.string(),
      environmentId: z.string(),
    })
  );

export type TestTaskData = z.infer<typeof TestTaskData>;
