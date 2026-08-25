import { parseExpression } from "cron-parser";
import {
  calculateEffectiveScheduleTime,
  type EffectiveScheduleTime,
  type NormalizedScheduleWindow,
} from "./scheduleTiming.js";

export function calculateNextNominalTimestamp(
  schedule: string,
  timezone: string | null,
  nominalTimestamp: Date
) {
  return calculateNextStep(schedule, timezone, nominalTimestamp);
}

function calculateNextStep(schedule: string, timezone: string | null, currentDate: Date) {
  return parseExpression(schedule, {
    currentDate,
    utc: timezone === null,
    tz: timezone ?? undefined,
  })
    .next()
    .toDate();
}

type SchedulableOccurrence = Omit<EffectiveScheduleTime, "effectiveAt"> & {
  candidateEffectiveAt: Date;
  effectiveAt: Date;
  skippedExpiredOccurrences: boolean;
};

/**
 * Selects the next occurrence that has not passed its actual eligibility time.
 *
 * The usual path advances strictly from the preceding nominal tick. If that occurrence expired
 * during downtime, selection jumps directly to the latest nominal tick that could still be
 * eligible, or to the first future nominal tick. This preserves one late catch-up without
 * replaying every missed occurrence.
 */
export function calculateNextSchedulableOccurrence({
  schedule,
  timezone,
  afterNominal,
  now,
  schedulePhase,
  window,
  cronSpreadEnabled,
}: {
  schedule: string;
  timezone: string | null;
  afterNominal: Date;
  now: Date;
  schedulePhase: number;
  window?: NormalizedScheduleWindow;
  cronSpreadEnabled: boolean;
}): SchedulableOccurrence {
  const occurrenceAt = (
    nominalAt: Date
  ): Omit<SchedulableOccurrence, "skippedExpiredOccurrences"> => {
    const nextNominalAt = calculateNextNominalTimestamp(schedule, timezone, nominalAt);
    const { effectiveAt: candidateEffectiveAt, ...timing } = calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt,
      schedulePhase,
      window,
    });

    return {
      ...timing,
      candidateEffectiveAt,
      effectiveAt: cronSpreadEnabled ? candidateEffectiveAt : nominalAt,
    };
  };

  const firstNominalAt = calculateNextNominalTimestamp(schedule, timezone, afterNominal);
  const firstOccurrence = occurrenceAt(firstNominalAt);

  if (firstOccurrence.effectiveAt.getTime() >= now.getTime()) {
    return { ...firstOccurrence, skippedExpiredOccurrences: false };
  }

  // `prev()` is strictly before its current date. Advancing by one millisecond includes a cron
  // tick exactly at `now`, whose effective time may still be upcoming.
  const latestNominalAt = previousScheduledTimestamp(
    schedule,
    timezone,
    new Date(now.getTime() + 1)
  );

  if (latestNominalAt.getTime() > afterNominal.getTime()) {
    const latestOccurrence = occurrenceAt(latestNominalAt);

    if (latestOccurrence.effectiveAt.getTime() >= now.getTime()) {
      return { ...latestOccurrence, skippedExpiredOccurrences: true };
    }
  }

  const nextOccurrence = occurrenceAt(calculateNextNominalTimestamp(schedule, timezone, now));
  return { ...nextOccurrence, skippedExpiredOccurrences: true };
}

/**
 * Cron's previous slot relative to `fromTimestamp`. For a continuously-
 * running schedule this equals the actual last fire time; for paused or
 * DST-edge cases it's an approximation. Used only on the recovery path
 * where the actual last fire isn't recoverable from in-flight worker state.
 */
export function previousScheduledTimestamp(
  cron: string,
  timezone: string | null,
  fromTimestamp: Date = new Date()
) {
  return parseExpression(cron, {
    currentDate: fromTimestamp,
    utc: timezone === null,
    tz: timezone ?? undefined,
  })
    .prev()
    .toDate();
}

export function nextScheduledTimestamps(
  cron: string,
  timezone: string | null,
  lastScheduledTimestamp: Date,
  count: number = 1
) {
  const result: Array<Date> = [];
  let nextScheduledTimestamp = lastScheduledTimestamp;

  for (let i = 0; i < count; i++) {
    nextScheduledTimestamp = calculateNextNominalTimestamp(cron, timezone, nextScheduledTimestamp);

    result.push(nextScheduledTimestamp);
  }

  return result;
}
