import { useLocation } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { useInterval } from "~/hooks/useInterval";
import type { NextRunListItem } from "~/presenters/v3/NextRunListPresenter.server";
import type { loader as liveRunsLoader } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.live";

const RUNS_SEARCH_PARAMS_TO_REMOVE = ["cursor", "direction", "bulkInspector", "action", "mode"];
const RUNS_POLL_INTERVAL_MS = 3000;
/** Check for new runs every N poll ticks (~6s at 3s interval). */
const NEW_RUNS_EVERY_N_POLL_TICKS = 2;

type ListedRun = NextRunListItem;
type LiveRunFields = Awaited<ReturnType<typeof liveRunsLoader>>["runs"][number];
type LivePollFetcherData = Awaited<ReturnType<typeof liveRunsLoader>> | undefined;

function hasNewRunsCountFields(
  data: LivePollFetcherData
): data is NonNullable<LivePollFetcherData> & { count: number; since: number } {
  return data !== undefined && "count" in data && "since" in data;
}

function maxCreatedAtMs(runs: ListedRun[]): number | undefined {
  if (runs.length === 0) return undefined;

  return runs.reduce<number>((maxTimestamp, run) => {
    const runTimestamp = new Date(run.createdAt).getTime();
    return Math.max(maxTimestamp, runTimestamp);
  }, 0);
}

function filterParamsWithoutPagination(search: string) {
  const params = new URLSearchParams(search);
  for (const key of RUNS_SEARCH_PARAMS_TO_REMOVE) {
    params.delete(key);
  }
  return params;
}

function getRunsSearchKeyWithoutPagination(search: string) {
  return filterParamsWithoutPagination(search).toString();
}

function isNewRunsCheckTick(tick: number) {
  return tick === 1 || tick % NEW_RUNS_EVERY_N_POLL_TICKS === 0;
}

function appendNewRunsSearchParams(
  searchParams: URLSearchParams,
  { locationSearch, since }: { locationSearch: string; since: number }
) {
  const filterParams = filterParamsWithoutPagination(locationSearch);
  for (const [key, value] of filterParams) {
    searchParams.append(key, value);
  }
  searchParams.set("includeNewRuns", "true");
  searchParams.set("since", String(since));
}

function patchVisibleRunsWithLiveUpdates(currentRuns: ListedRun[], liveRuns: LiveRunFields[]) {
  const updatesById = new Map(liveRuns.map((run) => [run.friendlyId, run]));

  return currentRuns.map((run) => {
    const update = updatesById.get(run.friendlyId);
    if (!update) return run;

    return {
      ...run,
      status: update.status,
      updatedAt: update.updatedAt,
      startedAt: update.startedAt,
      finishedAt: update.finishedAt,
      hasFinished: update.hasFinished,
      isCancellable: update.isCancellable,
      isPending: update.isPending,
      usageDurationMs: update.usageDurationMs,
      costInCents: update.costInCents,
      baseCostInCents: update.baseCostInCents,
    };
  });
}

function useNewRunsDetection({
  runs,
  hasAnyRuns,
  isLoading,
}: {
  runs: ListedRun[];
  hasAnyRuns: boolean;
  isLoading: boolean;
}) {
  const pollTickRef = useRef(0);
  const [knownNewestRunMs, setKnownNewestRunMs] = useState(() => maxCreatedAtMs(runs) ?? Date.now());
  const [newRunsCount, setNewRunsCount] = useState(0);

  const shouldPollForNewRuns = hasAnyRuns && !isLoading && newRunsCount < 100;

  // Re-baseline the cutoff and clear banner/throttle state. The parent calls
  // this from its single "list context changed" reset path.
  const resetNewRunsTracking = useCallback(() => {
    setKnownNewestRunMs(maxCreatedAtMs(runs) ?? Date.now());
    setNewRunsCount(0);
    pollTickRef.current = 0;
  }, [runs]);

  const dismissNewRuns = useCallback(() => {
    setNewRunsCount(0);
    setKnownNewestRunMs(Date.now());
    pollTickRef.current = 0;
  }, []);

  const checkNewRunsOnTick = useCallback(() => {
    pollTickRef.current += 1;
    return shouldPollForNewRuns && isNewRunsCheckTick(pollTickRef.current);
  }, [shouldPollForNewRuns]);

  const showNewRunsBanner = newRunsCount > 0;

  return {
    knownNewestRunMs,
    newRunsCount,
    setNewRunsCount,
    shouldPollForNewRuns,
    showNewRunsBanner,
    dismissNewRuns,
    checkNewRunsOnTick,
    resetNewRunsTracking,
  };
}

