import { describe, expect, it } from "vitest";
import { isQueueAtCapacity, isQueueDegraded, OLDEST_WAIT_WARNING_MS } from "./queue-thresholds";

describe("isQueueAtCapacity", () => {
  it("is false for a zero limit with a backlog", () => {
    expect(isQueueAtCapacity({ running: 0, queued: 12, limit: 0 })).toBe(false);
    expect(isQueueAtCapacity({ running: 3, queued: 12, limit: 0 })).toBe(false);
  });

  it("is false when no limit is known", () => {
    expect(isQueueAtCapacity({ running: 5, queued: 12, limit: null })).toBe(false);
    expect(isQueueAtCapacity({ running: 5, queued: 12, limit: undefined })).toBe(false);
  });

  it("is true when a positive limit is full and work is waiting", () => {
    expect(isQueueAtCapacity({ running: 10, queued: 4, limit: 10 })).toBe(true);
    expect(isQueueAtCapacity({ running: 11, queued: 1, limit: 10 })).toBe(true);
  });

  it("is false when the limit is full but nothing is waiting", () => {
    expect(isQueueAtCapacity({ running: 10, queued: 0, limit: 10 })).toBe(false);
  });
});

describe("isQueueDegraded", () => {
  const base = { paused: false, oldestWaitMs: null };

  it("does not degrade a zero-limit queue with a backlog", () => {
    expect(isQueueDegraded({ ...base, running: 0, queued: 12, limit: 0 })).toBe(false);
  });

  it("degrades a saturated queue", () => {
    expect(isQueueDegraded({ ...base, running: 10, queued: 4, limit: 10 })).toBe(true);
  });

  it("degrades on head-of-line wait regardless of the limit", () => {
    expect(
      isQueueDegraded({
        paused: false,
        running: 0,
        queued: 12,
        limit: 0,
        oldestWaitMs: OLDEST_WAIT_WARNING_MS,
      })
    ).toBe(true);
  });

  it("never degrades a paused queue", () => {
    expect(
      isQueueDegraded({
        paused: true,
        running: 10,
        queued: 4,
        limit: 10,
        oldestWaitMs: OLDEST_WAIT_WARNING_MS * 10,
      })
    ).toBe(false);
  });
});
