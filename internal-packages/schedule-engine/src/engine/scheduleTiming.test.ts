import {
  MAX_ABSOLUTE_SCHEDULE_WINDOW_SECONDS,
  MAX_SCHEDULE_PHASE,
  MINIMUM_SCHEDULE_RANGE_MS,
  SCHEDULE_PHASE_DENOMINATOR,
  calculateEffectiveScheduleTime,
  calculateSchedulePhase,
  parseScheduleWindow,
  resolvePolicyMinimumMs,
  resolveScheduleWindow,
  resolveScheduleWindowMs,
  validateScheduleWindow,
} from "./scheduleTiming.js";

describe("resolveScheduleWindow", () => {
  it("prefers an explicit percentage over everything, including a captured default", () => {
    expect(
      resolveScheduleWindow({
        windowDurationSeconds: null,
        windowPercentage: 25,
        defaultWindowDurationSeconds: 3_600,
      })
    ).toEqual({ window: { type: "percentage", percentage: 25 }, source: "explicit" });
  });

  it("prefers an explicit duration over a captured default", () => {
    expect(
      resolveScheduleWindow({
        windowDurationSeconds: 900,
        windowPercentage: null,
        defaultWindowDurationSeconds: 3_600,
      })
    ).toEqual({ window: { type: "duration", durationSeconds: 900 }, source: "explicit" });
  });

  it("treats an explicit 0m as an explicit window that disables the default", () => {
    expect(
      resolveScheduleWindow({
        windowDurationSeconds: 0,
        windowPercentage: null,
        defaultWindowDurationSeconds: 3_600,
      })
    ).toEqual({ window: { type: "duration", durationSeconds: 0 }, source: "explicit" });
  });

  it("falls back to the captured default when nothing is explicit", () => {
    expect(
      resolveScheduleWindow({
        windowDurationSeconds: null,
        windowPercentage: null,
        defaultWindowDurationSeconds: 3_600,
      })
    ).toEqual({ window: { type: "duration", durationSeconds: 3_600 }, source: "schedule_default" });
  });

  it("resolves to no window for a grandfathered row with no default", () => {
    expect(
      resolveScheduleWindow({
        windowDurationSeconds: null,
        windowPercentage: null,
        defaultWindowDurationSeconds: null,
      })
    ).toEqual({ window: undefined, source: undefined });

    // An omitted default field behaves the same as null.
    expect(resolveScheduleWindow({ windowDurationSeconds: null, windowPercentage: null })).toEqual({
      window: undefined,
      source: undefined,
    });
  });
});

describe("parseScheduleWindow", () => {
  it.each([
    ["30m", { type: "duration", durationSeconds: 1_800 }],
    ["2h", { type: "duration", durationSeconds: 7_200 }],
    ["24h", { type: "duration", durationSeconds: 86_400 }],
    ["0m", { type: "duration", durationSeconds: 0 }],
    ["0h", { type: "duration", durationSeconds: 0 }],
    ["0%", { type: "percentage", percentage: 0 }],
    ["12%", { type: "percentage", percentage: 12 }],
    ["100%", { type: "percentage", percentage: 100 }],
  ] as const)("normalizes %s", (input, expected) => {
    expect(parseScheduleWindow(input)).toEqual(expected);
  });

  it.each([
    "",
    "00m",
    "01m",
    "1.5h",
    "0d",
    "1d",
    "25h",
    "1441m",
    "30s",
    "0.01%",
    "1.0%",
    "12.3%",
    "100.01%",
    "101%",
    "1.234%",
    "1e2%",
    " 30m",
    "30m ",
  ])("rejects %j", (input) => {
    expect(() => parseScheduleWindow(input)).toThrow();
  });

  it("rejects normalized durations over 24 hours", () => {
    expect(() =>
      validateScheduleWindow({
        type: "duration",
        durationSeconds: MAX_ABSOLUTE_SCHEDULE_WINDOW_SECONDS + 1,
      })
    ).toThrow("up to 24 hours");
  });
});

describe("schedule window validation", () => {
  it.each([0, 100])("allows %s percent", (percentage) => {
    expect(() => validateScheduleWindow({ type: "percentage", percentage })).not.toThrow();
  });

  it("allows a zero-duration window", () => {
    expect(() => validateScheduleWindow({ type: "duration", durationSeconds: 0 })).not.toThrow();
  });

  it.each([
    { type: "duration", durationSeconds: -1 },
    { type: "duration", durationSeconds: 1.5 },
    { type: "percentage", percentage: -100 },
    { type: "percentage", percentage: 101 },
    { type: "percentage", percentage: 1.5 },
  ] as const)("rejects an invalid normalized window: %o", (window) => {
    expect(() => validateScheduleWindow(window)).toThrow();
  });
});

