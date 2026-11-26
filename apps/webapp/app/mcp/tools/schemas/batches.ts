import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const BATCH_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "PARTIAL_FAILED",
  "ABORTED",
] as const;

export const BATCH_ID = /^batch_[A-Za-z0-9]{1,64}$/;
export const BATCH_LIST_CURSOR = /^\d{1,16}_[A-Za-z0-9]{1,64}$/;
export const PERIOD = /^\d{1,6}[smhdw]$/;

export const ListBatchesInput = CommonProjectsInput.extend({
  statuses: z
    .array(z.enum(BATCH_STATUSES))
    .min(1)
    .max(BATCH_STATUSES.length)
    .describe("Only batches with these statuses")
    .optional(),
  period: z
    .string()
    .regex(PERIOD, "Must be a duration like 1h, 7d or 30d")
    .describe("Only batches created in the last N time period, e.g. 1h, 7d, 30d. Defaults to 7d")
    .optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe("The number of batches to list. Up to 100, defaults to 25")
    .default(25),
  cursor: z
    .string()
    .regex(BATCH_LIST_CURSOR, "Must be a cursor returned by list_batches")
    .describe("The cursor from a previous list_batches call, to list older ones")
    .optional(),
});

export type ListBatchesInput = z.output<typeof ListBatchesInput>;

export const GetBatchInput = CommonProjectsInput.extend({
  batchId: z
    .string()
    .regex(BATCH_ID, "Must be lowercase batch_ followed by letters and digits")
    .describe("The ID of the batch, starts with batch_"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .describe("The number of created runs to show. Up to 50, defaults to 25")
    .default(25),
  cursor: z
    .string()
    .regex(/^\d{1,6}$/, "Must be a cursor returned by get_batch_details")
    .describe("The cursor from a previous get_batch_details call, to show the next created runs")
    .optional(),
});

export type GetBatchInput = z.output<typeof GetBatchInput>;
