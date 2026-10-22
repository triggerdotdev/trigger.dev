import { z } from "zod/v4";
import { discriminatedUnion, preprocess } from "../utils/zod.js";

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
const QueueItemUnion = discriminatedUnion("version", [
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

export const QueueItem = preprocess(
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
 * any active override. `current` is the cap this bound enforces right now (the
 * stored value clamped to the environment concurrency limit). Pausing an
 * environment or queue stops dequeues without changing its configured bounds,
 * so pause state is reported separately, never as a `current` of 0. */
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
  /** Whether the limit is paused. A paused limit admits no runs until resumed;
   * its configured bounds are kept. Older servers omit the field. */
  paused: z.boolean().default(false),
});

export type ConcurrencyLimitItem = z.infer<typeof ConcurrencyLimitItem>;

export const ListConcurrencyLimitOptions = z.object({
  page: z.number().optional(),
  perPage: z.number().optional(),
});

export type ListConcurrencyLimitOptions = z.infer<typeof ListConcurrencyLimitOptions>;

/** A concurrency-key value as callers write it: numbers are accepted and stored as strings,
 * matching how a trigger's `concurrencyKey` is coerced. */
const OverrideConcurrencyKeySchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .pipe(z.string().min(1).max(128));

const ConcurrencyBoundSchema = z.number().int().min(0).max(100000);

const OverrideTtlSchema = z.string().or(z.number().int().positive());

/** Changes only the given bounds of the limit itself. Zero blocks every run holding
 * the limit, which is how a limit is paused; `reset` restores the declared values. */
export const OverrideConcurrencyLimitBoundsBody = z
  .object({
    perKey: ConcurrencyBoundSchema.optional(),
    total: ConcurrencyBoundSchema.optional(),
    concurrencyKey: z.never().optional(),
    ttl: z.never().optional(),
  })
  .refine((body) => body.perKey !== undefined || body.total !== undefined, {
    message: "Provide at least one of `perKey` or `total`",
  });

export type OverrideConcurrencyLimitBoundsBody = z.infer<typeof OverrideConcurrencyLimitBoundsBody>;

/** A temporary per-key cap on this limit's `perKey` for one concurrencyKey: `0`
 * blocks the key, and the override expires after `ttl` (a duration such as `"7d"`
 * or a number of seconds; default 7 days, at most 30 days). `total` is not per key,
 * so it cannot be given here. `reset` with the same `concurrencyKey` clears it. */
export const OverrideConcurrencyLimitKeyBody = z.object({
  concurrencyKey: OverrideConcurrencyKeySchema,
  perKey: ConcurrencyBoundSchema,
  ttl: OverrideTtlSchema.optional(),
  total: z.never().optional(),
});

export type OverrideConcurrencyLimitKeyBody = z.infer<typeof OverrideConcurrencyLimitKeyBody>;

/** Either the limit's own bounds or a per-key cap, told apart by `concurrencyKey`.
 * The output type is the union of the two shapes above, so `total` with a key, a key
 * without `perKey`, and `ttl` without a key are type errors for SDK callers. Parsing
 * goes through one flat object with cross-field checks rather than a `z.union`, so an
 * HTTP caller gets a single message naming the field at fault instead of the failures
 * of both branches. */
export const OverrideConcurrencyLimitRequestBody = z
  .object({
    perKey: ConcurrencyBoundSchema.optional(),
    total: ConcurrencyBoundSchema.optional(),
    concurrencyKey: OverrideConcurrencyKeySchema.optional(),
    ttl: OverrideTtlSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.concurrencyKey !== undefined) {
      if (body.perKey === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["perKey"],
          message: "A per-key override needs `perKey`",
        });
      }
      if (body.total !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["total"],
          message: "`total` is not per key; omit it when overriding one concurrencyKey",
        });
      }
      return;
    }
    if (body.ttl !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["ttl"],
        message: "`ttl` only applies to a per-key override; pass `concurrencyKey` with it",
      });
    }
    if (body.perKey === undefined && body.total === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Provide at least one of `perKey` or `total`",
      });
    }
  })
  .transform(
    (body) => body as OverrideConcurrencyLimitKeyBody | OverrideConcurrencyLimitBoundsBody
  );

export type OverrideConcurrencyLimitRequestBody = z.infer<
  typeof OverrideConcurrencyLimitRequestBody
>;

/** `reset` with a `concurrencyKey` clears that key's override and leaves the limit
 * itself alone; without one it resets the limit's own override. */
export const ResetConcurrencyLimitRequestBody = z.object({
  concurrencyKey: OverrideConcurrencyKeySchema.optional(),
});

export type ResetConcurrencyLimitRequestBody = z.infer<typeof ResetConcurrencyLimitRequestBody>;

export const RetrieveConcurrencyLimitOptions = z.object({
  /** Return the view of this limit for one concurrencyKey instead of the limit itself. */
  concurrencyKey: OverrideConcurrencyKeySchema.optional(),
});

export type RetrieveConcurrencyLimitOptions = z.infer<typeof RetrieveConcurrencyLimitOptions>;

/** The per-key bound of a limit for one concurrencyKey: `base` is the limit's own
 * `perKey` as enforced, `override` the key's temporary cap, `current` whichever
 * applies right now (env-clamped). A paused limit still reports its bounds. */
export const ConcurrencyLimitKeyBound = z.object({
  current: z.number().nullable(),
  base: z.number().nullable(),
  override: z.number().nullable(),
  /** When the key's override lapses; null when there is none. */
  expiresAt: z.coerce.date().nullable(),
});

export type ConcurrencyLimitKeyBound = z.infer<typeof ConcurrencyLimitKeyBound>;

export const ConcurrencyLimitKeyItem = z.object({
  /** The limit's name. */
  name: z.string(),
  concurrencyKey: z.string(),
  perKey: ConcurrencyLimitKeyBound,
  /** Runs executing for this key that hold this limit. */
  running: z.number(),
  /** Whether the limit is paused. A paused limit admits no runs, override or not. */
  paused: z.boolean(),
});

export type ConcurrencyLimitKeyItem = z.infer<typeof ConcurrencyLimitKeyItem>;
