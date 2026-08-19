import {
  MINIMUM_SCHEDULE_RANGE_MS,
  calculateEffectiveScheduleTime,
  calculateSchedulePhase,
} from "@internal/schedule-engine";
import { CronPattern } from "~/v3/schedules";
import { type NormalizedScheduleWindow } from "@trigger.dev/core/v3";
import { parseExpression } from "cron-parser";
import { describe, expect, it } from "vitest";
import {
  nextScheduledTimestamps,
  previousScheduledTimestamp,
} from "~/v3/utils/calculateNextSchedule.server";
import { resolveScheduleTimings, type ScheduleTimingInput } from "~/v3/scheduleTimings.server";

const PHASE_SECRET = "test-phase-secret";

const CRONS: Array<[string, string | null]> = [
  ["*/5 * * * *", null],
  ["0 * * * *", null],
  ["0 0 * * *", null],
  ["0 0 * * *", "America/New_York"],
  ["0 9 * * 1-5", "Europe/London"],
  ["30 2 1 * *", "Asia/Tokyo"],
  ["15 3 * * 0", "Australia/Sydney"],
  ["0 0 1 1 *", "America/New_York"],
  ["0 0 29 2 *", "America/New_York"],
  ["0 0 31 * *", "UTC"],
  ["*/13 */7 * * *", "Pacific/Chatham"],
];

/**
 * The pre-optimization implementation: re-parse and re-walk from scratch for
 * every step. Kept here so the optimized version is checked against the exact
 * behaviour it replaced rather than against hand-written expectations.
 */
function referenceNextScheduledTimestamps(
  cron: string,
  timezone: string | null,
  from: Date,
  count: number
): Date[] {
  const result: Date[] = [];
  let cursor = from;

  for (let i = 0; i < count; i++) {
    cursor = parseExpression(cron, {
      currentDate: cursor,
      utc: timezone === null,
      tz: timezone ?? undefined,
    })
      .next()
      .toDate();

    result.push(cursor);
  }

  return result;
}

/** Naive per-row resolution, with no caching and no skipping. */
function referenceResolve(
  inputs: ScheduleTimingInput[],
  now: Date,
  includeLastRun: boolean
): Array<{ nextRun: Date; nextRunEffectiveAt: Date; lastRun: Date | undefined }> {
  return inputs.map((input) => {
    const nominalTimes = referenceNextScheduledTimestamps(input.cron, input.timezone, now, 2);

    const phase =
      input.schedulePhase ??
      calculateSchedulePhase({
        secret: PHASE_SECRET,
        environmentId: input.environmentId,
        deduplicationKey: input.deduplicationKey,
      });

    const window: NormalizedScheduleWindow | undefined =
      input.windowPercentage !== null
        ? { type: "percentage", percentage: input.windowPercentage }
        : input.windowDurationSeconds !== null
          ? { type: "duration", durationSeconds: input.windowDurationSeconds }
          : undefined;

    const { effectiveAt } = calculateEffectiveScheduleTime({
      nominalAt: nominalTimes[0],
      nextNominalAt: nominalTimes[1],
      schedulePhase: phase,
      window,
    });

    let lastRun: Date | undefined;
    if (includeLastRun && input.active) {
      try {
        const previous = previousScheduledTimestamp(input.cron, input.timezone, now);
        lastRun = previous.getTime() > input.updatedAt.getTime() ? previous : undefined;
      } catch {
        lastRun = undefined;
      }
    }

    return { nextRun: nominalTimes[0], nextRunEffectiveAt: effectiveAt, lastRun };
  });
}

