import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const QUEUE_ID = /^queue_[a-zA-Z0-9]{1,64}$/;

const QueueId = z
  .string()
  .max(71)
  .regex(QUEUE_ID, "A queue ID starts with queue_ followed by letters and digits")
  .describe("The queue ID, starting with queue_. Use list_queues to find it.");

const Period = z
  .string()
  .max(8)
  .regex(/^\d{1,5}[mhd]$/, 'A period is a number and a unit, e.g. "15m", "1h", "7d"')
  .describe(
    'The metrics window ending now, e.g. "15m", "1h", "1d" or "7d" (default 1h). It is held within the plan\'s query period and the 30-day retention.'
  );

export const ListQueuesInput = CommonProjectsInput.extend({
  query: z.string().max(200).describe("Only queues whose name contains this text.").optional(),
  sort: z
    .enum(["busiest", "queued", "name"])
    .describe(
      "Order: busiest (default, most recent activity first), queued (largest backlog first) or name. Without queue metrics the order is always name."
    )
    .optional(),
  includeArchived: z.boolean().describe("Also list archived queues.").optional(),
  page: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .describe("The page to return (25 per page).")
    .optional(),
  period: Period.optional(),
});

export const QueueDetailsInput = CommonProjectsInput.extend({
  queueId: QueueId,
  period: Period.optional(),
});

export const QueueWriteInput = CommonProjectsInput.extend({ queueId: QueueId });

export const OverrideQueueInput = CommonProjectsInput.extend({
  queueId: QueueId,
  limit: z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .describe(
      "The new per-key concurrency limit: how many runs of each concurrency key may run at once (the whole queue's limit when it has no keys). 0 stops new runs from starting."
    )
    .optional(),
  percent: z
    .number()
    .min(0.01)
    .max(100)
    .multipleOf(0.01)
    .describe(
      "Set the per-key limit as a percentage of the environment's concurrency limit instead of a number, from 0.01 to 100 with at most two decimals. It follows later changes to the environment limit."
    )
    .optional(),
  totalLimit: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .describe("The new total limit: how many runs may run at once across all concurrency keys.")
    .optional(),
});
