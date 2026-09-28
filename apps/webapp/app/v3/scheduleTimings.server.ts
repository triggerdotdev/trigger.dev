import {
  MINIMUM_SCHEDULE_RANGE_MS,
  calculateEffectiveScheduleTime,
  calculateSchedulePhase,
  resolveScheduleWindow,
} from "@internal/schedule-engine";
import { type NormalizedScheduleWindow } from "@trigger.dev/core/v3";
import {
  nextScheduledTimestamps,
  previousScheduledTimestamp,
} from "./utils/calculateNextSchedule.server";

/**
 * Everything a single row needs to have its run times resolved. Deliberately
 * free of Prisma types so this stays testable and benchmarkable on its own.
 */
export type ScheduleTimingInput = {
  cron: string;
  timezone: string | null;
  deduplicationKey: string;
  environmentId: string;
  schedulePhase: number | null;
  windowDurationSeconds: number | null;
  windowPercentage: number | null;
  defaultWindowDurationSeconds?: number | null;
  /** Persisted plan-policy floor (seconds). Null means unrestricted/grandfathered. */
  minimumWindowDurationSeconds: number | null;
  active: boolean;
  updatedAt: Date;
};

export type ScheduleTiming = {
  nextRun: Date;
  nextRunEffectiveAt: Date;
  /** Only ever set when the caller asked for it AND the schedule is active. */
  lastRun: Date | undefined;
};

export type ResolveScheduleTimingsOptions = {
  phaseSecret: string;
  /**
   * Walking the cron backwards to approximate "last run" is by far the most
   * expensive thing here, and only the dashboard renders it. Callers that
   * don't show the column (the public API) leave this off and skip the walk.
   */
  includeLastRun: boolean;
  /**
   * Fixed reference point for the whole batch. Pinning it once is what makes
   * the cron walks cacheable across rows, and it stops rows in one response
   * disagreeing about "now".
   */
  now?: Date;
};

/**
 * Resolves run times for a page of schedules.
 *
 * The cron walk (`cron-parser`) dominates this path: one step costs tens of
 * microseconds for a plain UTC expression and milliseconds for a sparse one in
 * a named timezone, because the library walks the calendar unit by unit
 * through luxon. At 100 rows that is enough to block the event loop for
 * seconds.
 *
 * Two properties keep it cheap:
 *
 * 1. Nominal run times depend only on (cron, timezone, now). With `now` pinned
 *    for the batch, rows sharing an expression share an answer, so cost is
 *    O(distinct crons) rather than O(rows) — projects tend to run the same
 *    handful of expressions across many schedules.
 * 2. Everything that genuinely varies per row (phase, window, effectiveAt) is
 *    arithmetic over the cached nominal times, not another walk.
 * 3. Windowless schedules take one step instead of two. The second step exists
 *    only to measure the interval to the following occurrence, and the
 *    interval reaches `calculateEffectiveScheduleTime`'s result solely through
 *    `min(intervalMs, max(MINIMUM_SCHEDULE_RANGE_MS, windowMs))`. With no
 *    window `windowMs` is 0, and `CronPattern` rejects expressions with a
 *    seconds field, so consecutive occurrences are always at least
 *    `MINIMUM_SCHEDULE_RANGE_MS` apart and that `min` can never bind. Stepping
 *    a second time would change nothing, and it is the more expensive of the
 *    two steps because it walks a whole period rather than the remainder of
 *    the current one.
 *
 * Caches live for one call only: every entry is valid solely against this
 * batch's `now`.
 */
