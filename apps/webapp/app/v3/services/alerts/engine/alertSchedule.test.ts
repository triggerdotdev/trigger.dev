import { describe, expect, it } from "vitest";
import {
  LANE_RETRY_MAX_MS,
  LANE_RETRY_MIN_MS,
  alertPhaseOffsetMs,
  capCadenceSec,
  fnv1a32,
  laneRetryAt,
  nextEvaluationAt,
} from "./alertSchedule";

const cadenceMs = 300_000;
const ids = ["alert_a", "alert_b", "alert_c", "alert_42", "x"];
const phase = (id: string) => alertPhaseOffsetMs(id, 30);
const next = (id: string, now: Date, cadenceSec = 300) =>
  nextEvaluationAt({ previousDueAt: new Date(0), cadenceSec, now, alertId: id, windowSec: 30 });

describe("nextEvaluationAt", () => {
  it("returns now when there is no previous due time", () => {
    const now = new Date("2026-01-01T00:00:05.000Z");
    expect(
      nextEvaluationAt({ previousDueAt: null, cadenceSec: 300, now, alertId: "a", windowSec: 30 })
    ).toEqual(now);
  });

  it("chained: feeding the stored slot back never drifts the phase", () => {
    for (const id of ids) {
      const next1 = next(id, new Date("2026-01-01T00:00:07.000Z"));
      const next2 = nextEvaluationAt({
        previousDueAt: next1,
        cadenceSec: 300,
        now: new Date(next1.getTime() + 20_000),
        alertId: id,
        windowSec: 30,
      });
      expect(next2.getTime() - next1.getTime()).toBe(cadenceMs);
    }
  });

  it("lands on the epoch grid and in the future", () => {
    for (const id of ids) {
      for (const cadenceSec of [60, 300, 900]) {
        const now = new Date(1_767_225_600_000 + 12_345);
        const n = next(id, now, cadenceSec);
        expect((n.getTime() - phase(id)) % (cadenceSec * 1000)).toBe(0);
        expect(n.getTime()).toBeGreaterThan(now.getTime());
        expect(n.getTime() - now.getTime()).toBeLessThanOrEqual(cadenceSec * 1000);
      }
    }
  });

  it("skips missed slots and returns exactly one future slot", () => {
    const id = "alert_a";
    const slot = 1_767_225_600_000 - (1_767_225_600_000 % cadenceMs) + phase(id);
    const now = new Date(slot + 5 * cadenceMs + 1000);
    expect(next(id, now).getTime()).toBe(slot + 6 * cadenceMs);
  });

  it("boundary: now equal to a grid slot moves to the next slot (strict >)", () => {
    const id = "alert_a";
    const slot = 1_767_225_600_000 - (1_767_225_600_000 % cadenceMs) + phase(id);
    expect(next(id, new Date(slot)).getTime()).toBe(slot + cadenceMs);
  });
});

describe("alertPhaseOffsetMs", () => {
  it("matches the FNV-1a 32-bit known vector", () => {
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("")).toBe(0x811c9dc5);
  });

  it("is deterministic", () => {
    expect(alertPhaseOffsetMs("x", 30)).toBe(alertPhaseOffsetMs("x", 30));
  });

  it("stays within the window and varies across ids", () => {
    const values = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = alertPhaseOffsetMs(`alert_${i}`, 30);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(30_000);
      values.add(v);
    }
    expect(values.size).toBeGreaterThan(1);
  });
});

describe("laneRetryAt", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("adds 30s at random=0", () => {
    expect(laneRetryAt({ now, random: () => 0 }).getTime()).toBe(now.getTime() + LANE_RETRY_MIN_MS);
  });

  it("stays below 60s as random approaches 1", () => {
    const t = laneRetryAt({ now, random: () => 1 - 1e-4 }).getTime();
    expect(t).toBeLessThan(now.getTime() + LANE_RETRY_MAX_MS);
    expect(t).toBeGreaterThan(now.getTime() + LANE_RETRY_MIN_MS);
  });

  it("uses random and never equals now + cadence", () => {
    expect(laneRetryAt({ now, random: () => 0.5 }).getTime()).toBe(now.getTime() + 45_000);
    for (const cadence of [60, 300, 600]) {
      for (const r of [0, 0.25, 0.5, 0.99]) {
        expect(laneRetryAt({ now, random: () => r }).getTime()).not.toBe(
          now.getTime() + cadence * 1000
        );
      }
    }
  });
});

describe("alertPhaseOffsetMs window guard", () => {
  it("returns 0 for a non-positive window and keeps slots valid", () => {
    expect(alertPhaseOffsetMs("alert_a", 0)).toBe(0);
    const slot = nextEvaluationAt({
      previousDueAt: new Date(0),
      cadenceSec: 300,
      now: new Date("2026-01-01T00:00:07.000Z"),
      alertId: "alert_a",
      windowSec: 0,
    });
    expect(Number.isNaN(slot.getTime())).toBe(false);
  });
});

describe("capCadenceSec", () => {
  it("caps the cadence when the cap is lower", () => {
    expect(capCadenceSec(600, 30)).toBe(30);
    const now = new Date("2026-01-01T00:00:07.000Z");
    const due = nextEvaluationAt({
      previousDueAt: new Date(0),
      cadenceSec: capCadenceSec(600, 30),
      now,
      alertId: "alert_a",
      windowSec: 30,
    });
    expect(due.getTime() - now.getTime()).toBeLessThanOrEqual(30_000);
  });

  it("leaves the cadence unchanged when unset or higher", () => {
    expect(capCadenceSec(600, undefined)).toBe(600);
    expect(capCadenceSec(600, 900)).toBe(600);
  });
});
