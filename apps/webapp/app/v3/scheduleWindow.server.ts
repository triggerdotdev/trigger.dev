import {
  calculateNextNominalTimestamp,
  parseScheduleWindow,
  validateScheduleWindowForInterval,
} from "@internal/schedule-engine";
import type { ScheduleWindow } from "@trigger.dev/core/v3";
import { calculateNextScheduledTimestampFromNow } from "./utils/calculateNextSchedule.server";

const SECONDS_PER_UNIT = {
  m: 60,
  h: 3_600,
  d: 86_400,
} as const;

export type ScheduleWindowDatabaseFields = {
  windowDurationSeconds: number | null;
  windowPercentage: number | null;
};

export function normalizeScheduleWindow(
  window: ScheduleWindow | undefined
): ScheduleWindowDatabaseFields {
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
}: ScheduleWindowDatabaseFields): ScheduleWindow | undefined {
  if (windowPercentage !== null) {
    return `${windowPercentage}%`;
  }

  if (windowDurationSeconds === null) {
    return undefined;
  }

  if (windowDurationSeconds === 0) {
    return "0m";
  }

  if (windowDurationSeconds % SECONDS_PER_UNIT.d === 0) {
    return `${windowDurationSeconds / SECONDS_PER_UNIT.d}d`;
  }

  if (windowDurationSeconds % SECONDS_PER_UNIT.h === 0) {
    return `${windowDurationSeconds / SECONDS_PER_UNIT.h}h`;
  }

  return `${windowDurationSeconds / SECONDS_PER_UNIT.m}m`;
}

export function validateScheduleWindowAgainstCron({
  window,
  cron,
  timezone,
}: {
  window: ScheduleWindow | undefined;
  cron: string;
  timezone: string | null;
}): { valid: true } | { valid: false; message: string } {
  if (window === undefined) {
    return { valid: true };
  }

  try {
    const normalizedWindow = parseScheduleWindow(window);
    const nominalAt = calculateNextScheduledTimestampFromNow(cron, timezone);
    const nextNominalAt = calculateNextNominalTimestamp(cron, timezone, nominalAt);

    validateScheduleWindowForInterval(
      normalizedWindow,
      nextNominalAt.getTime() - nominalAt.getTime()
    );

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
