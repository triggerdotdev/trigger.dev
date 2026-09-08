import {
  calculateEffectiveScheduleTime,
  calculateSchedulePhase,
  resolveScheduleWindow,
  type ScheduleWindowSource,
} from "@internal/schedule-engine";
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

/**
 * The default spread window captured on a new schedule when the org rollout flag is enabled.
 * Persisted per-schedule so a later change to this constant only affects schedules created after
 * the change; existing rows keep whatever they captured.
 */
export const NEW_SCHEDULE_DEFAULT_WINDOW_DURATION_SECONDS = 3_600;

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

function formatDurationSeconds(durationSeconds: number): string {
  if (durationSeconds === 0) {
    return "0m";
  }

  if (durationSeconds % SECONDS_PER_UNIT.h === 0) {
    return `${durationSeconds / SECONDS_PER_UNIT.h}h`;
  }

  return `${durationSeconds / SECONDS_PER_UNIT.m}m`;
}

/**
 * The user-configured window only. Returns undefined when the user configured nothing, even if a
 * default was captured — the edit form must show the field blank so the captured default surfaces
 * through the placeholder copy rather than as a value the user appears to have typed.
 */
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

  return formatDurationSeconds(windowDurationSeconds);
}

/**
 * The resolved effective window used for scheduling, with its provenance. Falls back to the
 * captured schedule default when the user configured nothing. Used by the list/inspector and the
 * public API so a defaulted schedule reads back as e.g. "60m" with source "schedule_default".
 */
export function formatResolvedScheduleWindow(fields: {
  windowDurationSeconds: number | null;
  windowPercentage: number | null;
  defaultWindowDurationSeconds?: number | null;
}): { window: string | undefined; source: ScheduleWindowSource | undefined } {
  const { window, source } = resolveScheduleWindow(fields);

  if (!window) {
    return { window: undefined, source: undefined };
  }

  if (window.type === "percentage") {
    return { window: `${window.percentage}%`, source };
  }

  return { window: formatDurationSeconds(window.durationSeconds), source };
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
  defaultWindowDurationSeconds,
  minimumWindowDurationSeconds = null,
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
  defaultWindowDurationSeconds?: number | null;
  minimumWindowDurationSeconds?: number | null;
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
  const window: NormalizedScheduleWindow | undefined = resolveScheduleWindow({
    windowDurationSeconds,
    windowPercentage,
    defaultWindowDurationSeconds,
  }).window;
  const nominalTimes = nextScheduledTimestamps(cron, timezone, from, count + 1);

  return nominalTimes.slice(0, count).map((nominalAt, index) => ({
    nominalAt,
    effectiveAt: calculateEffectiveScheduleTime({
      nominalAt,
      nextNominalAt: nominalTimes[index + 1],
      schedulePhase: phase,
      window,
      minimumWindowDurationSeconds,
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
