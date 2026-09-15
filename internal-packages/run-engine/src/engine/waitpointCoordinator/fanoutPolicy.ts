import { createHash } from "node:crypto";
import type { WaitpointCompletion } from "./storeCoordinator.js";

/**
 * The pure decisions behind bounded fanout: what identifies a completion, how long to wait
 * before retrying an entry, when to give up, and how much of a partly-failed page may be
 * acknowledged. No Redis, so each one tests as a value-in/value-out function.
 */

/**
 * The identity of a completion, for telling a retry of the same completion apart from a
 * genuinely different second one.
 *
 * `completedAt` is excluded deliberately: two attempts at the same logical completion carry
 * different timestamps, and treating that as a conflict would quarantine healthy waitpoints
 * on ordinary retries.
 */
export function completionFingerprint(completion: WaitpointCompletion): string {
  const output = completion.output;
  // The discriminator is part of the digest: a ref and an inline value of the same text are
  // different completions.
  const normalisedOutput =
    output === null ? "n" : "inline" in output ? `i:${output.inline}` : `r:${output.ref}`;

  return createHash("sha256")
    .update(
      JSON.stringify([completion.outputType, completion.outputIsError ? 1 : 0, normalisedOutput])
    )
    .digest("hex");
}

export type FanoutRetryPolicy = {
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Consecutive failures after which an entry is quarantined instead of retried. Any
   * acknowledged progress resets the streak, so this bounds retries per stall rather than
   * per waitpoint.
   *
   * Compared against inside `wpFanoutRelease`, because the comparison has to be atomic with
   * the increment and with the claim's owner check — see that script.
   */
  maxFailures: number;
};

export const DEFAULT_FANOUT_RETRY_POLICY: FanoutRetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxFailures: 20,
};

/**
 * Exponential backoff, capped, with no jitter. Entries are keyed by waitpoint id in a
 * sorted set, so two workers retrying one entry contend on its claim rather than forming a
 * herd, and a deterministic delay is one a test can assert.
 */
export function fanoutRetryDelayMs(attempt: number, policy: FanoutRetryPolicy): number {
  if (attempt <= 1) {
    return policy.baseDelayMs;
  }
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
}

/**
 * What the worker did with one queued watcher. The first four are TERMINAL for that
 * watcher — retrying changes nothing, so its queue entry may be trimmed. `rejected` covers
 * a superseded block operation and a run past terminal cleanup, both of which would refuse
 * a redelivery identically. `failed` is the only retryable outcome.
 */
export type WatcherDeliveryOutcome =
  | "delivered"
  | "duplicate"
  | "stale-watcher"
  | "rejected"
  | "failed";

export function isAcknowledgeable(outcome: WatcherDeliveryOutcome): boolean {
  return outcome !== "failed";
}

/**
 * How many entries at the head of a page may be trimmed.
 *
 * The queue is trimmed from the head, so only a contiguous prefix of acknowledgeable
 * outcomes can be retired. Stopping at the first failure leaves that watcher at the head
 * for the next attempt and never skips past it — skipping is how a wake-up gets lost.
 */
export function acknowledgeablePrefix(outcomes: WatcherDeliveryOutcome[]): number {
  let prefix = 0;
  for (const outcome of outcomes) {
    if (!isAcknowledgeable(outcome)) {
      break;
    }
    prefix++;
  }
  return prefix;
}

/**
 * How many bytes of encoded completion one page may hold in flight at once.
 *
 * Reusing the serialized string removes the repeated `JSON.stringify`, but it does NOT remove
 * the per-command cost: ioredis encodes and buffers the argument separately for each concurrent
 * command, so `deliveryConcurrency` copies of the completion are resident at the peak. At the
 * 512 KiB inline ceiling and the concurrency ceiling of 100 that is ~51 MB.
 *
 * Measured on a dev Redis, 1,000 deliveries of a 512 KiB completion:
 *
 *   concurrency 100  ->  worst event-loop delay 19.8ms, heap 100MB, total 3820ms
 *   concurrency  16  ->  worst event-loop delay  4.7ms, heap  42MB, total 3748ms
 *
 * So the budget costs nothing in throughput — Redis is the bottleneck, not the fan-out width —
 * and takes a quarter off the worst-case stall. 8 MiB is the knee: it leaves the shipped default
 * of 10 untouched for any completion up to ~819 KiB, which is every completion the ceiling
 * admits, so ordinary and reference-based work is unaffected.
 */
const MAX_IN_FLIGHT_DELIVERY_BYTES = 8 * 1024 * 1024;

/**
 * The delivery concurrency to actually use for one page, given how big its encoded completion
 * turned out to be.
 *
 * Configured concurrency is an upper bound, never raised — a small or `{ ref }` completion keeps
 * exactly the behaviour it had. Only a page whose completion is large enough to blow the byte
 * budget is narrowed, and never below 1, because a single delivery must always be able to
 * proceed however big its envelope is.
 */