export function resolveScheduleTimings(
  inputs: ScheduleTimingInput[],
  { phaseSecret, includeLastRun, now = new Date() }: ResolveScheduleTimingsOptions
): ScheduleTiming[] {
  const nominalCache = new Map<string, Date[]>();
  const previousCache = new Map<
    string,
    { latestNominal: Date; previousNominal?: Date } | undefined
  >();

  return inputs.map((input) => {
    const window: NormalizedScheduleWindow | undefined = resolveScheduleWindow({
      windowDurationSeconds: input.windowDurationSeconds,
      windowPercentage: input.windowPercentage,
      defaultWindowDurationSeconds: input.defaultWindowDurationSeconds,
    }).window;

    // A persisted policy floor (e.g. the free-plan 60m minimum) behaves like a window: it can
    // bind against the next nominal gap, so we must walk the second step to measure that gap.
    // Windowless, unrestricted schedules keep the one-step fast path (see the doc comment).
    const hasPolicyMinimum =
      input.minimumWindowDurationSeconds !== null && input.minimumWindowDurationSeconds > 0;
    const steps = window || hasPolicyMinimum ? 2 : 1;
    const key = `${cacheKey(input.cron, input.timezone)}\n${steps}`;

    let nominalTimes = nominalCache.get(key);
    if (!nominalTimes) {
      nominalTimes = nextScheduledTimestamps(input.cron, input.timezone, now, steps);
      nominalCache.set(key, nominalTimes);
    }

    const nominalAt = nominalTimes[0];
    const nextNominalAt =
      nominalTimes[1] ?? new Date(nominalAt.getTime() + MINIMUM_SCHEDULE_RANGE_MS);

    const phase =
      input.schedulePhase ??
      calculateSchedulePhase({
        secret: phaseSecret,
        environmentId: input.environmentId,
        deduplicationKey: input.deduplicationKey,
      });

    const { effectiveAt } = calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt,
      schedulePhase: phase,
      window,
      minimumWindowDurationSeconds: input.minimumWindowDurationSeconds,
    });

    return {
      nextRun: nominalAt,
      nextRunEffectiveAt: effectiveAt,
      lastRun: includeLastRun
        ? resolveLastRun(input, now, nominalAt, phase, window, previousCache)
        : undefined,
    };
  });
}

/**
 * Approximates "last run" from the most recent effective schedule time.
 *
 * Skips inactive schedules and effective times that predate `updatedAt`. Best-effort by design;
 * the runs page is the source of truth.
 */
function resolveLastRun(
  input: ScheduleTimingInput,
  now: Date,
  nextNominal: Date,
  phase: number,
  window: NormalizedScheduleWindow | undefined,
  cache: Map<string, { latestNominal: Date; previousNominal?: Date } | undefined>
): Date | undefined {
  if (!input.active) {
    return undefined;
  }

  const key = cacheKey(input.cron, input.timezone);
  let nominalTimes = cache.get(key);

  if (!cache.has(key)) {
    try {
      nominalTimes = {
        latestNominal: previousScheduledTimestamp(
          input.cron,
          input.timezone,
          new Date(now.getTime() + 1)
        ),
      };
    } catch {
      nominalTimes = undefined;
    }
    cache.set(key, nominalTimes);
  }

  if (!nominalTimes) {
    return undefined;
  }

  const latestEffective = calculateEffectiveScheduleTime({
    nominalAt: nominalTimes.latestNominal,
    nextNominalAt: nextNominal,
    schedulePhase: phase,
    window,
    minimumWindowDurationSeconds: input.minimumWindowDurationSeconds,
  }).effectiveAt;
  if (latestEffective.getTime() <= now.getTime()) {
    return latestEffective.getTime() > input.updatedAt.getTime() ? latestEffective : undefined;
  }

  if (!nominalTimes.previousNominal) {
    nominalTimes.previousNominal = previousScheduledTimestamp(
      input.cron,
      input.timezone,
      nominalTimes.latestNominal
    );
  }
  const previousEffective = calculateEffectiveScheduleTime({
    nominalAt: nominalTimes.previousNominal,
    nextNominalAt: nominalTimes.latestNominal,
    schedulePhase: phase,
    window,
    minimumWindowDurationSeconds: input.minimumWindowDurationSeconds,
  }).effectiveAt;

  return previousEffective.getTime() > input.updatedAt.getTime() ? previousEffective : undefined;
}

/**
 * Newline separator: an IANA timezone name cannot contain one, so no
 * (cron, timezone) pair can collide with another by straddling the boundary.
 */
function cacheKey(cron: string, timezone: string | null): string {
  return `${timezone ?? ""}\n${cron}`;
}
