import { useLocation, useNavigation } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { isLogsPage, LogsSearchAnalytics, logsSearchKey } from "~/utils/logsSearchAnalytics";
import { usePostHogTracking } from "./usePostHog";

type SearchData = {
  logs: unknown[];
  filters?: { from: Date; to: Date };
  searchProgress: {
    complete: boolean;
    timedOut: boolean;
    stopped: boolean;
    expired: boolean;
    queryElapsedMs: number;
  };
};

export function reportLogsSearchResponse(
  analytics: LogsSearchAnalytics,
  key: string,
  data: SearchData
) {
  analytics.response(key, {
    resultCount: data.logs.length,
    complete: data.searchProgress.complete,
    timedOut: data.searchProgress.timedOut,
    stopped: data.searchProgress.stopped,
    expired: data.searchProgress.expired,
    queryElapsedMs: data.searchProgress.queryElapsedMs,
    rangeDurationMs: data.filters
      ? data.filters.to.getTime() - data.filters.from.getTime()
      : undefined,
  });
}

export function useLogsSearchAnalytics(
  data: Promise<SearchData | { error: string }>,
  requestFilterState: string
) {
  const { capture } = usePostHogTracking();
  const [analytics] = useState(() => new LogsSearchAnalytics(capture));
  useLogsSearchLifecycle(analytics, data, requestFilterState);
  return analytics;
}

export function useLogsSearchLifecycle(
  analytics: LogsSearchAnalytics,
  data: Promise<SearchData | { error: string }>,
  requestFilterState: string
) {
  const location = useLocation();
  const navigation = useNavigation();
  const committedKey = logsSearchKey(location.pathname, location.search);
  const pendingNavigation = useRef<{ key: string; startedAt: number }>();

  useEffect(() => {
    if (navigation.location && isLogsPage(navigation.location.pathname)) {
      const key = logsSearchKey(navigation.location.pathname, navigation.location.search);
      if (key !== committedKey && pendingNavigation.current?.key !== key) {
        pendingNavigation.current = { key, startedAt: performance.now() };
      }
    } else if (navigation.state === "idle" && pendingNavigation.current?.key !== committedKey) {
      pendingNavigation.current = undefined;
    }
  }, [committedKey, navigation.location, navigation.state]);

  useEffect(() => {
    if (!isLogsPage(location.pathname)) return;
    const startedAt =
      pendingNavigation.current?.key === committedKey
        ? pendingNavigation.current.startedAt
        : undefined;
    analytics.start(committedKey, location.search, startedAt);
    pendingNavigation.current = undefined;
  }, [analytics, committedKey, location.pathname, location.search]);

  useEffect(() => {
    if (committedKey !== requestFilterState) return;
    let cancelled = false;
    void Promise.resolve(data).then(
      (result) => {
        if (cancelled) return;
        if ("error" in result) analytics.result(requestFilterState, "error");
        else reportLogsSearchResponse(analytics, requestFilterState, result);
      },
      () => {
        if (!cancelled) analytics.result(requestFilterState, "error");
      }
    );
    return () => {
      cancelled = true;
    };
  }, [analytics, data, requestFilterState, committedKey]);

  useEffect(() => {
    const leave = (event: PageTransitionEvent) => {
      if (!event.persisted) analytics.leave();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      analytics.leave();
    };
  }, [analytics]);
}
