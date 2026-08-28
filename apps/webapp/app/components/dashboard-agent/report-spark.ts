/**
 * The sparkline's arithmetic. It lives here rather than in `report-sparkline.tsx` so it stays
 * clock-free: bar timestamps come from the presenter's `generatedAt`, never from the renderer.
 */

/** How many bars a series is condensed to, so each bar stays wide enough to hover. */
export const MAX_BARS = 18;

/** Average adjacent points down so each bar is wide enough to read and hover. */
export function condense(points: number[], maxBars: number = MAX_BARS): number[] {
  if (points.length <= maxBars) return points;
  const perBar = points.length / maxBars;
  return Array.from({ length: maxBars }, (_, i) => {
    const slice = points.slice(Math.floor(i * perBar), Math.floor((i + 1) * perBar));
    return slice.reduce((sum, v) => sum + v, 0) / Math.max(slice.length, 1);
  });
}

/** The series' end, from the view model. Null when the report carries no usable timestamp. */
export function seriesEndMs(generatedAt: string | undefined): number | null {
  if (!generatedAt) return null;
  const ms = Date.parse(generatedAt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Each bar's start, spread back from the series' end. All null when the end is unknown: a bar
 * with no time reads as one, where a guessed time reads as a fact.
 */
export function barTimesMs(
  barCount: number,
  windowMinutes: number,
  endMs: number | null
): (number | null)[] {
  const length = Math.max(barCount, 0);
  if (endMs === null || length === 0) return Array.from({ length }, () => null);
  const windowMs = windowMinutes * 60_000;
  const intervalMs = windowMs / length;
  const startMs = endMs - windowMs;
  return Array.from({ length }, (_, i) => startMs + i * intervalMs);
}

/** Trailing bars inside the anomaly window, which paint at full strength. */
export function hotBarCount(
  barCount: number,
  windowMinutes: number,
  anomalyMinutes: number | undefined
): number {
  const minutesPerBar = barCount > 0 ? windowMinutes / barCount : 0;
  if (!anomalyMinutes || minutesPerBar <= 0) return 0;
  return Math.min(barCount, Math.max(1, Math.round(anomalyMinutes / minutesPerBar)));
}
