import { millisecondsToNanoseconds } from "@trigger.dev/core/v3";
import type { TraceTimelineScale } from "~/components/runs/v3/trace/timelineScale";
import { isFinalRunStatus } from "~/v3/taskStatus";
import type { SessionTraceRun } from "./sessionTraceTypes";

/** How long a run has executed, from its start to its finish (or now while it runs). */
export function runDuration(
  run: Pick<SessionTraceRun, "startedAt" | "finishedAt">,
  nowMs: number
): { ms: number; finished: boolean } | undefined {
  if (!run.startedAt) return undefined;
  const endMs = run.finishedAt ? new Date(run.finishedAt).getTime() : nowMs;
  return { ms: Math.max(0, endMs - new Date(run.startedAt).getTime()), finished: !!run.finishedAt };
}

/**
 * A run's own timeline scale, with queue time taken off. Long runs store a root span with
 * duration 0, so the run's recorded finish time stretches the scale when it's later than the
 * trace's last span.
 */
export function runTimelineScale({
  run,
  traceDurationNs,
  rootStartedAt,
  nowMs,
}: {
  run: Pick<SessionTraceRun, "startedAt" | "finishedAt">;
  traceDurationNs: number;
  rootStartedAt: Date | string | undefined;
  nowMs: number;
}): TraceTimelineScale {
  if (!rootStartedAt) return { durationNs: traceDurationNs, queuedDurationNs: undefined };

  const rootStartMs = new Date(rootStartedAt).getTime();
  const endMs = run.finishedAt ? new Date(run.finishedAt).getTime() : nowMs;
  const totalNs = Math.max(traceDurationNs, millisecondsToNanoseconds(endMs - rootStartMs));
  const queuedDurationNs = run.startedAt
    ? millisecondsToNanoseconds(Math.max(0, new Date(run.startedAt).getTime() - rootStartMs))
    : undefined;

  return {
    durationNs: Math.max(0, totalNs - (queuedDurationNs ?? 0)),
    queuedDurationNs: queuedDurationNs || undefined,
  };
}

/**
 * The session's newest run, if it hasn't reached a final status. Older unfinished runs are never
 * live, so nothing is when a newer run exists but isn't loaded yet.
 */
export function liveRunFriendlyId(runs: SessionTraceRun[], totalCount: number): string | undefined {
  const newest = newestRun(runs);
  if (!newest?.status || newest.number < totalCount || isFinalRunStatus(newest.status)) {
    return undefined;
  }
  return newest.friendlyId;
}

/** The run expanded when the tab opens: the live run, else the newest loaded. */
export function initiallyExpandedRunFriendlyId(
  runs: SessionTraceRun[],
  totalCount: number
): string | undefined {
  return liveRunFriendlyId(runs, totalCount) ?? newestRun(runs)?.friendlyId;
}

function newestRun(runs: SessionTraceRun[]) {
  let newest: SessionTraceRun | undefined;
  for (const run of runs) {
    if (!newest || run.number > newest.number) newest = run;
  }
  return newest;
}