describe("resolveScheduleWindowMs", () => {
  it("returns zero when no window was configured", () => {
    expect(resolveScheduleWindowMs(undefined, 5 * 60_000)).toBe(0);
  });

  it("resolves percentage windows using integer arithmetic", () => {
    expect(resolveScheduleWindowMs({ type: "percentage", percentage: 33 }, 5 * 60_000)).toBe(
      99_000
    );
  });
});

describe("calculateEffectiveScheduleTime", () => {
  const nominalAt = new Date("2026-08-10T10:00:00.000Z");

  it("uses the 60-second baseline when no window was configured", () => {
    const timing = calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt: new Date("2026-08-10T10:05:00.000Z"),
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
    });

    expect(timing).toEqual({
      nominalAt,
      nextNominalAt: new Date("2026-08-10T10:05:00.000Z"),
      effectiveAt: new Date("2026-08-10T10:00:30.000Z"),
      intervalMs: 300_000,
      windowMs: 0,
      effectiveRangeMs: MINIMUM_SCHEDULE_RANGE_MS,
      offsetMs: 30_000,
      windowWasCappedToInterval: false,
    });
  });

  it.each([
    [0, 0],
    [10, 30_000],
  ])("uses the 60-second baseline when %s percent resolves to %sms", (percentage, windowMs) => {
    const timing = calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt: new Date("2026-08-10T10:05:00.000Z"),
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
      window: { type: "percentage", percentage },
    });

    expect(timing.windowMs).toBe(windowMs);
    expect(timing.effectiveRangeMs).toBe(60_000);
    expect(timing.offsetMs).toBe(30_000);
  });

  it("uses 30% of a five-minute interval", () => {
    const timing = calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt: new Date("2026-08-10T10:05:00.000Z"),
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
      window: { type: "percentage", percentage: 30 },
    });

    expect(timing.windowMs).toBe(90_000);
    expect(timing.effectiveRangeMs).toBe(90_000);
    expect(timing.offsetMs).toBe(45_000);
    expect(timing.effectiveAt).toEqual(new Date("2026-08-10T10:00:45.000Z"));
  });

  it("keeps a 100% window half-open at the maximum phase", () => {
    const nextNominalAt = new Date("2026-08-10T10:05:00.000Z");
    const timing = calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt,
      schedulePhase: MAX_SCHEDULE_PHASE,
      window: { type: "percentage", percentage: 100 },
    });

    expect(timing.effectiveRangeMs).toBe(300_000);
    expect(timing.offsetMs).toBe(299_999);
    expect(timing.effectiveAt).toEqual(new Date(nextNominalAt.getTime() - 1));
    expect(timing.effectiveAt.getTime()).toBeLessThan(nextNominalAt.getTime());
  });

  it("preserves cadence for consecutive occurrences with a stable 100% phase", () => {
    const phase = 1_610_612_735;
    const first = calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt: new Date("2026-08-10T10:05:00.000Z"),
      schedulePhase: phase,
      window: { type: "percentage", percentage: 100 },
    });
    const second = calculateEffectiveScheduleTime({
      nominalAt: new Date("2026-08-10T10:05:00.000Z"),
      nextNominalAt: new Date("2026-08-10T10:10:00.000Z"),
      schedulePhase: phase,
      window: { type: "percentage", percentage: 100 },
    });

    expect(second.effectiveAt.getTime() - first.effectiveAt.getTime()).toBe(5 * 60_000);
  });

  it("allows an effective time to cross a calendar boundary", () => {
    const timing = calculateEffectiveScheduleTime({
      nominalAt: new Date("2026-12-31T23:00:00.000Z"),
      nextNominalAt: new Date("2027-01-01T23:00:00.000Z"),
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
      window: { type: "duration", durationSeconds: 3 * 60 * 60 },
    });

    expect(timing.effectiveAt).toEqual(new Date("2027-01-01T00:30:00.000Z"));
  });

  it("caps an absolute window at the interval to the next nominal tick", () => {
    const timing = calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt: new Date("2026-08-10T10:05:00.000Z"),
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
      window: { type: "duration", durationSeconds: 30 * 60 },
    });

    expect(timing.windowMs).toBe(1_800_000);
    expect(timing.effectiveRangeMs).toBe(300_000);
    expect(timing.windowWasCappedToInterval).toBe(true);
    expect(timing.effectiveAt).toEqual(new Date("2026-08-10T10:02:30.000Z"));
  });

  it.each([-1, 1.5, SCHEDULE_PHASE_DENOMINATOR])(
    "rejects invalid schedule phase %s",
    (schedulePhase) => {
      expect(() =>
        calculateEffectiveScheduleTime({
          nominalAt,
          nextNominalAt: new Date("2026-08-10T10:05:00.000Z"),
          schedulePhase,
        })
      ).toThrow("Schedule phase must be an integer");
    }
  );

  it("rejects a non-positive nominal interval", () => {
    expect(() =>
      calculateEffectiveScheduleTime({
        nominalAt,
        nextNominalAt: nominalAt,
        schedulePhase: 0,
      })
    ).toThrow("Nominal schedule interval must be a positive integer");
  });
});

