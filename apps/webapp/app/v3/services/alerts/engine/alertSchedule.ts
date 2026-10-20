export const DEFAULT_DISTRIBUTION_WINDOW_SEC = 30;
export const LANE_RETRY_MIN_MS = 30_000;
export const LANE_RETRY_MAX_MS = 60_000;

export function fnv1a32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash = Math.imul(hash ^ input.charCodeAt(i), 16777619) >>> 0;
  }
  return hash;
}

export function alertPhaseOffsetMs(
  alertId: string,
  windowSec: number = DEFAULT_DISTRIBUTION_WINDOW_SEC
): number {
  if (!Number.isFinite(windowSec) || windowSec <= 0) return 0;
  return fnv1a32(alertId) % (windowSec * 1000);
}

export function capCadenceSec(cadenceSec: number, capSec?: number): number {
  return Math.min(cadenceSec, capSec ?? Infinity);
}

export function nextEvaluationAt(params: {
  previousDueAt: Date | null;
  cadenceSec: number;
  now: Date;
  alertId: string;
  windowSec?: number;
}): Date {
  const { previousDueAt, cadenceSec, now, alertId, windowSec } = params;
  if (!previousDueAt) return now;

  const cadenceMs = cadenceSec * 1000;
  const phaseMs = alertPhaseOffsetMs(alertId, windowSec);
  const k = Math.floor((now.getTime() - phaseMs) / cadenceMs) + 1;
  return new Date(k * cadenceMs + phaseMs);
}

export function laneRetryAt(params: { now: Date; random?: () => number }): Date {
  const random = params.random ?? Math.random;
  const delay = LANE_RETRY_MIN_MS + random() * (LANE_RETRY_MAX_MS - LANE_RETRY_MIN_MS);
  return new Date(params.now.getTime() + delay);
}
