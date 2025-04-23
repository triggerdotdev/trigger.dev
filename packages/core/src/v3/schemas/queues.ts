import { z } from "zod";

const queueTypes = ["task", "custom"] as const;

/**
 * The type of queue, either "task" or "custom"
 * "task" are created automatically for each task.
 * "custom" are created by you explicitly in your code.
 * */
export const QueueType = z.enum(queueTypes);
export type QueueType = z.infer<typeof QueueType>;

export const RetrieveQueueType = z.enum([...queueTypes, "id"]);
export type RetrieveQueueType = z.infer<typeof RetrieveQueueType>;

export const QueueItem = z.object({
  /** The queue id, e.g. queue_12345 */
  id: z.string(),
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
  /** Whether the queue is paused. If it's paused, no new runs will be started. */
  paused: z.boolean(),
  /** Whether the queue releases concurrency on waitpoints. */
  releaseConcurrencyOnWaitpoint: z.boolean(),
});

export type QueueItem = z.infer<typeof QueueItem>;

export const ListQueueOptions = z.object({
  /** The page number */
  page: z.number().optional(),
  /** The number of queues per page */
  perPage: z.number().optional(),
});

export type ListQueueOptions = z.infer<typeof ListQueueOptions>;

/**
 * When retrieving a queue you can either use the queue id,
 * or the type and name.
 *
 * @example
 *
 * ```ts
 * // Use a queue id (they start with queue_
 * const q1 = await queues.retrieve("queue_12345");
 *
 * // Or use the type and name
 * // The default queue for your "my-task-id"
 * const q2 = await queues.retrieve({ type: "task", name: "my-task-id"});
 *
 * // The custom queue you defined in your code
 * const q3 = await queues.retrieve({ type: "custom", name: "my-custom-queue" });
 * ```
 */
export const RetrieveQueueParam = z.union([
  z.string(),
  z.object({
    /** "task" or "custom" */
    type: QueueType,
    /** The name of your queue.
     * For "task" type it will be the task id, for "custom" it will be the name you specified.
     * */
    name: z.string(),
  }),
]);

export type RetrieveQueueParam = z.infer<typeof RetrieveQueueParam>;
