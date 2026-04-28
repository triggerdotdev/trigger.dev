import { useEffect, useMemo, useRef, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { type NextRunListItem } from "~/presenters/v3/NextRunListPresenter.server";
import { type loader as runsRefreshLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.refresh";
import { isFinalRunStatus } from "~/v3/taskStatus";

type UseRunsRowPollingOptions = {
  runs: NextRunListItem[];
  refreshUrl: string;
  intervalMs?: number;
};

const DEFAULT_INTERVAL_MS = 3000;

/**
 * Polls the runs.refresh resource route for the visible non-terminal rows
 * and returns a map of overrides keyed by internal run id. Consumers should
 * merge the overrides on top of the loader's runs array.
 *
 * The hook pauses when the tab is hidden and triggers an immediate fetch
 * when it becomes visible again.
 */
export function useRunsRowPolling({
  runs,
  refreshUrl,
  intervalMs = DEFAULT_INTERVAL_MS,
}: UseRunsRowPollingOptions): Map<string, NextRunListItem> {
  const fetcher = useTypedFetcher<typeof runsRefreshLoader>();
  const [overrides, setOverrides] = useState<Map<string, NextRunListItem>>(() => new Map());

  // Compute pollable IDs against the *merged* view, so that once an override
  // flips a row to a terminal status, we stop polling it.
  const nonTerminalIds = useMemo(() => {
    const ids: string[] = [];
    for (const run of runs) {
      const merged = overrides.get(run.id) ?? run;
      if (!isFinalRunStatus(merged.status)) {
        ids.push(merged.id);
      }
    }
    ids.sort();
    return ids;
  }, [runs, overrides]);

  const idsKey = nonTerminalIds.join(",");

  // Drop overrides for IDs that are no longer visible to keep the map bounded.
  useEffect(() => {
    setOverrides((prev) => {
      if (prev.size === 0) return prev;
      const visibleIds = new Set(runs.map((r) => r.id));
      let changed = false;
      const next = new Map<string, NextRunListItem>();
      for (const [id, run] of prev) {
        if (visibleIds.has(id)) {
          next.set(id, run);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [runs]);

  // Apply incoming fetcher data to the overrides map.
  const lastAppliedDataRef = useRef<unknown>(null);
  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data === lastAppliedDataRef.current) return;
    lastAppliedDataRef.current = fetcher.data;
    const incoming = fetcher.data.runs;
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const run of incoming) {
        next.set(run.id, run);
      }
      return next;
    });
  }, [fetcher.data]);

  // Schedule polling.
  useEffect(() => {
    if (!idsKey) return;
    if (typeof document === "undefined") return;

    const tick = () => {
      if (fetcher.state !== "idle") return;
      if (document.visibilityState !== "visible") return;
      fetcher.load(`${refreshUrl}?ids=${idsKey}`);
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        tick();
      }
    };

    const intervalId = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [idsKey, refreshUrl, intervalMs]);

  return overrides;
}
