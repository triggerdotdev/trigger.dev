import { millisecondsToNanoseconds } from "@trigger.dev/core/v3";
import type { TraceTimelineScale } from "~/components/runs/v3/trace/timelineScale";
import { isFinalRunStatus } from "~/v3/taskStatus";
import type { SessionTraceRun } from "./sessionTraceTypes";
import { isRunStarting } from "./sessionRunFallback";

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

/**
 * The session's newest run, finished or not, when it's loaded. Its trace keeps live updates on
 * so the tail can pick up late rows after it finishes; older runs never tail.
 */
export function newestRunFriendlyId(
  runs: SessionTraceRun[],
  totalCount: number
): string | undefined {
  const newest = newestRun(runs);
  if (!newest || newest.number < totalCount) return undefined;
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

/** While the newest run is live or finished in the last 10 minutes, new runs are likely soon. */
export const RECENT_RUN_POLL_MS = 10_000;
/** Sessions almost never close, so a quiet session still checks for a new run now and then. */
export const QUIET_SESSION_POLL_MS = 60_000;
const RECENTLY_FINISHED_MS = 10 * 60_000;

/** How often to re-read the newest runs page. */
export function newRunsPollIntervalMs(
  runs: SessionTraceRun[],
  totalCount: number,
  nowMs: number
): number {
  if (liveRunFriendlyId(runs, totalCount)) return RECENT_RUN_POLL_MS;
  const newest = newestRun(runs);
  // No runs yet: the session was just created and its first run is about to start.
  if (!newest) return RECENT_RUN_POLL_MS;
  // Not in the run store yet: it was just triggered and is about to start. Past the window it
  // shows as unavailable and gets the quiet rate.
  if (!newest.status) {
    return isRunStarting(newest, nowMs) ? RECENT_RUN_POLL_MS : QUIET_SESSION_POLL_MS;
  }
  if (!newest.finishedAt) return QUIET_SESSION_POLL_MS;
  return nowMs - new Date(newest.finishedAt).getTime() < RECENTLY_FINISHED_MS
    ? RECENT_RUN_POLL_MS
    : QUIET_SESSION_POLL_MS;
}
