import type { TaskRunStatus } from "@trigger.dev/database";
import { tryCatch } from "@trigger.dev/core/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TraceEvent } from "~/components/runs/v3/trace/types";
import { type RunTraceInput, useRunTrace } from "~/components/runs/v3/trace/useRunTrace";
import { useEnvironment } from "~/hooks/useEnvironment";
import { MAX_PROGRESSIVE_SPANS } from "~/hooks/useProgressiveTrace";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type { RunTraceStart } from "~/presenters/v3/TraceChunkPresenter.server";
import { v3RunTraceChunkPath } from "~/utils/pathBuilder";
import { isFinalRunStatus } from "~/v3/taskStatus";
import type { RunPanelData } from "./sessionPanelStore";
import type { SessionRunLoad, SessionRunLoadOutcome } from "./sessionRunLoads";
import type { SessionTraceRun } from "./sessionTraceTypes";

// Only read on the legacy live path, which session reads never take (their first chunk tails).
const LEGACY_LIVE_RELOAD_LIMIT = 0;

/** What a run's loaded trace contributes to the session tree. */
export type RunTraceSnapshot = {
  events: TraceEvent[];
  duration: number;
  rootStartedAt: Date | string | undefined;
};

type StartedTrace = { kind: "progressive" | "empty"; trace: RunTraceInput };

type RunTraceSourceProps = {
  run: SessionTraceRun & { status: TaskRunStatus };
  load: SessionRunLoad;
  live: boolean;
  /** The tab is hidden: live tails wait until it's shown again. */
  paused: boolean;
  /** Errors only is on: a run that isn't fully loaded also reads its errors from the server. */
  errorsOnly: boolean;
  /** A deep-linked span: the first chunk includes it and its parents even past the first page. */
  selectedSpanId?: string;
  onSettle: (runFriendlyId: string, loadId: number, outcome: SessionRunLoadOutcome) => void;
  onSnapshot: (runFriendlyId: string, snapshot: RunTraceSnapshot | undefined) => void;
  onSpanCount: (runFriendlyId: string, count: number) => void;
  /** The spans the run's trace holds, as each chunk merges. */
  onLoadedSpans: (runFriendlyId: string, loaded: number) => void;
  /** Asked before each later page, with the spans held so far: the session span budget. */
  askPage: (runFriendlyId: string, loaded: number) => boolean;
  onPanelData: (runFriendlyId: string, data: RunPanelData | undefined) => void;
  onRunDataStale: () => void;
};

/** Loads one run's trace for the session tree. Renders nothing. */
export function RunTraceSource(props: RunTraceSourceProps) {
  const { run, load, selectedSpanId, onSettle } = props;
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const chunkPath = v3RunTraceChunkPath(organization, project, environment, run, {
    context: "session",
  });
  const [started, setStarted] = useState<StartedTrace | undefined>();

  const fetchLoadId = load.state === "loading" ? load.loadId : undefined;
  useEffect(() => {
    if (fetchLoadId === undefined) return;
    const controller = new AbortController();
    void fetchTraceStart(chunkPath, selectedSpanId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "progressive" || result.kind === "empty") {
        // Same JSON payload the run page loader sends; the hook reads its dates as strings.
        setStarted({ kind: result.kind, trace: result.trace as unknown as RunTraceInput });
        return;
      }
      onSettle(run.friendlyId, fetchLoadId, toOutcome(result));
    });
    return () => controller.abort();
  }, [fetchLoadId, chunkPath, selectedSpanId, run.friendlyId, onSettle]);

  if (!started) return null;
  return <RunTraceLive {...props} started={started} />;
}

