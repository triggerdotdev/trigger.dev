import { describe, expect, it } from "vitest";
import type { TaskRunStatus } from "@trigger.dev/database";
import { shouldIdempotencyKeyBeCleared } from "~/v3/taskStatus";

/**
 * Tests the shouldIdempotencyKeyBeCleared function which is now used by both the
 * single-trigger path (IdempotencyKeyConcern.handleExistingRun) and the batch-trigger
 * path (BatchTriggerV3Service.#prepareRunData).
 *
 * Before the fix, the batch path did not call this function at all — it only
 * checked time-based expiration, silently returning dead runs as cached hits.
 *
 * These tests validate:
 * 1. All failure statuses that should trigger re-triggering
 * 2. All non-failure statuses that should preserve the cached run
 * 3. Edge cases around status classification
 */
describe("shouldIdempotencyKeyBeCleared — batch trigger parity", () => {
  // ─── Statuses that MUST clear the idempotency key ──────────────────
  // These are the statuses where the single-trigger path (and now the
  // batch-trigger path) clears the key and creates a fresh run.

  const clearableStatuses: TaskRunStatus[] = [
    "CRASHED",
    "SYSTEM_FAILURE",
    "TIMED_OUT",
    "EXPIRED",
    "COMPLETED_WITH_ERRORS",
    "INTERRUPTED",
  ];

  it.each(clearableStatuses)(
    "returns true for %s — dead runs must not be returned as cached hits in batch triggers",
    (status) => {
      expect(shouldIdempotencyKeyBeCleared(status)).toBe(true);
    }
  );

  // ─── Statuses that MUST NOT clear the idempotency key ──────────────
  // These runs are either still in progress, successfully completed,
  // or canceled by the user. Returning them as cached is correct.

  const nonClearableStatuses: TaskRunStatus[] = [
    "PENDING",
    "PENDING_VERSION",
    "WAITING_FOR_DEPLOY",
    "DEQUEUED",
    "EXECUTING",
    "WAITING_TO_RESUME",
    "RETRYING_AFTER_FAILURE",
    "PAUSED",
    "DELAYED",
    "COMPLETED_SUCCESSFULLY",
    "CANCELED",
  ];

  it.each(nonClearableStatuses)(
    "returns false for %s — these runs should be returned as cached hits",
    (status) => {
      expect(shouldIdempotencyKeyBeCleared(status)).toBe(false);
    }
  );

  // ─── Specific edge cases ───────────────────────────────────────────

  it("COMPLETED_SUCCESSFULLY should NOT be cleared — it is a valid cached result", () => {
    expect(shouldIdempotencyKeyBeCleared("COMPLETED_SUCCESSFULLY")).toBe(false);
  });

  it("CANCELED should NOT be cleared — user-initiated cancellation is intentional", () => {
    expect(shouldIdempotencyKeyBeCleared("CANCELED")).toBe(false);
  });

  it("EXPIRED should be cleared — expired runs should be re-triggerable via batch", () => {
    expect(shouldIdempotencyKeyBeCleared("EXPIRED")).toBe(true);
  });

  it("RETRYING_AFTER_FAILURE should NOT be cleared — the run is still in progress", () => {
    expect(shouldIdempotencyKeyBeCleared("RETRYING_AFTER_FAILURE")).toBe(false);
  });
});