export function effectiveDeliveryConcurrency(configured: number, encodedBytes: number): number {
  if (encodedBytes <= 0) {
    return configured;
  }
  const budgeted = Math.floor(MAX_IN_FLIGHT_DELIVERY_BYTES / encodedBytes);
  return Math.max(1, Math.min(configured, budgeted));
}

/** The resolved numeric options a worker runs on, after defaults are applied. */
export type FanoutWorkerLimits = {
  pageSize: number;
  leaseMs: number;
  pollIntervalMs: number;
  maxPagesPerVisit: number;
  dueBatchSize: number;
  deliveryConcurrency: number;
  hintGraceMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxFailures: number;
};

// Every bound is strictly positive, because zero silently disables something — a zero page
// budget visits nothing, a zero due batch sweeps nothing, a zero hint grace never rotates an
// abandoned hint out of the sweep's head — rather than failing where it can be diagnosed.
const POSITIVE: Array<keyof FanoutWorkerLimits> = [
  "pageSize",
  "leaseMs",
  "pollIntervalMs",
  "maxPagesPerVisit",
  "dueBatchSize",
  "deliveryConcurrency",
  "hintGraceMs",
  "baseDelayMs",
  "maxDelayMs",
  "maxFailures",
];

/**
 * Hard ceilings on the options that turn directly into work the event loop cannot yield out of.
 *
 * Positive-integer validation alone lets a misconfiguration through: `pageSize: 1_000_000` is a
 * positive integer, and it is also a million-element LRANGE reply, a million JSON.parse calls in
 * one synchronous burst, and a million queued deliveries. Each ceiling is 10x-20x its shipped
 * default, so a real workload has room while a fat-fingered value fails at construction.
 *
 * These are implementation-owned constants rather than options, for the same reason as the
 * completion ceiling: a bound a caller can raise is not a bound.
 */
const MAXIMUM: Partial<Record<keyof FanoutWorkerLimits, number>> = {
  // One LRANGE reply, one parse burst and one delivery fan-out. Default 100.
  pageSize: 1_000,
  // One ZRANGEBYSCORE reply per partition per tick, each element becoming a visit. Default 50.
  dueBatchSize: 1_000,
  // Claims per visit. Default 10.
  maxPagesPerVisit: 100,
  // In-flight deliveries against distinct run shards. Default 10.
  deliveryConcurrency: 100,
};

/**
 * The most watchers one visit may deliver to before it must yield the waitpoint back to the
 * index. `pageSize * maxPagesPerVisit` is the real bound on a visit, and two individually legal
 * values multiply: 1,000 x 100 would be 100,000 deliveries inside one `visit()` call. The
 * shipped defaults come to 1,000, so this leaves 10x headroom.
 */
const MAX_DELIVERIES_PER_VISIT = 10_000;

/**
 * Reject an unusable worker configuration at construction, naming the option.
 *
 * These options are exported, so a caller can hand over a value Redis will refuse
 * (`pageSize: 0` fails inside the claim script), one that quietly does nothing at all, or one
 * so large that a single visit monopolises the event loop. A fast, specific error beats any.
 */
export function assertFanoutWorkerLimits(limits: FanoutWorkerLimits): void {
  for (const option of POSITIVE) {
    const value = limits[option];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        `WaitpointFanoutWorker: ${option} must be a positive safe integer, got ${value}`
      );
    }

    const maximum = MAXIMUM[option];
    if (maximum !== undefined && value > maximum) {
      throw new Error(`WaitpointFanoutWorker: ${option} must be <= ${maximum}, got ${value}`);
    }
  }

  if (limits.maxDelayMs < limits.baseDelayMs) {
    throw new Error(
      `WaitpointFanoutWorker: maxDelayMs (${limits.maxDelayMs}) must be >= baseDelayMs (${limits.baseDelayMs})`
    );
  }

  // Deliberately NO `deliveryConcurrency <= pageSize` rule. It looks tidy and is wrong: a small
  // page is a legitimate configuration, `pMap` already clamps in-flight work to the array it is
  // given, and the absolute ceiling above is what actually bounds concurrency. Requiring the
  // relationship would reject `pageSize: 3` with the default concurrency for no safety gain.

  const perVisit = limits.pageSize * limits.maxPagesPerVisit;
  if (perVisit > MAX_DELIVERIES_PER_VISIT) {
    throw new Error(
      `WaitpointFanoutWorker: pageSize * maxPagesPerVisit (${perVisit}) must be <= ` +
        `${MAX_DELIVERIES_PER_VISIT}`
    );
  }
}
