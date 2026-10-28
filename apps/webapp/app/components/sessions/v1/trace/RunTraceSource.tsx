import type { TaskRunStatus } from "@trigger.dev/database";
import { tryCatch } from "@trigger.dev/core/utils";
import { useEffect, useState } from "react";
import type { TraceEvent } from "~/components/runs/v3/trace/types";
import { type RunTraceInput, useRunTrace } from "~/components/runs/v3/trace/useRunTrace";
import { useEnvironment } from "~/hooks/useEnvironment";
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
  /** A deep-linked span: the first chunk includes it and its parents even past the first page. */
  selectedSpanId?: string;
  onSettle: (runFriendlyId: string, loadId: number, outcome: SessionRunLoadOutcome) => void;
  onSnapshot: (runFriendlyId: string, snapshot: RunTraceSnapshot | undefined) => void;
  onSpansChanged: (runFriendlyId: string, hasSpans: boolean) => void;
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
  started,
  onSettle,
  onSnapshot,
  onSpansChanged,
  onPanelData,
  onRunDataStale,
}: RunTraceSourceProps & { started: StartedTrace }) {
  const trace = useRunTrace({
    run: {
      friendlyId: run.friendlyId,
      status: run.status,
      isFinished: isFinalRunStatus(run.status),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    trace: started.trace,
    errorsOnly: false,
    maximumLiveReloadingSetting: LEGACY_LIVE_RELOAD_LIMIT,
    onRunDataStale,
    readContext: "session",
    live,
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
  const hasSpans = trace.events.some((event) => event.level > 0);
  useEffect(() => {
    onSpansChanged(run.friendlyId, hasSpans);
  }, [hasSpans, run.friendlyId, onSpansChanged]);
  useEffect(() => () => onSpansChanged(run.friendlyId, false), [run.friendlyId, onSpansChanged]);

  // A run keeps its load slot while later pages arrive.
  const inFlightLoadId =
    load.state === "loading" || load.state === "paging" ? load.loadId : undefined;
  const isComplete = trace.isComplete;
  const loadFailed = trace.traceStatus.kind === "failed";
  const noSpansYet = started.kind === "empty" && !hasSpans;
  useEffect(() => {
    if (inFlightLoadId === undefined) return;
    const outcome = settledOutcome(isComplete, loadFailed, noSpansYet);
    if (outcome.state === "paging" && load.state === "paging") return;
    onSettle(run.friendlyId, inFlightLoadId, outcome);
  }, [inFlightLoadId, isComplete, loadFailed, noSpansYet, load.state, run.friendlyId, onSettle]);

  return null;
}

// A page that kept failing stops the load; the spans already loaded stay on screen.
export function settledOutcome(
  isComplete: boolean,
  loadFailed: boolean,
  noSpansYet: boolean
): SessionRunLoadOutcome {
  if (loadFailed)
    return { state: "error", message: "Some of this run's spans couldn't be loaded." };
  if (!isComplete) return { state: "paging" };
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
