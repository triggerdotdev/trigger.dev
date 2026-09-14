import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInterval } from "./useInterval";

export type MetricResourceRow = Record<string, number | string | null>;

/** The query's actual bucketed window (ISO), so a caller can size an axis without its own clock. */
export type MetricResourceRange = { from: string; to: string };

type MetricResourceResponse =
  | { success: true; data: { rows: MetricResourceRow[]; timeRange: MetricResourceRange } }
  | { success: false; error: string };

export type MetricResourceTimeRange = {
  period: string | null;
  from: string | null;
  to: string | null;
};

export function useIsMetricResponseFresh(
  responseReceivedAt: number | null,
  dataTimestamp: number,
  maxAgeMs: number
) {
  const expiresAt =
    responseReceivedAt !== null && Number.isFinite(dataTimestamp) ? dataTimestamp + maxAgeMs : null;
  const [expiredAt, setExpiredAt] = useState<number | null>(null);

  useEffect(() => {
    if (expiresAt === null) return;

    const timeout = setTimeout(() => setExpiredAt(expiresAt), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timeout);
  }, [expiresAt]);

  return (
    expiresAt !== null &&
    responseReceivedAt !== null &&
    responseReceivedAt < expiresAt &&
    expiredAt !== expiresAt
  );
}

export type MetricResourceQueryOptions = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  timeRange: MetricResourceTimeRange;
  defaultPeriod: string;
  queues?: string[];
  fillGaps?: boolean;
  /** Floor for the query's bucket width, for series too sparse to read at the range's width. */
  minBucketSeconds?: number;
  refreshIntervalMs?: number;
  /** Refetch when the tab regains focus/visibility. Defaults to true. */
  refetchOnFocus?: boolean;
  /**
   * Set when the caller wrote `query` themselves (e.g. the dashboard agent's generated charts),
   * so a ClickHouse rejection is logged as a warning instead of alerting on-call. See
   * `queryService.server.ts`'s `userAuthoredQuery`.
   */
  userAuthoredQuery?: boolean;
};

type CachedMetricResponse = { rows: MetricResourceRow[]; timeRange: MetricResourceRange | null };

// Module-level cache of the last successful response per query signature. Lets a remounted chart
// (switching tabs, or navigating back to the queues list) paint its previous data immediately
// instead of flashing a loading skeleton every time, while it revalidates in the background.
// Bounded so it can't grow without limit over a long session.
const responseCache = new Map<string, CachedMetricResponse>();
const RESPONSE_CACHE_MAX = 200;

function cacheSet(key: string, response: CachedMetricResponse) {
  // Re-insert so the key becomes the most-recently-used (Map preserves insertion order).
  responseCache.delete(key);
  responseCache.set(key, response);
  if (responseCache.size > RESPONSE_CACHE_MAX) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
}

/**
 * Client-fetch a TRQL query from the metric resource route (like the dashboard
 * widgets): own loading state, interval + on-focus refresh, abort on change/unmount.
 *
 * Successful results are cached per query signature, so a chart that remounts (tab switch, or
 * back-navigation to the queues list) shows its last data immediately and revalidates in the
 * background rather than flashing a loading skeleton.
 */
/**
 * An empty query means the caller has nothing to ask for, so no request is made and any rows or
 * failure left by a previous query are dropped — a caller that stops asking must not keep reading
 * the last answer, or a stale failure would outlive the query that caused it.
 */