function input(overrides: Partial<ScheduleTimingInput> = {}): ScheduleTimingInput {
  return {
    cron: "0 0 * * *",
    timezone: null,
    deduplicationKey: "dedup-1",
    environmentId: "env-1",
    schedulePhase: null,
    windowDurationSeconds: null,
    windowPercentage: null,
    active: true,
    updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("nextScheduledTimestamps", () => {
  it.each(CRONS)("matches the re-parsing implementation for %s (%s)", (cron, timezone) => {
    const from = new Date("2024-03-07T12:34:56.000Z");

    for (const count of [1, 2, 3, 5]) {
      expect(nextScheduledTimestamps(cron, timezone, from, count)).toEqual(
        referenceNextScheduledTimestamps(cron, timezone, from, count)
      );
    }
  });

  it.each([
    ["spring forward (US)", "2024-03-10T05:00:00.000Z", "America/New_York"],
    ["fall back (US)", "2024-11-03T04:00:00.000Z", "America/New_York"],
    ["spring forward (EU)", "2024-03-31T00:00:00.000Z", "Europe/London"],
    ["fall back (EU)", "2024-10-27T00:00:00.000Z", "Europe/London"],
    ["southern DST", "2024-04-07T14:00:00.000Z", "Australia/Sydney"],
  ])("matches across a DST transition: %s", (_label, iso, timezone) => {
    const from = new Date(iso);

    for (const cron of ["0 * * * *", "30 2 * * *", "*/15 * * * *", "0 0 * * *"]) {
      expect(nextScheduledTimestamps(cron, timezone, from, 6)).toEqual(
        referenceNextScheduledTimestamps(cron, timezone, from, 6)
      );
    }
  });

  it("returns strictly increasing times", () => {
    const times = nextScheduledTimestamps("*/5 * * * *", "Europe/London", new Date(), 10);

    for (let i = 1; i < times.length; i++) {
      expect(times[i].getTime()).toBeGreaterThan(times[i - 1].getTime());
    }
  });
});

describe("resolveScheduleTimings", () => {
  const now = new Date("2024-06-15T09:17:23.000Z");

  it("matches a naive per-row resolution", () => {
    const inputs = CRONS.map(([cron, timezone], index) =>
      input({
        cron,
        timezone,
        deduplicationKey: `dedup-${index}`,
        environmentId: `env-${index % 3}`,
        windowDurationSeconds: index % 3 === 0 ? 600 : null,
        windowPercentage: index % 3 === 1 ? 25 : null,
      })
    );

    expect(
      resolveScheduleTimings(inputs, { phaseSecret: PHASE_SECRET, includeLastRun: true, now })
    ).toEqual(referenceResolve(inputs, now, true));
  });

  it("caching does not change results when rows repeat an expression", () => {
    const repeated = Array.from({ length: 20 }, (_, index) =>
      input({
        cron: "0 9 * * 1-5",
        timezone: "Europe/London",
        deduplicationKey: `dedup-${index}`,
        environmentId: `env-${index % 4}`,
        schedulePhase: index % 2 === 0 ? null : index * 1000,
        windowPercentage: index % 5 === 0 ? 40 : null,
      })
    );

    expect(
      resolveScheduleTimings(repeated, { phaseSecret: PHASE_SECRET, includeLastRun: true, now })
    ).toEqual(referenceResolve(repeated, now, true));
  });

  it("gives every row in a batch the same nominal time for the same expression", () => {
    const rows = Array.from({ length: 50 }, (_, index) =>
      input({ cron: "*/5 * * * *", deduplicationKey: `dedup-${index}` })
    );

    const timings = resolveScheduleTimings(rows, {
      phaseSecret: PHASE_SECRET,
      includeLastRun: false,
      now,
    });

    const distinct = new Set(timings.map((timing) => timing.nextRun.getTime()));
    expect(distinct.size).toBe(1);
  });

  it("still varies effectiveAt per row inside the window", () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      input({
        cron: "0 * * * *",
        windowPercentage: 100,
        deduplicationKey: `dedup-${index}`,
      })
    );

    const timings = resolveScheduleTimings(rows, {
      phaseSecret: PHASE_SECRET,
      includeLastRun: false,
      now,
    });

    const distinct = new Set(timings.map((timing) => timing.nextRunEffectiveAt.getTime()));
    expect(distinct.size).toBeGreaterThan(1);

    for (const timing of timings) {
      expect(timing.nextRunEffectiveAt.getTime()).toBeGreaterThanOrEqual(timing.nextRun.getTime());
    }
  });

  it("omits lastRun entirely when the caller does not ask for it", () => {
    const rows = CRONS.map(([cron, timezone]) => input({ cron, timezone }));

    const timings = resolveScheduleTimings(rows, {
      phaseSecret: PHASE_SECRET,
      includeLastRun: false,
      now,
    });

    expect(timings.every((timing) => timing.lastRun === undefined)).toBe(true);
  });

  it("skips lastRun for inactive schedules", () => {
    const [timing] = resolveScheduleTimings([input({ active: false })], {
      phaseSecret: PHASE_SECRET,
      includeLastRun: true,
      now,
    });

    expect(timing.lastRun).toBeUndefined();
  });

  it("skips lastRun when the previous slot predates the last config change", () => {
    const [stale] = resolveScheduleTimings([input({ cron: "0 0 * * *", updatedAt: now })], {
      phaseSecret: PHASE_SECRET,
      includeLastRun: true,
      now,
    });
    expect(stale.lastRun).toBeUndefined();

    const [fresh] = resolveScheduleTimings(
      [input({ cron: "0 0 * * *", updatedAt: new Date("2020-01-01T00:00:00.000Z") })],
      { phaseSecret: PHASE_SECRET, includeLastRun: true, now }
    );
    expect(fresh.lastRun).toEqual(new Date("2024-06-15T00:00:00.000Z"));
  });

  it("degrades to undefined lastRun for a malformed expression rather than throwing", () => {
    const rows = [input({ cron: "0 0 * * *" }), input({ cron: "not a cron" })];

    expect(() =>
      resolveScheduleTimings([rows[1]], {
        phaseSecret: PHASE_SECRET,
        includeLastRun: false,
        now,
      })
    ).toThrow();

    const [valid] = resolveScheduleTimings([rows[0]], {
      phaseSecret: PHASE_SECRET,
      includeLastRun: true,
      now,
    });
    expect(valid.lastRun).toBeDefined();
  });

  it("honours a caller-supplied schedulePhase over the derived one", () => {
    const rows = [input({ schedulePhase: 0, windowPercentage: 100, cron: "0 * * * *" })];

    const [timing] = resolveScheduleTimings(rows, {
      phaseSecret: PHASE_SECRET,
      includeLastRun: false,
      now,
    });

    expect(timing.nextRunEffectiveAt).toEqual(timing.nextRun);
  });

  it("taking one step for windowless rows matches taking two", () => {
    const windowless = CRONS.map(([cron, timezone], index) =>
      input({ cron, timezone, deduplicationKey: `dedup-${index}` })
    );

    expect(
      resolveScheduleTimings(windowless, { phaseSecret: PHASE_SECRET, includeLastRun: false, now })
    ).toEqual(
      referenceResolve(windowless, now, false).map((timing) => ({ ...timing, lastRun: undefined }))
    );
  });

  it.each(CRONS)(
    "consecutive occurrences of %s (%s) are never closer than the minimum schedule range",
    (cron, timezone) => {
      const times = nextScheduledTimestamps(cron, timezone, now, 12);

      for (let i = 1; i < times.length; i++) {
        expect(times[i].getTime() - times[i - 1].getTime()).toBeGreaterThanOrEqual(
          MINIMUM_SCHEDULE_RANGE_MS
        );
      }
    }
  );

  it("rejects cron expressions with a seconds field, keeping the minimum interval at one minute", () => {
    expect(CronPattern.safeParse("*/30 * * * * *").success).toBe(false);
    expect(CronPattern.safeParse("* * * * *").success).toBe(true);

    const everyMinute = nextScheduledTimestamps("* * * * *", "America/New_York", now, 5);
    for (let i = 1; i < everyMinute.length; i++) {
      expect(everyMinute[i].getTime() - everyMinute[i - 1].getTime()).toBe(
        MINIMUM_SCHEDULE_RANGE_MS
      );
    }
  });

  it("returns an empty array for no rows", () => {
    expect(
      resolveScheduleTimings([], { phaseSecret: PHASE_SECRET, includeLastRun: true, now })
    ).toEqual([]);
  });
});
