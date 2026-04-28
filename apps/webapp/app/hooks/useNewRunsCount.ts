import { useEffect, useRef, useState } from "react";

type CountNewResponse = { count: number; hasMore: boolean };

type UseNewRunsCountOptions = {
  sinceId: string | undefined;
  countNewUrl: string;
  intervalMs?: number;
  disabled?: boolean;
};

const DEFAULT_INTERVAL_MS = 3000;

/**
 * Polls the runs.count-new resource route to count runs newer than the
 * top visible row. Uses a plain `fetch` rather than `useFetcher` so Remix's
 * automatic fetcher revalidation (e.g. from useAutoRevalidate in Live mode)
 * does not re-fire the request when the hook is disabled.
 */
export function useNewRunsCount({
  sinceId,
  countNewUrl,
  intervalMs = DEFAULT_INTERVAL_MS,
  disabled = false,
}: UseNewRunsCountOptions): { count: number; hasMore: boolean } {
  const [state, setState] = useState<CountNewResponse>({ count: 0, hasMore: false });
  const inFlightRef = useRef(false);

  // Reset baseline whenever the cursor or url changes, or when disabling.
  useEffect(() => {
    setState({ count: 0, hasMore: false });
  }, [sinceId, countNewUrl, disabled]);

  useEffect(() => {
    if (disabled) return;
    if (!sinceId) return;
    if (typeof document === "undefined") return;

    const url = appendSinceParam(countNewUrl, sinceId);
    let cancelled = false;
    const controller = new AbortController();

    const tick = async () => {
      if (inFlightRef.current) return;
      if (document.visibilityState !== "visible") return;
      inFlightRef.current = true;
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const data = (await res.json()) as CountNewResponse;
        if (!cancelled) {
          setState({ count: data.count, hasMore: data.hasMore });
        }
      } catch {
        // Ignore aborts and transient network errors; next tick will retry.
      } finally {
        inFlightRef.current = false;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        tick();
      }
    };

    const intervalId = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [sinceId, countNewUrl, intervalMs, disabled]);

  if (disabled || !sinceId) {
    return { count: 0, hasMore: false };
  }

  return state;
}

function appendSinceParam(url: string, sinceId: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}since=${encodeURIComponent(sinceId)}`;
}
