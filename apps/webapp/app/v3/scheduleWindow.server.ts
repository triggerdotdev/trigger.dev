import { calculateEffectiveScheduleTime, calculateSchedulePhase } from "@internal/schedule-engine";
import {
  ScheduleWindow,
  parseScheduleWindow,
  type NormalizedScheduleWindow,
} from "@trigger.dev/core/v3";
import { nextScheduledTimestamps } from "./utils/calculateNextSchedule.server";

const SECONDS_PER_UNIT = {
  m: 60,
  h: 3_600,
} as const;

export type ScheduleWindowDatabaseFields = {
  windowDurationSeconds: number | null;
  windowPercentage: number | null;
};

export type ScheduleRunTiming = {
  nominalAt: Date;
  effectiveAt: Date;
};

export function normalizeScheduleWindow(window: string | undefined): ScheduleWindowDatabaseFields {
  if (window === undefined) {
    return {
      windowDurationSeconds: null,
      windowPercentage: null,
    };
  }

  const parsedWindow = parseScheduleWindow(window);

  if (parsedWindow.type === "percentage") {
    return {
      windowDurationSeconds: null,
      windowPercentage: parsedWindow.percentage,
    };
  }

  return {
    windowDurationSeconds: parsedWindow.durationSeconds,
    windowPercentage: null,
  };
}

export function formatScheduleWindow({
  windowDurationSeconds,
  windowPercentage,
}: ScheduleWindowDatabaseFields): string | undefined {
  if (windowPercentage !== null) {
    return `${windowPercentage}%`;
  }

  if (windowDurationSeconds === null) {
    return undefined;
  }

  if (windowDurationSeconds === 0) {
    return "0m";
  }

  if (windowDurationSeconds % SECONDS_PER_UNIT.h === 0) {
    return `${windowDurationSeconds / SECONDS_PER_UNIT.h}h`;
  }

  return `${windowDurationSeconds / SECONDS_PER_UNIT.m}m`;
}

export function calculateNextScheduleRunTimes({
  cron,
  timezone,
  deduplicationKey,
  environmentId,
  schedulePhase,
  phaseSecret,
  windowDurationSeconds,
  windowPercentage,
  from = new Date(),
  count = 1,
}: {
  cron: string;
  timezone: string | null;
  deduplicationKey: string;
  environmentId: string;
  schedulePhase: number | null;
  phaseSecret: string;
  windowDurationSeconds: number | null;
  windowPercentage: number | null;
  from?: Date;
  count?: number;
}): ScheduleRunTiming[] {
  if (count <= 0) {
    return [];
  }

  const phase =
    schedulePhase ??
    calculateSchedulePhase({
      secret: phaseSecret,
      environmentId,
      deduplicationKey,
    });
  const window: NormalizedScheduleWindow | undefined =
    windowPercentage !== null
      ? { type: "percentage", percentage: windowPercentage }
      : windowDurationSeconds !== null
        ? { type: "duration", durationSeconds: windowDurationSeconds }
        : undefined;
  const nominalTimes = nextScheduledTimestamps(cron, timezone, from, count + 1);

  return nominalTimes.slice(0, count).map((nominalAt, index) => ({
    nominalAt,
    effectiveAt: calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt: nominalTimes[index + 1],
      schedulePhase: phase,
      window,
    }).effectiveAt,
  }));
}

export function validateScheduleWindowSyntax(
  window: string | undefined
): { valid: true } | { valid: false; message: string } {
  if (window === undefined) {
    return { valid: true };
  }

  const result = ScheduleWindow.safeParse(window);
  if (result.success) {
    return { valid: true };
  }

  return {
    valid: false,
    message: result.error.issues[0]?.message ?? "Invalid schedule window",
  };
}
