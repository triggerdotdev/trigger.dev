import {
  MINIMUM_SCHEDULE_RANGE_MS,
  calculateEffectiveScheduleTime,
  calculateSchedulePhase,
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
  const previousCache = new Map<string, Date | undefined>();

  return inputs.map((input) => {
    const window: NormalizedScheduleWindow | undefined =
      input.windowPercentage !== null
        ? { type: "percentage", percentage: input.windowPercentage }
        : input.windowDurationSeconds !== null
          ? { type: "duration", durationSeconds: input.windowDurationSeconds }
          : undefined;

    const steps = window ? 2 : 1;
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
    });

    return {
      nextRun: nominalAt,
      nextRunEffectiveAt: effectiveAt,
      lastRun: includeLastRun ? resolveLastRun(input, now, previousCache) : undefined,
    };
  });
}

/**
 * Approximates "last run" from the cron's previous slot.
 *
 * Skips inactive schedules — the previous slot reflects what *would* have
 * fired. Skips slots that predate `updatedAt`: any config change (cron edited,
 * timezone changed, deactivate/reactivate) bumps `updatedAt`, and a slot from
 * before the most recent change didn't fire under the current configuration.
 *
 * `cron-parser` throws on malformed expressions, so this degrades to undefined
 * per row rather than failing the whole list. Best-effort by design; the runs
 * page is the source of truth.
 */
function resolveLastRun(
  input: ScheduleTimingInput,
  now: Date,
  cache: Map<string, Date | undefined>
): Date | undefined {
  if (!input.active) {
    return undefined;
  }

  const key = cacheKey(input.cron, input.timezone);

  let previous: Date | undefined;
  if (cache.has(key)) {
    previous = cache.get(key);
  } else {
    try {
      previous = previousScheduledTimestamp(input.cron, input.timezone, now);
    } catch {
      previous = undefined;
    }
    cache.set(key, previous);
  }

  if (!previous) {
    return undefined;
  }

  return previous.getTime() > input.updatedAt.getTime() ? previous : undefined;
}

/**
 * Newline separator: an IANA timezone name cannot contain one, so no
 * (cron, timezone) pair can collide with another by straddling the boundary.
 */
function cacheKey(cron: string, timezone: string | null): string {
  return `${timezone ?? ""}\n${cron}`;
}
