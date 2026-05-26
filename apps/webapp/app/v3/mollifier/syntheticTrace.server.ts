import { millisecondsToNanoseconds } from "@trigger.dev/core/v3";
import { createTreeFromFlatItems, flattenTree } from "~/components/primitives/TreeView/TreeView";
import { createTimelineSpanEventsFromSpanEvents } from "~/utils/timelineSpanEvents";
import type { SpanSummary } from "~/v3/eventRepository/eventRepository.types";
import type { SyntheticRun } from "./readFallback.server";

// Build a single-span trace for a buffered run so the run-detail page
// renders a meaningful timeline before the drainer materialises the
// row. Mirrors the shape produced by `RunPresenter` when its trace
// store lookup returns no spans, so the dashboard consumer treats the
// buffered run identically to a freshly enqueued PG run that hasn't
// emitted any events yet.
export function buildSyntheticTraceForBufferedRun(run: SyntheticRun) {
  const spanId = run.spanId ?? "";
  const isCancelled = run.status === "CANCELED";
  const span: SpanSummary = {
    id: spanId,
    parentId: run.parentSpanId,
    runId: run.friendlyId,
    data: {
      message: run.taskIdentifier ?? "Task",
      style: { icon: "task", variant: "primary" },
      events: [],
      startTime: run.createdAt,
      duration: 0,
      isError: false,
      isPartial: !isCancelled,
      isCancelled,
      isDebug: false,
      level: "TRACE",
    },
  };

  const tree = createTreeFromFlatItems([span], spanId);
  const treeRootStartTimeMs = tree?.data.startTime.getTime() ?? 0;
  const totalDuration = Math.max(tree?.data.duration ?? 0, millisecondsToNanoseconds(1));

  const events = tree
    ? flattenTree(tree).map((n) => {
        const offset = millisecondsToNanoseconds(
          n.data.startTime.getTime() - treeRootStartTimeMs
        );
        return {
          ...n,
          data: {
            ...n.data,
            timelineEvents: createTimelineSpanEventsFromSpanEvents(n.data.events, false, treeRootStartTimeMs),
            duration: n.data.isPartial ? null : n.data.duration,
            offset,
            isRoot: n.id === spanId,
          },
        };
      })
    : [];

  return {
    rootSpanStatus: (isCancelled ? "completed" : "executing") as "executing" | "completed" | "failed",
    events,
    duration: totalDuration,
    rootStartedAt: tree?.data.startTime,
    startedAt: null,
    queuedDuration: undefined,
    overridesBySpanId: undefined,
    linkedRunIdBySpanId: {} as Record<string, string>,
  };
}
