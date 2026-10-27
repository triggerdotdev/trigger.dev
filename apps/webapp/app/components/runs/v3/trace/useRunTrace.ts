import type { TaskRunStatus } from "@trigger.dev/database";
import { useEffect, useMemo, useRef } from "react";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useEventSource } from "~/hooks/useEventSource";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProgressiveTrace, type ProgressiveTraceInput } from "~/hooks/useProgressiveTrace";
import { useProject } from "~/hooks/useProject";
import { useRunStatusBackstop } from "~/hooks/useRunStatusBackstop";
import { v3RunStatusPath, v3RunStreamingPath, v3RunTraceChunkPath } from "~/utils/pathBuilder";
import { settleUnloadedRoot } from "./settleUnloadedRoot";
import { getTraceStatus } from "./traceStatus";
import { useThrottledRefresh } from "./useThrottledRefresh";

// Coarse on purpose: the tail normally flips the root to terminal itself.
const RUN_STATUS_BACKSTOP_POLL_MS = 15_000;
const INSPECTOR_REFRESH_MS = 5_000;

// Tail path: no size cap. Keeps tailing while the root still looks unfinished, so
// final rows that become visible late still land, but not long after completion.
const LIVE_TAIL_UNRESOLVED_ROOT_MS = 5 * 60_000;

type RootSpanStatus = "executing" | "completed" | "failed";

export type RunTraceRun = {
  friendlyId: string;
  status: TaskRunStatus;
  isFinished: boolean;
  startedAt: string | null;
  /** completedAt, or updatedAt for final runs without one. */
  finishedAt: string | null;
};

export type RunTraceInput = ProgressiveTraceInput & {
  queuedDuration?: number;
  isTruncated?: boolean;
  missingAnchor?: boolean;
};

function msSinceFinished(run: { finishedAt: string | null }): number | null {
  return run.finishedAt ? Date.now() - new Date(run.finishedAt).getTime() : null;
}

function shouldLiveReload(run: { finishedAt: string | null }, rootSpanStatus: RootSpanStatus) {
  const sinceFinished = msSinceFinished(run);
  if (sinceFinished === null || sinceFinished < 30_000) return true;
  return rootSpanStatus === "executing" && sinceFinished < LIVE_TAIL_UNRESOLVED_ROOT_MS;
}

// Legacy path (live tail off): revalidate on ping, with the old size cap.
function shouldLiveReloadLegacy({
  eventCount,
  maximumLiveReloadingSetting,
  run,
}: {
  eventCount: number;
  maximumLiveReloadingSetting: number;
  run: { finishedAt: string | null };
}): boolean {
  if (eventCount > maximumLiveReloadingSetting) return false;
  if (run.finishedAt && new Date(run.finishedAt).getTime() < Date.now() - 30_000) return false;
  return true;
}

/**
 * One run's trace: progressive load, live tail and status. Calls `onRunDataStale` when the
 * page's run data needs reloading (the run started or finished, or a legacy-path ping).
 */
