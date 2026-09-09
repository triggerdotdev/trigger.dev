import {
  MAX_ABSOLUTE_SCHEDULE_WINDOW_SECONDS,
  parseScheduleWindow,
  type NormalizedScheduleWindow,
} from "@trigger.dev/core/v3";
import { createHmac } from "node:crypto";

export { MAX_ABSOLUTE_SCHEDULE_WINDOW_SECONDS, parseScheduleWindow };
export type { NormalizedScheduleWindow };

export const SCHEDULE_PHASE_DENOMINATOR = 2_147_483_648;
export const MAX_SCHEDULE_PHASE = SCHEDULE_PHASE_DENOMINATOR - 1;
export const MINIMUM_SCHEDULE_RANGE_MS = 60_000;

const PERCENTAGE_DENOMINATOR = 100;

export type SchedulePhaseInput = {
  secret: string | Buffer;
  environmentId: string;
  deduplicationKey: string;
};

export type EffectiveScheduleTime = {
  nominalAt: Date;
  nextNominalAt: Date;
  effectiveAt: Date;
  intervalMs: number;
  windowMs: number;
  effectiveRangeMs: number;
  offsetMs: number;
  windowWasCappedToInterval: boolean;
};

/**
 * The three window inputs stored on a TaskSchedule row. `defaultWindowDurationSeconds` is the
 * default captured when the schedule was created (null for legacy/grandfathered rows).
 */
export type ScheduleWindowFields = {
  windowDurationSeconds: number | null;
  windowPercentage: number | null;
  defaultWindowDurationSeconds?: number | null;
};

/** Where the effective window came from. `undefined` means the schedule is grandfathered. */
export type ScheduleWindowSource = "explicit" | "schedule_default";

/**
 * Pure resolution of a schedule's effective window from its stored fields.
 *
 * Precedence:
 *   1. Explicit percentage (including 0%).
 *   2. Explicit duration (including 0m — this disables a larger default but still
 *      receives the engine's 60-second platform minimum downstream).
 *   3. Captured schedule default.
 *   4. No window — grandfathered rows fall through to the 60-second minimum only.
 *
 * The engine and every dashboard/API surface must resolve through this so Redis timing and
 * displayed `nextRunEffectiveAt` can never disagree.
 */
export function resolveScheduleWindow(fields: ScheduleWindowFields): {
  window: NormalizedScheduleWindow | undefined;
  source: ScheduleWindowSource | undefined;
} {
  if (fields.windowPercentage !== null) {
    return {
      window: { type: "percentage", percentage: fields.windowPercentage },
      source: "explicit",
    };
  }

  if (fields.windowDurationSeconds !== null) {
    return {
      window: { type: "duration", durationSeconds: fields.windowDurationSeconds },
      source: "explicit",
    };
  }

  if (
    fields.defaultWindowDurationSeconds !== null &&
    fields.defaultWindowDurationSeconds !== undefined
  ) {
    return {
      window: { type: "duration", durationSeconds: fields.defaultWindowDurationSeconds },
      source: "schedule_default",
    };
  }

  return { window: undefined, source: undefined };
}

export function validateScheduleWindow(window: NormalizedScheduleWindow): void {
  if (window.type === "duration") {
    if (
      !Number.isSafeInteger(window.durationSeconds) ||
      window.durationSeconds < 0 ||
      window.durationSeconds > MAX_ABSOLUTE_SCHEDULE_WINDOW_SECONDS
    ) {
      throw new RangeError(
        "Schedule window duration must be a non-negative integer up to 24 hours"
      );
    }

    return;
  }

  if (
    !Number.isInteger(window.percentage) ||
    window.percentage < 0 ||
    window.percentage > PERCENTAGE_DENOMINATOR
  ) {
    throw new RangeError(
      "Schedule window percentage must be a whole percentage from 0% through 100%"
    );
  }
}

/**
 * A persisted plan minimum in seconds, converted to milliseconds. A non-positive or absent
 * value contributes no floor. Rejects unsafe/negative inputs so a corrupt row can't produce a
 * nonsensical range.
 */
export function resolvePolicyMinimumMs(minimumWindowDurationSeconds?: number | null): number {
  if (minimumWindowDurationSeconds === undefined || minimumWindowDurationSeconds === null) {
    return 0;
  }

  if (!Number.isSafeInteger(minimumWindowDurationSeconds) || minimumWindowDurationSeconds < 0) {
    throw new RangeError(
      "minimumWindowDurationSeconds must be a non-negative integer number of seconds"
    );
  }

  return minimumWindowDurationSeconds * 1_000;
}

