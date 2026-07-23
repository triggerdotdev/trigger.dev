import { useCallback, useEffect, useRef, useState } from "react";
import { useInterval } from "./useInterval";

export type MetricResourceRow = Record<string, number | string | null>;

type MetricResourceResponse =
  | { success: true; data: { rows: MetricResourceRow[] } }
  | { success: false; error: string };

export type MetricResourceTimeRange = {
  period: string | null;
  from: string | null;
  to: string | null;
};

export type MetricResourceQueryOptions = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  timeRange: MetricResourceTimeRange;
  defaultPeriod: string;
  queues?: string[];
  fillGaps?: boolean;
  refreshIntervalMs?: number;
};

/**
 * Client-fetch a TRQL query from the metric resource route (like the dashboard
 * widgets): own loading state, interval + on-focus refresh, abort on change/unmount.
 */
export function useMetricResourceQuery(query: string, opts: MetricResourceQueryOptions) {
  const [rows, setRows] = useState<MetricResourceRow[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const {
    organizationId,
    projectId,
    environmentId,
    defaultPeriod,
    fillGaps,
    refreshIntervalMs = 60_000,
  } = opts;
  const { period, from, to } = opts.timeRange;
  const queuesKey = opts.queues && opts.queues.length > 0 ? opts.queues.join(",") : undefined;

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    fetch("/resources/metric", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        scope: "environment",
        period: period ?? (from || to ? null : defaultPeriod),
        from,
        to,
        fillGaps: !!fillGaps,
        organizationId,
        projectId,
        environmentId,
        ...(queuesKey !== undefined ? { queues: queuesKey.split(",") } : {}),
      }),
      signal: controller.signal,
    })
      .then((res) => res.json() as Promise<MetricResourceResponse>)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.success) {
          setRows(data.data.rows);
          setFailed(false);
        } else {
          setFailed(true);
        }
        setIsLoading(false);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!controller.signal.aborted) {
          setFailed(true);
          setIsLoading(false);
        }
      });
  }, [
    query,
    period,
    from,
    to,
    defaultPeriod,
    fillGaps,
    organizationId,
    projectId,
    environmentId,
    queuesKey,
  ]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  useInterval({
    interval: refreshIntervalMs,
    onLoad: false,
    onFocus: true,
    pauseWhenHidden: true,
    callback: load,
  });

  return { rows: rows ?? [], isLoading, showLoading: isLoading && !rows, failed };
}
