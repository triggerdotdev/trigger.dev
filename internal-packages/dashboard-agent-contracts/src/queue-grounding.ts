/**
 * Where a queue's capacity is spent, read from the scheduler's own counters: the queue gate,
 * the environment gate, and the per-concurrency-key backlog. A read that cannot be completed is
 * `unresolved`, never a payload of zeros. Shared between the webapp (which produces it) and the
 * dashboard agent (which validates it at the boundary, since the webapp isn't importable there).
 *
 * Best-effort fields: `queue.queued`, `queue.displayed` and everything under `concurrencyKeys`
 * come from multi-command Redis pipelines whose per-command failures the scheduler reports as 0,
 * so those three can read low without the whole read failing. The rest either resolve or the
 * payload is `unresolved`.
 */
import { z } from "zod";

export const queueGroundingConcurrencyKeySchema = z.object({
  key: z.string(),
  queued: z.number(),
  running: z.number(),
  // A zset score is when the message becomes available, so this can be in the future while
  // the head of the key is in retry backoff.
  oldestAvailableAt: z.number(),
});

export type QueueGroundingConcurrencyKey = z.infer<typeof queueGroundingConcurrencyKeySchema>;

export const queueGroundingHoldersSchema = z.union([
  z.object({
    source: z.literal("run_queue"),
    coverage: z.enum(["complete", "partial"]),
    runIds: z.array(z.string()),
  }),
  z.object({ availability: z.literal("unavailable") }),
]);

export type QueueGroundingHolders = z.infer<typeof queueGroundingHoldersSchema>;

export const queueGroundingSchema = z.union([
  z.object({
    status: z.literal("unresolved"),
    // Tolerant: a future server-side reason must pass through, not collapse into
    // "scheduler_unavailable".
    reason: z.string(),
  }),
  z.object({
    asOf: z.string(),
    queue: z.object({
      queued: z.number(),
      // What the queue gate itself counts. On a keyed queue (`keyed: true`) the per-key
      // gates count separately, so read `concurrencyKeys.rows[].running` against
      // `enforcedLimit` per key as well.
      admitted: z.number(),
      // True when work on this queue is gated per concurrency key, not only per queue.
      keyed: z.boolean(),
      paused: z.boolean(),
      displayed: z.number(),
      // The configured queue cap, `null` when none is set.
      limit: z.number().nullable(),
      // What the dequeue gate actually enforces: min(limit ?? env limit, un-bursted env limit).
      enforcedLimit: z.number().optional(),
    }),
    env: z.object({
      admitted: z.number(),
      // The un-bursted environment limit, which is what caps the queue gate.
      limit: z.number().optional(),
      // The environment's own gate, which is the limit with the burst factor applied.
      effectiveLimit: z.number(),
      displayed: z.number(),
    }),
    oldestAvailableAtMs: z.number().nullable(),
    // Only keys with a live backlog appear, so a key that is saturated but has drained its
    // backlog is absent from `rows` and uncounted in `total`.
    concurrencyKeys: z.object({
      total: z.number(),
      truncated: z.boolean(),
      rows: z.array(queueGroundingConcurrencyKeySchema),
    }),
    holders: queueGroundingHoldersSchema,
  }),
]);

export type QueueGrounding = z.infer<typeof queueGroundingSchema>;