export function resolveScheduleWindowMs(
  window: NormalizedScheduleWindow | undefined,
  intervalMs: number
): number {
  assertPositiveInterval(intervalMs);

  if (!window) {
    return 0;
  }

  validateScheduleWindow(window);

  if (window.type === "duration") {
    return window.durationSeconds * 1_000;
  }

  return Number((BigInt(intervalMs) * BigInt(window.percentage)) / BigInt(PERCENTAGE_DENOMINATOR));
}

/**
 * Calculates the stable effective time for one nominal occurrence using integer arithmetic.
 *
 * An absolute window is a maximum. Each occurrence caps it at the interval to its next nominal
 * tick, guaranteeing that the effective time never reaches or passes the next occurrence.
 *
 * `minimumWindowDurationSeconds` is a persisted policy floor (e.g. the free-plan 60-minute
 * minimum). It raises the requested range but is still capped by the next nominal interval, so
 * a policy minimum never pushes an occurrence past the following one. Null/undefined means no
 * policy floor applies (grandfathered/unrestricted schedules).
 */
export function calculateEffectiveScheduleTime({
  nominalAt,
  nextNominalAt,
  schedulePhase,
  window,
  minimumWindowDurationSeconds,
}: {
  nominalAt: Date;
  nextNominalAt: Date;
  schedulePhase: number;
  window?: NormalizedScheduleWindow;
  minimumWindowDurationSeconds?: number | null;
}): EffectiveScheduleTime {
  assertValidDate(nominalAt, "nominalAt");
  assertValidDate(nextNominalAt, "nextNominalAt");
  assertValidSchedulePhase(schedulePhase);

  const intervalMs = nextNominalAt.getTime() - nominalAt.getTime();
  assertPositiveInterval(intervalMs);

  const windowMs = resolveScheduleWindowMs(window, intervalMs);
  const policyMinimumMs = resolvePolicyMinimumMs(minimumWindowDurationSeconds);
  const requestedRangeMs = Math.max(MINIMUM_SCHEDULE_RANGE_MS, windowMs, policyMinimumMs);
  const effectiveRangeMs = Math.min(intervalMs, requestedRangeMs);
  const windowWasCappedToInterval = effectiveRangeMs !== requestedRangeMs;
  const offsetMs = Number(
    (BigInt(schedulePhase) * BigInt(effectiveRangeMs)) / BigInt(SCHEDULE_PHASE_DENOMINATOR)
  );
  const effectiveAtMs = nominalAt.getTime() + offsetMs;

  if (!Number.isSafeInteger(effectiveAtMs)) {
    throw new RangeError("Calculated effective schedule time is outside the safe date range");
  }

  return {
    nominalAt,
    nextNominalAt,
    effectiveAt: new Date(effectiveAtMs),
    intervalMs,
    windowMs,
    effectiveRangeMs,
    offsetMs,
    windowWasCappedToInterval,
  };
}

/** Calculates the durable, domain-separated phase stored on a schedule instance. */
export function calculateSchedulePhase({
  secret,
  environmentId,
  deduplicationKey,
}: SchedulePhaseInput): number {
  if (
    (typeof secret === "string" && secret.length === 0) ||
    (Buffer.isBuffer(secret) && !secret.length)
  ) {
    throw new RangeError("Schedule phase secret must not be empty");
  }

  const input = JSON.stringify(["cron-phase-v1", environmentId, deduplicationKey]);
  const digest = createHmac("sha256", secret).update(input).digest();

  return digest.readUInt32BE(0) & MAX_SCHEDULE_PHASE;
}

function assertValidSchedulePhase(schedulePhase: number): void {
  if (!Number.isInteger(schedulePhase) || schedulePhase < 0 || schedulePhase > MAX_SCHEDULE_PHASE) {
    throw new RangeError(`Schedule phase must be an integer from 0 to ${MAX_SCHEDULE_PHASE}`);
  }
}

function assertPositiveInterval(intervalMs: number): void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError(
      "Nominal schedule interval must be a positive integer number of milliseconds"
    );
  }
}

function assertValidDate(value: Date, name: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError(`${name} must be a valid date`);
  }
}
