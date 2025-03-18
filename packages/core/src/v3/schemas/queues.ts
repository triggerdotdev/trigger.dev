import { z } from "zod";

/**
 * The type of queue, either "task" or "custom"
 * "task" are created automatically for each task.
 * "custom" are created by you explicitly in your code.
 * */
export const QueueType = z.enum(["task", "custom"]);
export type QueueType = z.infer<typeof QueueType>;

export const QueueItem = z.object({
  /** The queue name */
  name: z.string(),
  /**
   * The queue type, either "task" or "custom"
   * "task" are created automatically for each task.
   * "custom" are created by you explicitly in your code.
   * */
  type: QueueType,
  /** The number of runs currently running */
  running: z.number(),
  /** The number of runs currently queued */
  queued: z.number(),
  /** The concurrency limit of the queue */
  concurrencyLimit: z.number().nullable(),
});

export type QueueItem = z.infer<typeof QueueItem>;

export const ListQueueOptions = z.object({
  /** The page number */
  page: z.number().optional(),
  /** The number of queues per page */
  perPage: z.number().optional(),
});

export type ListQueueOptions = z.infer<typeof ListQueueOptions>;
