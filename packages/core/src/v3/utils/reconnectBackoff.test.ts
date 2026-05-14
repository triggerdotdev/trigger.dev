import { afterEach, describe, expect, it, vi } from "vitest";

import { RECONNECT_BACKOFF_MAX_MS, computeReconnectDelayMs } from "./reconnectBackoff.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeReconnectDelayMs", () => {
  // Hold Math.random steady so we can assert on the deterministic base. The
  // jitter is added separately in the "jitter" test below.
  function withFixedRandom(value: number, fn: () => void) {
    const spy = vi.spyOn(Math, "random").mockReturnValue(value);
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
  }

  it("base case — attempt 0 lands in [1000, 2000)", () => {
    withFixedRandom(0, () => {
      expect(computeReconnectDelayMs(0)).toBe(1000);
    });
    withFixedRandom(0.999, () => {
      expect(computeReconnectDelayMs(0)).toBeGreaterThanOrEqual(1000);
      expect(computeReconnectDelayMs(0)).toBeLessThan(2000);
    });
  });

  it("doubles per attempt up to the 30s cap", () => {
    withFixedRandom(0, () => {
      // 1s, 2s, 4s, 8s, 16s, then capped at 30s
      expect(computeReconnectDelayMs(0)).toBe(1_000);
      expect(computeReconnectDelayMs(1)).toBe(2_000);
      expect(computeReconnectDelayMs(2)).toBe(4_000);
      expect(computeReconnectDelayMs(3)).toBe(8_000);
      expect(computeReconnectDelayMs(4)).toBe(16_000);
      // 32s would exceed the cap — should clamp to 30s.
      expect(computeReconnectDelayMs(5)).toBe(RECONNECT_BACKOFF_MAX_MS);
      // High attempt counts stay capped — protects against integer
      // overflow on 2 ** N for large N.
      expect(computeReconnectDelayMs(50)).toBe(RECONNECT_BACKOFF_MAX_MS);
      expect(computeReconnectDelayMs(1_000)).toBe(RECONNECT_BACKOFF_MAX_MS);
    });
  });

  it("never exceeds RECONNECT_BACKOFF_MAX_MS + 1000ms (cap + jitter ceiling)", () => {
    withFixedRandom(0.999, () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        expect(computeReconnectDelayMs(attempt)).toBeLessThan(
          RECONNECT_BACKOFF_MAX_MS + 1000
        );
      }
    });
  });

  it("adds 0–1000ms of jitter on top of the base", () => {
    // Compare same attempt with random=0 vs random=0.5 — the difference is
    // exactly the jitter.
    withFixedRandom(0, () => {
      expect(computeReconnectDelayMs(2)).toBe(4_000);
    });
    withFixedRandom(0.5, () => {
      expect(computeReconnectDelayMs(2)).toBe(4_500);
    });
    withFixedRandom(0.999, () => {
      const v = computeReconnectDelayMs(2);
      expect(v).toBeGreaterThan(4_000);
      expect(v).toBeLessThan(5_000);
    });
  });

  it("clamps negative / non-integer attempts to 0 (no NaN, no negative delay)", () => {
    withFixedRandom(0, () => {
      expect(computeReconnectDelayMs(-1)).toBe(1_000);
      expect(computeReconnectDelayMs(-100)).toBe(1_000);
      expect(computeReconnectDelayMs(0.7)).toBe(1_000); // floored to 0
      expect(computeReconnectDelayMs(2.9)).toBe(4_000); // floored to 2
    });
  });
});
