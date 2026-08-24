import parse from "parse-duration";
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

/**
 * The shape TimeFilter writes: a count plus a minute/hour/day unit. The count is unbounded here
 * because the picker accepts any positive integer for a custom duration (`10000m` is a little under
 * 7 days); the retention bound below is what rules a window out.
 */
const PERIOD_PATTERN = /^\d+[mhd]$/;

/** Queue metrics are retained for 30 days, so a longer window can only ever render empty. */
export const QUEUE_METRICS_RETENTION_DAYS = 30;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_PERIOD_MS = QUEUE_METRICS_RETENTION_DAYS * DAY_MS;

function isPeriod(value: string | undefined | null): value is string {
  if (typeof value !== "string" || !PERIOD_PATTERN.test(value)) return false;
  const ms = parse(value);
  return typeof ms === "number" && ms > 0 && ms <= MAX_PERIOD_MS;
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
 * The window the page should show: a usable period in the URL wins, an absolute range means "no
 * period", and everything else (including a period the picker could never produce, e.g. a
 * hand-edited `?period=garbage`) falls back to the remembered default the loader resolved. The
 * result is held inside the org's plan query period, since that is the window the data will cover.
 *
 * Both the loaders and the client-side chart queries resolve through here, so they can't disagree
 * about the window.
 */
export function resolveQueueMetricsPeriod({
  period,
  from,
  to,
  defaultPeriod,
  maxPeriodDays,
}: {
  period: string | undefined;
  from: string | undefined;
  to: string | undefined;
  defaultPeriod: string;
  maxPeriodDays: number;
}): string | null {
  if (isPeriod(period)) return clampQueueMetricsPeriod(period, maxPeriodDays);
  if (from || to) return null;
  return clampQueueMetricsPeriod(defaultPeriod, maxPeriodDays);
}

/**
 * Hold a period inside a day budget (the org's plan query period). A period longer than the plan
 * allows becomes the plan's maximum, so the picker shows the window the data covers.
 *
 * The budget is whatever the plan says, not necessarily a whole number of days, so the replacement
 * is expressed in the largest unit that divides it: rounding down keeps the period inside the
 * budget rather than a hair over it.
 */
export function clampQueueMetricsPeriod(period: string, maxPeriodDays: number): string {
  const maxMs = maxPeriodDays * DAY_MS;
  const ms = parse(period);
  if (typeof ms === "number" && ms > 0 && ms <= maxMs) return period;

  const days = Math.floor(maxMs / DAY_MS);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(maxMs / HOUR_MS);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(maxMs / MINUTE_MS))}m`;
}

/**
 * Pull a window forward to the earliest time the org's plan can query, the same clip `executeQuery`
 * applies to every metric query. Queue-metric queries that go straight to ClickHouse (the queues
 * list table, the concurrency-keys endpoint) have to apply it themselves, otherwise a hand-typed
 * `?period=` reaches further back than the plan allows.
 *
 * A range that ends before the plan's earliest queryable time collapses to an empty window rather
 * than an inverted one, which is what the enforced lower bound in `executeQuery` yields for the
 * same request: no rows.
 */
export function clipQueueMetricsWindow(
  window: { from: Date; to: Date },
  maxPeriodDays: number
): { from: Date; to: Date } {
  const earliest = new Date(Date.now() - maxPeriodDays * DAY_MS);
  const from = window.from < earliest ? earliest : window.from;
  return { from, to: window.to < from ? from : window.to };
}