export function useRunTrace({
  run,
  trace,
  errorsOnly,
  maximumLiveReloadingSetting,
  onRunDataStale,
  readContext,
}: {
  run: RunTraceRun;
  trace: RunTraceInput;
  errorsOnly: boolean;
  maximumLiveReloadingSetting: number;
  onRunDataStale: () => void;
  /** Sent with every chunk read; "session" bounds completed runs' reads. */
  readContext?: "session";
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const { isTruncated = false, missingAnchor = false } = trace;

  const chunkPath = v3RunTraceChunkPath(organization, project, environment, run, {
    context: readContext,
  });
  const statusPath = v3RunStatusPath(organization, project, environment, run);
  const {
    events,
    duration,
    rootSpanStatus,
    rootStartedAt,
    overridesBySpanId,
    linkedRunIdBySpanId,
    isComplete,
    isTruncated: progressiveIsTruncated,
    loadFailed,
    tailLive,
    liveTailEnabled,
    retryLoad,
  } = useProgressiveTrace(trace, chunkPath, errorsOnly);

  const traceIsTruncated = isTruncated || progressiveIsTruncated;

  // The page data still shows the run unfinished, so a finish reload is useful.
  const runDataUnfinished = !run.isFinished && run.finishedAt === null;

  // Display only: live reload and finish detection keep using the unsettled root.
  const settled = useMemo(
    () =>
      settleUnloadedRoot({
        events,
        duration,
        rootSpanStatus,
        run: { status: run.status, finishedAt: run.finishedAt },
      }),
    [events, duration, rootSpanStatus, run.status, run.finishedAt]
  );

  // Tail path (flag on): delta-fetch per signal, skipped for truncated or partly
  // failed trees. Legacy path: revalidate per signal, with the old size cap.
  const isLiveReloading = liveTailEnabled
    ? shouldLiveReload(run, rootSpanStatus) && !traceIsTruncated && !loadFailed
    : shouldLiveReloadLegacy({
        eventCount: events.length,
        maximumLiveReloadingSetting,
        run,
      });

  const traceStatus = getTraceStatus({
    // Same rule as live reload: only a finished time means the run is done.
    runFinished: run.finishedAt !== null,
    rootSpanStatus,
    isComplete,
    isTruncated: traceIsTruncated,
    missingAnchor,
    loadFailed,
    isLiveReloading,
    liveTailEnabled,
    maximumLiveReloadingSetting,
  });

  // The callback's identity is unstable, so effects read it from a ref.
  const onRunDataStaleRef = useRef(onRunDataStale);
  useEffect(() => {
    onRunDataStaleRef.current = onRunDataStale;
  });

  const streamedEvents = useEventSource(
    v3RunStreamingPath(organization, project, environment, run),
    {
      event: "message",
      // The background load owns loading until it completes.
      disabled: !isLiveReloading || !isComplete,
    }
  );
  // On each stream message (a trace change or the 5s heartbeat): tail the delta, or
  // reload the run data on the legacy path.
  useEffect(() => {
    if (streamedEvents === null) return;
    if (liveTailEnabled) {
      tailLive();
    } else {
      onRunDataStaleRef.current();
    }
  }, [streamedEvents, liveTailEnabled, tailLive]);

  // Tail path: refresh run-row-fed controls once the root span goes terminal, unless a
  // reload already brought the finished run (e.g. the backstop's).
  const prevRootSpanRef = useRef({ runId: run.friendlyId, status: rootSpanStatus });
  useEffect(() => {
    const previous = prevRootSpanRef.current;
    prevRootSpanRef.current = { runId: run.friendlyId, status: rootSpanStatus };
    if (!liveTailEnabled || previous.runId !== run.friendlyId) return;
    if (previous.status === "executing" && rootSpanStatus !== "executing" && runDataUnfinished) {
      onRunDataStaleRef.current();
    }
  }, [run.friendlyId, rootSpanStatus, liveTailEnabled, runDataUnfinished]);

  // Tail path backstop: reload when the run starts and when it finishes, even if the
  // tail missed the root's final row. Polls whatever the stream is doing, and keeps
  // reloading until the page data agrees (a reload can read a lagging replica).
  useRunStatusBackstop({
    enabled: liveTailEnabled && runDataUnfinished,
    statusPath,
    shouldSkip: () => document.visibilityState === "hidden",
    onStatus: (data) => {
      if (data.isFinished || data.completedAt !== null) {
        // The reload alone won't refresh the tree if the span count didn't change.
        tailLive();
        onRunDataStaleRef.current();
        return;
      }
      // Run started: reload once for the queued offset, retried until the page data has it.
      if (data.startedAt !== null && run.startedAt === null) {
        onRunDataStaleRef.current();
      }
    },
    pollMs: RUN_STATUS_BACKSTOP_POLL_MS,
  });

  // SSE is off during the background load, so pick up rows written meanwhile. Runs
  // even if live reload already stopped, as long as the run finished recently.
  const sinceFinished = msSinceFinished(run);
  const recentlyActive = sinceFinished === null || sinceFinished < LIVE_TAIL_UNRESOLVED_ROOT_MS;
  const prevIsCompleteRef = useRef(isComplete);
  useEffect(() => {
    const wasComplete = prevIsCompleteRef.current;
    prevIsCompleteRef.current = isComplete;
    if (!liveTailEnabled || wasComplete || !isComplete) return;
    if (recentlyActive && !traceIsTruncated && !loadFailed) {
      tailLive();
    }
  }, [isComplete, recentlyActive, traceIsTruncated, loadFailed, liveTailEnabled, tailLive]);

  // Tail path: the inspector loads separately, so reload it when the tree changes. After
  // the background load, rebuilds come from the tail or a revalidate merge.
  const inspectorRefreshKey = useThrottledRefresh(events, {
    enabled: liveTailEnabled && isLiveReloading && isComplete,
    intervalMs: INSPECTOR_REFRESH_MS,
  });

  return {
    /** Display events: a finished run's root is settled while its completion row is missing. */
    events: settled.events,
    duration: settled.duration,
    rootSpanStatus: settled.rootSpanStatus,
    rootStartedAt,
    overridesBySpanId,
    linkedRunIdBySpanId,
    traceStatus,
    retryLoad,
    inspectorRefreshKey,
  };
}
