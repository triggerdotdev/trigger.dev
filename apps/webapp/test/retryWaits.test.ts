import { describe, expect, it } from "vitest";
import { retryWaits } from "~/components/tasks/retryWaits";

const backoff = { factor: 2, min: 1_000, max: 60_000, limit: 5 };

describe("retryWaits", () => {
  it("gives the wait before each retry, capped at the maximum", () => {
    expect(retryWaits({ ...backoff, maxAttempts: 4 })).toEqual({
      shown: [1_000, 2_000, 4_000],
      more: 0,
    });
    expect(retryWaits({ ...backoff, maxAttempts: 4, max: 3_000 }).shown).toEqual([
      1_000, 2_000, 3_000,
    ]);
  });

  it("works out only the waits that are shown and counts the rest", () => {
    expect(retryWaits({ ...backoff, maxAttempts: 10 })).toEqual({
      shown: [1_000, 2_000, 4_000, 8_000, 16_000],
      more: 4,
    });
  });

  // Catches: the task page building an array as long as maxAttempts, which a task can set to
  // any integer (a RangeError above 2^32, and millions of entries well before that).
  it("handles a maxAttempts far beyond what an array can hold", () => {
    const { shown, more } = retryWaits({ ...backoff, maxAttempts: 2 ** 40 });
    expect(shown).toHaveLength(5);
    expect(more).toBe(2 ** 40 - 6);
  });

  it("has no waits for a single attempt", () => {
    expect(retryWaits({ ...backoff, maxAttempts: 1 })).toEqual({ shown: [], more: 0 });
  });
});