describe("resolvePolicyMinimumMs", () => {
  it("treats null/undefined as no floor", () => {
    expect(resolvePolicyMinimumMs(null)).toBe(0);
    expect(resolvePolicyMinimumMs(undefined)).toBe(0);
    expect(resolvePolicyMinimumMs(0)).toBe(0);
  });

  it("converts seconds to milliseconds", () => {
    expect(resolvePolicyMinimumMs(3_600)).toBe(3_600_000);
  });

  it.each([-1, 1.5, Number.NaN])("rejects invalid value %s", (value) => {
    expect(() => resolvePolicyMinimumMs(value)).toThrow("non-negative integer");
  });
});

describe("calculateEffectiveScheduleTime with a policy minimum", () => {
  const nominalAt = new Date("2026-08-10T10:00:00.000Z");
  // Hourly cron: nominal ticks are 60 minutes apart.
  const nextNominalAt = new Date("2026-08-10T11:00:00.000Z");

  it("raises the requested range to the 60-minute policy floor when no window is set", () => {
    const timing = calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt,
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
      minimumWindowDurationSeconds: 3_600,
    });

    expect(timing.windowMs).toBe(0);
    expect(timing.effectiveRangeMs).toBe(3_600_000);
    expect(timing.windowWasCappedToInterval).toBe(false);
    // Half phase spreads to the midpoint of the hour.
    expect(timing.effectiveAt).toEqual(new Date("2026-08-10T10:30:00.000Z"));
  });

  it("lifts a smaller configured window up to the policy floor", () => {
    const timing = calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt,
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
      window: { type: "duration", durationSeconds: 5 * 60 },
      minimumWindowDurationSeconds: 3_600,
    });

    expect(timing.windowMs).toBe(300_000);
    expect(timing.effectiveRangeMs).toBe(3_600_000);
  });

  it("lets a larger configured window win over the policy floor", () => {
    const timing = calculateEffectiveScheduleTime({
      nominalAt,
      // Two-hour interval so a 200m window is not capped by the next tick.
      nextNominalAt: new Date("2026-08-10T12:00:00.000Z"),
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
      window: { type: "duration", durationSeconds: 200 * 60 },
      minimumWindowDurationSeconds: 3_600,
    });

    expect(timing.windowMs).toBe(200 * 60_000);
    // Capped to the 2-hour interval, still above the policy floor.
    expect(timing.effectiveRangeMs).toBe(2 * 60 * 60_000);
    expect(timing.windowWasCappedToInterval).toBe(true);
  });

  it("caps the policy floor at the next nominal interval", () => {
    // Hypothetical: a 60m floor on a 5-minute interval would be capped to 5 minutes. (Enrolled
    // schedules reject sub-hourly crons before persistence; this is the engine's safety net.)
    const timing = calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt: new Date("2026-08-10T10:05:00.000Z"),
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
      minimumWindowDurationSeconds: 3_600,
    });

    expect(timing.effectiveRangeMs).toBe(300_000);
    expect(timing.windowWasCappedToInterval).toBe(true);
  });

  it("is a no-op when the floor is null", () => {
    const withNull = calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt,
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
      minimumWindowDurationSeconds: null,
    });
    const without = calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt,
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
    });

    expect(withNull).toEqual(without);
  });
});

describe("calculateSchedulePhase", () => {
  const input = {
    secret: "test-secret",
    environmentId: "env_789",
    deduplicationKey: "daily-report",
  };

  it("uses the agreed domain-separated HMAC input", () => {
    expect(calculateSchedulePhase(input)).toBe(43_063_717);
  });

  it("is stable for the same logical schedule instance", () => {
    expect(calculateSchedulePhase(input)).toBe(calculateSchedulePhase(input));
  });

  it.each(["environmentId", "deduplicationKey"] as const)("changes when %s changes", (field) => {
    expect(calculateSchedulePhase({ ...input, [field]: `${input[field]}_other` })).not.toBe(
      calculateSchedulePhase(input)
    );
  });

  it("changes when the secret changes", () => {
    expect(calculateSchedulePhase({ ...input, secret: "other-secret" })).not.toBe(
      calculateSchedulePhase(input)
    );
  });

  it("always returns a non-negative signed 31-bit integer", () => {
    for (let index = 0; index < 1_000; index++) {
      const phase = calculateSchedulePhase({ ...input, deduplicationKey: `schedule-${index}` });
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(SCHEDULE_PHASE_DENOMINATOR);
    }
  });

  it("rejects an empty secret", () => {
    expect(() => calculateSchedulePhase({ ...input, secret: "" })).toThrow(
      "secret must not be empty"
    );
  });
});
