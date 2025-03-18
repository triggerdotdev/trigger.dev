import { z } from "zod";

export const QueueType = z.enum(["task", "custom"]);
export type QueueType = z.infer<typeof QueueType>;

export const QueueItem = z.object({
  name: z.string(),
  type: QueueType,
  running: z.number(),
  queued: z.number(),
  concurrencyLimit: z.number().nullable(),
});

export const ListQueueOptions = z.object({
  page: z.number().optional(),
  perPage: z.number().optional(),
});

export type ListQueueOptions = z.infer<typeof ListQueueOptions>;
