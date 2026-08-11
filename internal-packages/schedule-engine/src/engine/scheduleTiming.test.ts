import {
  MAX_ABSOLUTE_SCHEDULE_WINDOW_SECONDS,
  MAX_SCHEDULE_PHASE,
  MINIMUM_SCHEDULE_RANGE_MS,
  SCHEDULE_PHASE_DENOMINATOR,
  calculateEffectiveScheduleTime,
  calculateSchedulePhase,
  parseScheduleWindow,
  resolveScheduleWindowMs,
  validateScheduleWindow,
} from "./scheduleTiming.js";

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
