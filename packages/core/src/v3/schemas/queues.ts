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

const QueueItemCommon = {
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
  /** Whether the queue is paused. If it's paused, no new runs will be started. */
  paused: z.boolean(),
  /**
   * The queue's own concurrency limit. Meaningful on V1 queues only; always
   * null on V2 queues (kept on both so existing clients keep parsing).
   */
  concurrencyLimit: z.number().nullable(),
};

/**
 * The queue's `version` discriminates its shape. V1 queues carry their own
 * concurrency limit (applied per key when runs pass a `concurrencyKey`, to the
 * whole queue when they don't) and its override state. V2 queues are only the
 * line runs wait in: concurrency is declared with the task `concurrency`
 * option and read or overridden through `concurrencyLimits`. A response from a
 * server that predates the discriminator has V1 semantics by definition, so a
 * missing `version` defaults to "V1" rather than failing the parse.
 */
const QueueItemUnion = z.discriminatedUnion("version", [
  z.object({
    ...QueueItemCommon,
    version: z.literal("V1"),
    /** The queue's concurrency limit override state */
    concurrency: z
      .object({
        /** The effective/current concurrency limit */
        current: z.number().nullable(),
        /** The base concurrency limit (default) */
        base: z.number().nullable(),
        /** The overridden concurrency limit, when an override is active */
        override: z.number().nullable(),
        /** When the override was applied */
        overriddenAt: z.coerce.date().nullable(),
        /** Who overrode the concurrency limit (will be null if overridden via the API) */
        overriddenBy: z.string().nullable(),
      })
      .optional(),
  }),
  z.object({
    ...QueueItemCommon,
    version: z.literal("V2"),
    /** Never present on V2 queues; declared so existing `queue.concurrency?.…`
     * reads keep compiling across the union and see undefined. */
    concurrency: z.undefined().optional(),
  }),
]);

export const QueueItem = z.preprocess(
  (value) =>
    value && typeof value === "object" && !("version" in value)
      ? { ...value, version: "V1" }
      : value,
  QueueItemUnion
);

export type QueueItem = z.infer<typeof QueueItemUnion>;

export const ListQueueOptions = z.object({
  /** The page number */
  page: z.number().optional(),
  /** The number of queues per page */
  perPage: z.number().optional(),
});

export type ListQueueOptions = z.infer<typeof ListQueueOptions>;

export const QueueTypeName = z.object({
  /** "task" or "custom" */
  type: QueueType,
  /** The name of your queue.
   * For "task" type it will be the task id, for "custom" it will be the name you specified.
   * */
  name: z.string(),
});

export type QueueTypeName = z.infer<typeof QueueTypeName>;

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
export const RetrieveQueueParam = z.union([z.string(), QueueTypeName]);

export type RetrieveQueueParam = z.infer<typeof RetrieveQueueParam>;

/** One bound of a concurrency limit: the enforced value, the declared base, and
 * any active override. `current` is what the engine enforces right now. */
export const ConcurrencyLimitBound = z.object({
  current: z.number().nullable(),
  base: z.number().nullable(),
  override: z.number().nullable(),
  overriddenAt: z.coerce.date().nullable(),
});

export type ConcurrencyLimitBound = z.infer<typeof ConcurrencyLimitBound>;

export const ConcurrencyLimitItem = z.object({
  /** The limit's id, starting with `climit_`. */
  id: z.string(),
  /** The limit's name, as declared with `concurrencyLimit()` (anonymous inline
   * limits use the derived name `task/<taskId>`). */
  name: z.string(),
  /** Caps each concurrencyKey pool; runs without a key share one pool. */
  perKey: ConcurrencyLimitBound,
  /** Caps every run holding this limit, keys or not. */
  total: ConcurrencyLimitBound,
  /** Runs executing that hold this limit. */
  running: z.number(),
  /** Runs that are queued and must clear this limit to execute. */
  queued: z.number(),
});

export type ConcurrencyLimitItem = z.infer<typeof ConcurrencyLimitItem>;

export const ListConcurrencyLimitOptions = z.object({
  page: z.number().optional(),
  perPage: z.number().optional(),
});

export type ListConcurrencyLimitOptions = z.infer<typeof ListConcurrencyLimitOptions>;

/** Changes only the given bounds. Zero blocks every run holding the limit, which
 * is how a limit is paused; `reset` restores the declared values. */
export const OverrideConcurrencyLimitRequestBody = z
  .object({
    perKey: z.number().int().min(0).max(100000).optional(),
    total: z.number().int().min(0).max(100000).optional(),
  })
  .refine((body) => body.perKey !== undefined || body.total !== undefined, {
    message: "Provide at least one of `perKey` or `total`",
  });

export type OverrideConcurrencyLimitRequestBody = z.infer<
  typeof OverrideConcurrencyLimitRequestBody
>;