function RunTraceLive({
  run,
  load,
  live,
  paused,
  errorsOnly,
  started,
  onSettle,
  onSnapshot,
  onSpanCount,
  onLoadedSpans,
  askPage,
  onPanelData,
  onRunDataStale,
}: RunTraceSourceProps & { started: StartedTrace }) {
  // A tail that lands after unmount must not count spans for a run that was freed.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onLoadedSpans(run.friendlyId, 0);
    };
  }, [run.friendlyId, onLoadedSpans]);

  // An in-place retry moves the load to a new attempt; it stays once the run settles.
  const [retryKey, setRetryKey] = useState(0);
  if (load.state === "paging" && load.attempt !== retryKey) setRetryKey(load.attempt);

  const trace = useRunTrace({
    run: {
      friendlyId: run.friendlyId,
      status: run.status,
      isFinished: isFinalRunStatus(run.status),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    trace: started.trace,
    errorsOnly,
    maximumLiveReloadingSetting: LEGACY_LIVE_RELOAD_LIMIT,
    onRunDataStale,
    readContext: "session",
    live,
    paused,
    canFetchPage: (loaded) => askPage(run.friendlyId, loaded),
    onLoadedSpans: (loaded) => {
      if (mounted.current) onLoadedSpans(run.friendlyId, loaded);
    },
    retryKey,
  });

  useEffect(() => {
    onSnapshot(run.friendlyId, {
      // Same cast as the run page: the tree renders the serialized event shape.
      events: trace.events as unknown as TraceEvent[],
      duration: trace.duration,
      rootStartedAt: trace.rootStartedAt,
    });
  }, [run.friendlyId, trace.events, trace.duration, trace.rootStartedAt, onSnapshot]);

  useEffect(() => () => onSnapshot(run.friendlyId, undefined), [run.friendlyId, onSnapshot]);

  const { inspectorRefreshKey, overridesBySpanId, linkedRunIdBySpanId } = trace;
  useEffect(() => {
    onPanelData(run.friendlyId, {
      refreshKey: inspectorRefreshKey,
      overridesBySpanId,
      linkedRunIdBySpanId,
    });
  }, [run.friendlyId, inspectorRefreshKey, overridesBySpanId, linkedRunIdBySpanId, onPanelData]);
  useEffect(() => () => onPanelData(run.friendlyId, undefined), [run.friendlyId, onPanelData]);

  // The run's root span is hidden, so only spans below it count as on screen.
  const spanCount = useMemo(
    () => trace.events.filter((event) => event.level > 0).length,
    [trace.events]
  );
  useEffect(() => {
    onSpanCount(run.friendlyId, spanCount);
  }, [spanCount, run.friendlyId, onSpanCount]);
  useEffect(() => () => onSpanCount(run.friendlyId, 0), [run.friendlyId, onSpanCount]);

  // A run keeps its load slot while later pages arrive.
  const inFlightLoadId =
    load.state === "loading" || load.state === "paging" ? load.loadId : undefined;
  const { isComplete, loadFailed, isTruncated } = trace;
  const noSpansYet = started.kind === "empty" && spanCount === 0;
  // Until the hook has restarted for a retry, its state still shows the failure.
  const currentAttempt = trace.loadAttempt === retryKey;
  const spanLimit = started.trace.progressive?.maxSpans ?? MAX_PROGRESSIVE_SPANS;
  useEffect(() => {
    if (inFlightLoadId === undefined || !currentAttempt) return;
    const outcome = settledOutcome({ isComplete, loadFailed, isTruncated, noSpansYet, spanLimit });
    if (outcome.state === "paging" && load.state === "paging") return;
    onSettle(run.friendlyId, inFlightLoadId, outcome);
  }, [
    inFlightLoadId,
    currentAttempt,
    isComplete,
    loadFailed,
    isTruncated,
    noSpansYet,
    spanLimit,
    load.state,
    run.friendlyId,
    onSettle,
  ]);

  return null;
}

// A page that kept failing stops the load; the spans already loaded stay on screen. A stop at
// the session budget settles from the page check first, so a truncation here is the run's cap.
export function settledOutcome({
  isComplete,
  loadFailed,
  isTruncated,
  noSpansYet,
  spanLimit,
}: {
  isComplete: boolean;
  loadFailed: boolean;
  isTruncated: boolean;
  noSpansYet: boolean;
  spanLimit: number;
}): SessionRunLoadOutcome {
  if (loadFailed)
    return { state: "error", message: "Some of this run's spans couldn't be loaded." };
  if (!isComplete) return { state: "paging" };
  if (isTruncated) return { state: "cutOff", limit: "run", started: true, spanLimit };
  return noSpansYet ? { state: "empty" } : { state: "progressive" };
}

type TraceStartResult = RunTraceStart | { kind: "failed"; message: string };

async function fetchTraceStart(
  chunkPath: string,
  selectedSpanId: string | undefined,
  signal: AbortSignal
): Promise<TraceStartResult> {
  const url = new URL(chunkPath, window.location.origin);
  url.searchParams.set("start", "1");
  if (selectedSpanId) url.searchParams.set("span", selectedSpanId);

  const [error, response] = await tryCatch(fetch(url, { signal }));
  if (error) return { kind: "failed", message: "Couldn't load this run's trace." };
  if (!response.ok) {
    return { kind: "failed", message: `Couldn't load this run's trace (${response.status}).` };
  }
  const [parseError, body] = await tryCatch(response.json() as Promise<RunTraceStart>);
  if (parseError) return { kind: "failed", message: "Couldn't read this run's trace." };
  return body;
}

function toOutcome(
  result: Exclude<TraceStartResult, { kind: "progressive" } | { kind: "empty" }>
): SessionRunLoadOutcome {
  switch (result.kind) {
    case "unavailable":
      return { state: "unavailable", reason: result.reason };
    case "logsDeleted":
      return { state: "logsDeleted" };
    case "failed":
      return { state: "error", message: result.message };
  }
}
