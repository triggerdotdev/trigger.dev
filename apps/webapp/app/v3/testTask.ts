import { z } from "zod";
import { MachinePresetName } from "@trigger.dev/core/v3/schemas";

export const RunOptionsData = z.object({
  delaySeconds: z
    .number()
    .min(0)
    .optional()
    .transform((val) => (val === 0 ? undefined : val)),
  ttlSeconds: z
    .number()
    .min(0)
    .optional()
    .transform((val) => (val === 0 ? undefined : val)),
  idempotencyKey: z.string().optional(),
  idempotencyKeyTTLSeconds: z
    .number()
    .min(0)
    .optional()
    .transform((val) => (val === 0 ? undefined : val)),
  queue: z.string().optional(),
  concurrencyKey: z.string().optional(),
  maxAttempts: z.number().min(1).optional(),
  machine: MachinePresetName.optional(),
  maxDurationSeconds: z
    .number()
    .min(0)
    .optional()
    .transform((val) => (val === 0 ? undefined : val)),
  tags: z
    .string()
    .optional()
    .transform((val) => {
      if (!val || val.trim() === "") {
        return undefined;
      }
      return val
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
    })
    .refine((tags) => !tags || tags.length <= 10, {
      message: "Maximum 10 tags allowed",
    })
    .refine((tags) => !tags || tags.every((tag) => tag.length <= 128), {
      message: "Each tag must be at most 128 characters long",
    }),
  version: z.string().optional(),
});

export type RunOptionsData = z.infer<typeof RunOptionsData>;

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
  .and(RunOptionsData)
  .and(
    z.object({
      taskIdentifier: z.string(),
      environmentId: z.string(),
    })
  );

export type TestTaskData = z.infer<typeof TestTaskData>;
