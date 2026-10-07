import { describe, expect, it } from "vitest";
import {
  LIVE_TAIL_OVERLAP_MS,
  LIVE_TAIL_SWEEP_INTERVAL_MS,
  LIVE_TAIL_SWEEP_OVERLAP_MS,
  resolveLiveTailEnabled,
  tailMinIntervalMs,
  tailOverlapMs,
} from "~/hooks/liveTail";

describe("resolveLiveTailEnabled (incremental live tail feature flag)", () => {
  it("tails when the flag resolved on and a progressive backend is present", () => {
    expect(resolveLiveTailEnabled({ liveTailEnabled: true })).toBe(true);
  });

  it("uses the legacy path when the flag resolved off", () => {
    expect(resolveLiveTailEnabled({ liveTailEnabled: false })).toBe(false);
  });

  it("uses the legacy path when the flag is absent from the progressive block", () => {
    expect(resolveLiveTailEnabled({})).toBe(false);
  });

  it("uses the legacy path when there is no progressive backend to tail", () => {
    // No progressive block means the flag can't be on.
    expect(resolveLiveTailEnabled(null)).toBe(false);
    expect(resolveLiveTailEnabled(undefined)).toBe(false);
  });
});

describe("tailMinIntervalMs (size-aware cadence governor)", () => {
  it("does not throttle small traces (fully responsive)", () => {
    expect(tailMinIntervalMs(0)).toBe(0);
    expect(tailMinIntervalMs(4_999)).toBe(0);
  });

  it("throttles mid-size traces", () => {
    expect(tailMinIntervalMs(5_000)).toBe(2_000);
    expect(tailMinIntervalMs(49_999)).toBe(2_000);
  });

  it("throttles large traces more", () => {
    expect(tailMinIntervalMs(50_000)).toBe(5_000);
    expect(tailMinIntervalMs(99_999)).toBe(5_000);
  });

  it("throttles very large traces the most", () => {
    expect(tailMinIntervalMs(100_000)).toBe(15_000);
    expect(tailMinIntervalMs(250_000)).toBe(15_000);
  });
});

describe("tailOverlapMs", () => {
  it("uses the narrow window between sweeps and the full window once one is due", () => {
    expect(tailOverlapMs(100_000, 100_000 - 1_000)).toBe(LIVE_TAIL_OVERLAP_MS);
    expect(tailOverlapMs(100_000, 100_000 - LIVE_TAIL_SWEEP_INTERVAL_MS)).toBe(
      LIVE_TAIL_SWEEP_OVERLAP_MS
    );
    expect(tailOverlapMs(100_000, 0)).toBe(LIVE_TAIL_SWEEP_OVERLAP_MS);
  });
});