export function useRunsLiveReload({
  runs,
  hasAnyRuns,
  isLoading,
  organizationSlug,
  projectSlug,
  environmentSlug,
}: {
  runs: ListedRun[];
  hasAnyRuns: boolean;
  isLoading: boolean;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
}) {
  const location = useLocation();
  const runsPollFetcher = useTypedFetcher<typeof liveRunsLoader>();
  const runsPollFetcherStateRef = useRef(runsPollFetcher.state);
  runsPollFetcherStateRef.current = runsPollFetcher.state;

  const [visibleRuns, setVisibleRuns] = useState(runs);

  const searchKeyWithoutPagination = useMemo(
    () => getRunsSearchKeyWithoutPagination(location.search),
    [location.search]
  );

  const {
    knownNewestRunMs,
    newRunsCount,
    setNewRunsCount,
    shouldPollForNewRuns,
    showNewRunsBanner,
    dismissNewRuns,
    checkNewRunsOnTick,
    resetNewRunsTracking,
  } = useNewRunsDetection({
    runs,
    hasAnyRuns,
    isLoading,
  });

  // Single reset path: new loader data or changed filters re-baseline both the
  // visible rows and new-run tracking.
  useEffect(() => {
    setVisibleRuns(runs);
    resetNewRunsTracking();
  }, [runs, searchKeyWithoutPagination, resetNewRunsTracking]);

  // Patch visible rows from the live response. Keyed to the response alone so a
  // loader refresh never re-applies a stale poll payload over fresh rows.
  useEffect(() => {
    const data = runsPollFetcher.data;
    if (!data?.runs.length) return;

    setVisibleRuns((currentRuns) => patchVisibleRunsWithLiveUpdates(currentRuns, data.runs));
  }, [runsPollFetcher.data]);

  // Update new-runs count from the poll response. Re-evaluates when the cutoff
  // changes, even if the response object itself is unchanged.
  useEffect(() => {
    const data = runsPollFetcher.data;
    if (!hasNewRunsCountFields(data)) return;

    if (data.since === knownNewestRunMs) {
      setNewRunsCount(data.count);
    }
  }, [runsPollFetcher.data, knownNewestRunMs, setNewRunsCount]);

  const activeRunIdsParam = useMemo(
    () =>
      visibleRuns
        .filter((run) => !run.hasFinished)
        .map((run) => run.friendlyId)
        .join(","),
    [visibleRuns]
  );
  const hasActiveRuns = activeRunIdsParam.length > 0;

  const runsResourcesBasePath = useMemo(
    () =>
      `/resources/orgs/${organizationSlug}/projects/${projectSlug}/env/${environmentSlug}/runs`,
    [organizationSlug, projectSlug, environmentSlug]
  );

  const loadRunsPoll = useCallback(
    (checkForNewRuns: boolean) => {
      if (runsPollFetcherStateRef.current !== "idle") return;

      if (!hasActiveRuns && !checkForNewRuns) return;

      const searchParams = new URLSearchParams();
      if (hasActiveRuns) {
        searchParams.set("runIds", activeRunIdsParam);
      }

      if (checkForNewRuns) {
        appendNewRunsSearchParams(searchParams, {
          locationSearch: location.search,
          since: knownNewestRunMs,
        });
      }

      runsPollFetcher.load(`${runsResourcesBasePath}/live?${searchParams.toString()}`);
    },
    [
      activeRunIdsParam,
      hasActiveRuns,
      location.search,
      knownNewestRunMs,
      runsPollFetcher,
      runsResourcesBasePath,
    ]
  );

  const shouldPoll = !isLoading && (hasActiveRuns || shouldPollForNewRuns);

  useInterval({
    interval: RUNS_POLL_INTERVAL_MS,
    onLoad: true,
    pauseWhenHidden: true,
    disabled: !shouldPoll,
    callback: () => {
      loadRunsPoll(checkNewRunsOnTick());
    },
  });

  return {
    visibleRuns,
    showNewRunsBanner,
    newRunsCount,
    dismissNewRuns,
    childrenStatusesBasePath: runsResourcesBasePath,
  };
}
