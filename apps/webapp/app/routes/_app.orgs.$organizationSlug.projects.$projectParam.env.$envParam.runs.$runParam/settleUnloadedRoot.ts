import type { TaskRunStatus } from "@trigger.dev/database";
import { isFailedRunStatus } from "~/v3/taskStatus";

type RootSpanStatus = "executing" | "completed" | "failed";

type SettleableEvent = {
  data: {
    startTime: Date | string;
    duration: number | null;
    isPartial: boolean;
    isError: boolean;
    isCancelled: boolean;
  };
};

type SettleInput<E extends SettleableEvent> = {
  events: E[];
  duration: number;
  rootSpanStatus: RootSpanStatus;
  run: { status: TaskRunStatus; completedAt: Date | string | null };
};

type Settled<E> = { events: E[]; duration: number; rootSpanStatus: RootSpanStatus };

function rootOutcome(
  status: TaskRunStatus
): { isError: boolean; isCancelled: boolean; rootSpanStatus: RootSpanStatus } | undefined {
  if (status === "COMPLETED_SUCCESSFULLY") {
    return { isError: false, isCancelled: false, rootSpanStatus: "completed" };
  }
  if (status === "CANCELED") {
    return { isError: false, isCancelled: true, rootSpanStatus: "completed" };
  }
  // Expired runs get an error completion row when they expire.
  if (status === "EXPIRED" || isFailedRunStatus(status)) {
    return { isError: true, isCancelled: false, rootSpanStatus: "failed" };
  }
  return undefined;
}

/** Ends a finished run's root at `completedAt` while its completion row is missing. */
export function settleUnloadedRoot<E extends SettleableEvent>(input: SettleInput<E>): Settled<E> {
  const { events, duration, rootSpanStatus, run } = input;
  const unchanged = { events, duration, rootSpanStatus };

  const root = events[0];
  if (!run.completedAt || rootSpanStatus !== "executing" || !root?.data.isPartial) {
    return unchanged;
  }

  const outcome = rootOutcome(run.status);
  if (!outcome) return unchanged;

  const rootDuration = Math.max(
    0,
    (new Date(run.completedAt).getTime() - new Date(root.data.startTime).getTime()) * 1_000_000
  );

  const settledRoot = {
    ...root,
    data: {
      ...root.data,
      isPartial: false,
      isError: outcome.isError,
      isCancelled: outcome.isCancelled,
      duration: rootDuration,
    },
  };

  return {
    events: [settledRoot, ...events.slice(1)],
    duration: Math.max(duration, rootDuration),
    rootSpanStatus: outcome.rootSpanStatus,
  };
}
