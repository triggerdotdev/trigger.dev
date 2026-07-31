import { useEffect } from "react";

/**
 * The time window the queue-metrics pages (queues list + queue detail) use when the URL carries
 * no explicit period, and the memory that makes the user's last pick stick.
 *
 * The last period picked is stored in a cookie rather than localStorage so the loaders can read it
 * and the first render already uses the remembered window (with localStorage the page would paint
 * the default and then re-fetch). Absolute from/to ranges are never remembered: they'd pin later
 * visits to a window that goes stale.
 */
export const QUEUE_METRICS_DEFAULT_PERIOD = "1h";

const COOKIE_NAME = "queueMetricsPeriod";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** The shape TimeFilter writes: a count plus a minute/hour/day unit (presets and custom durations). */
const PERIOD_PATTERN = /^\d{1,4}[mhd]$/;

function isPeriod(value: string | undefined | null): value is string {
  return typeof value === "string" && PERIOD_PATTERN.test(value);
}

/** Loader side: the remembered period, falling back to the default when nothing usable is stored. */
export function queueMetricsPeriodFromRequest(request: Request): string {
  const header = request.headers.get("cookie");
  if (!header) return QUEUE_METRICS_DEFAULT_PERIOD;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return isPeriod(value) ? value : QUEUE_METRICS_DEFAULT_PERIOD;
  }

  return QUEUE_METRICS_DEFAULT_PERIOD;
}

/**
 * Remember the period currently in the URL so the next visit to a queue-metrics page opens on it.
 * Pass the raw `period` search param: an absent one (the page is on its default) or an absolute
 * from/to range leaves the stored value alone.
 */
export function useRememberQueueMetricsPeriod(period: string | undefined) {
  useEffect(() => {
    if (!isPeriod(period)) return;
    document.cookie = `${COOKIE_NAME}=${period}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
  }, [period]);
}

/**
 * The window the page should show: an explicit period wins, an absolute range means "no period",
 * and everything else falls back to the remembered default the loader resolved.
 */
export function resolveQueueMetricsPeriod({
  period,
  from,
  to,
  defaultPeriod,
}: {
  period: string | undefined;
  from: string | undefined;
  to: string | undefined;
  defaultPeriod: string;
}): string | null {
  if (period) return period;
  if (from || to) return null;
  return defaultPeriod;
}
