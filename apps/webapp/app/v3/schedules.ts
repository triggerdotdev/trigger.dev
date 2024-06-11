import { parseExpression } from "cron-parser";
import { z } from "zod";

export const CronPattern = z.string().refine(
  (val) => {
    //only allow CRON expressions that don't include seconds (they have 5 parts)
    const parts = val.split(" ");
    if (parts.length > 5) {
      return false;
    }

    if (val === "") {
      return false;
    }

    try {
      parseExpression(val);
      return true;
    } catch (e) {
      return false;
    }
  },
  (val) => {
    const parts = val.split(" ");
    if (parts.length > 5) {
      return {
        message: "CRON expressions with seconds are not allowed",
      };
    }

    if (val === "") {
      return {
        message: "CRON expression is required",
      };
    }

    try {
      parseExpression(val);
      return {
        message: "Unknown problem",
      };
    } catch (e) {
      return { message: e instanceof Error ? e.message : JSON.stringify(e) };
    }
  }
);

export const UpsertSchedule = z.object({
  friendlyId: z.string().optional(),
  taskIdentifier: z.string().min(1, "Task is required"),
  cron: CronPattern,
  environments: z.preprocess(
    (data) => (typeof data === "string" ? [data] : data),
    z.array(z.string()).min(1, "At least one environment is required")
  ),
  externalId: z.string().optional(),
  deduplicationKey: z.string().optional(),
  timezone: z.string().optional(),
});

export type UpsertSchedule = z.infer<typeof UpsertSchedule>;
