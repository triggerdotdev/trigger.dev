import { v, type Infer } from "convex/values";

export const vTriggerOptions = v.object({
  tags: v.optional(v.array(v.string())),
  delay: v.optional(v.string()),
  queue: v.optional(v.object({ name: v.string() })),
  concurrencyKey: v.optional(v.string()),
  machine: v.optional(v.string()),
  metadata: v.optional(v.any()),
  maxAttempts: v.optional(v.number()),
  maxDuration: v.optional(v.number()),
  ttl: v.optional(v.string()),
});

export const vConfig = v.object({
  secretKey: v.string(),
  baseUrl: v.string(),
});

export const runFields = {
  taskId: v.string(),
  runId: v.optional(v.string()),
  idempotencyKey: v.optional(v.string()),
  status: v.string(),
  syncStatus: v.union(
    v.literal("pending"),
    v.literal("active"),
    v.literal("paused"),
    v.literal("complete")
  ),
  output: v.optional(v.any()),
  outputPresignedUrl: v.optional(v.string()),
  outputOmitted: v.optional(v.boolean()),
  error: v.optional(v.any()),
  metadata: v.optional(v.any()),
  syncError: v.optional(v.string()),
  updatedAt: v.number(),
};
export const vRun = v.object({
  id: v.string(),
  createdAt: v.number(),
  ...runFields,
});

export type Run = Infer<typeof vRun>;
export type TriggerOptions = Infer<typeof vTriggerOptions>;
export type Config = Infer<typeof vConfig>;

const FIRST_POLL_MS = 15_000;
const MAX_POLL_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const MIN_REFRESH_INTERVAL_MS = 5_000;
export const WATCHDOG_MARGIN_MS = 5_000;
export const MAX_SYNC_FAILURES = 8;
export const SUBMISSION_WINDOW_MS = 60 * 60 * 1_000;
export const IDEMPOTENCY_TTL = "24h";
export const MAX_INLINE_BYTES = 256 * 1_024;
export const MAX_PAGE_BYTES = 4 * 1_024 * 1_024;

export function pollDelay(checks: number): number {
  return Math.min(FIRST_POLL_MS * 2 ** Math.min(checks, 4), MAX_POLL_MS);
}