export function useMetricResourceQuery(query: string, opts: MetricResourceQueryOptions) {
  const {
    organizationId,
    projectId,
    environmentId,
    defaultPeriod,
    fillGaps,
    minBucketSeconds,
    refreshIntervalMs = 60_000,
    refetchOnFocus = true,
    userAuthoredQuery,
  } = opts;
  const { period, from, to } = opts.timeRange;
  const queuesKey = opts.queues && opts.queues.length > 0 ? opts.queues.join(",") : undefined;
  const resolvedPeriod = period ?? (from || to ? null : defaultPeriod);
  const cacheKey = useMemo(
    () =>
      [
        organizationId,
        projectId,
        environmentId,
        resolvedPeriod ?? "",
        from ?? "",
        to ?? "",
        fillGaps ? 1 : 0,
        minBucketSeconds ?? "",
        queuesKey ?? "",
        query,
      ].join("|"),
    [
      organizationId,
      projectId,
      environmentId,
      resolvedPeriod,
      from,
      to,
      fillGaps,
      minBucketSeconds,
      queuesKey,
      query,
    ]
  );

  const [rows, setRows] = useState<MetricResourceRow[] | null>(
    () => responseCache.get(cacheKey)?.rows ?? null
  );
  const [isLoading, setIsLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [responseReceivedAt, setResponseReceivedAt] = useState<number | null>(null);
  const [lastSuccessfulResponseAt, setLastSuccessfulResponseAt] = useState<number | null>(null);
  const [timeRange, setTimeRange] = useState<MetricResourceRange | null>(
    () => responseCache.get(cacheKey)?.timeRange ?? null
  );
  const abortRef = useRef<AbortController | null>(null);
  const loadedKeyRef = useRef<string | null>(null);

  const load = useCallback(() => {
    if (!query) {
      abortRef.current?.abort();
      loadedKeyRef.current = cacheKey;
      setRows(null);
      setFailed(false);
      setResponseReceivedAt(null);
      setLastSuccessfulResponseAt(null);
      setTimeRange(null);
      setIsLoading(false);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // On a new query signature the rows and failure on screen belong to a different query. Paint
    // this key's cached rows if we have them (no skeleton on remount / back-navigation), otherwise
    // clear them so a genuinely new query shows a loading state instead of another query's data.
    // Interval and on-focus refreshes reuse the same signature, so they keep what's on screen.
    if (loadedKeyRef.current !== cacheKey) {
      loadedKeyRef.current = cacheKey;
      const cached = responseCache.get(cacheKey);
      setRows(cached?.rows ?? null);
      setFailed(false);
      setResponseReceivedAt(null);
      setLastSuccessfulResponseAt(null);
      setTimeRange(cached?.timeRange ?? null);
    }
    setIsLoading(true);
    fetch("/resources/metric", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        scope: "environment",
        period: resolvedPeriod,
        from,
        to,
        fillGaps: !!fillGaps,
        organizationId,
        projectId,
        environmentId,
        ...(minBucketSeconds !== undefined ? { minBucketSeconds } : {}),
        ...(queuesKey !== undefined ? { queues: queuesKey.split(",") } : {}),
        ...(userAuthoredQuery !== undefined ? { userAuthoredQuery } : {}),
      }),
      signal: controller.signal,
    })
      .then((res) => res.json() as Promise<MetricResourceResponse>)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.success) {
          cacheSet(cacheKey, { rows: data.data.rows, timeRange: data.data.timeRange });
          const receivedAt = Date.now();
          setRows(data.data.rows);
          setFailed(false);
          setResponseReceivedAt(receivedAt);
          setLastSuccessfulResponseAt(receivedAt);
          setTimeRange(data.data.timeRange);
        } else {
          setFailed(true);
          setResponseReceivedAt(null);
        }
        setIsLoading(false);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!controller.signal.aborted) {
          setFailed(true);
          setResponseReceivedAt(null);
          setIsLoading(false);
        }
      });
  }, [
    cacheKey,
    query,
    resolvedPeriod,
    from,
    to,
    fillGaps,
    minBucketSeconds,
    organizationId,
    projectId,
    environmentId,
    queuesKey,
    userAuthoredQuery,
  ]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  useInterval({
    interval: refreshIntervalMs,
    onLoad: false,
    onFocus: refetchOnFocus,
    callback: load,
  });

  return {
    rows: rows ?? [],
    isLoading,
    showLoading: isLoading && !rows,
    failed,
    responseReceivedAt,
    lastSuccessfulResponseAt,
    timeRange,
  };
}
