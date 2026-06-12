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
  const isFailed = run.status === "FAILED";
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
      isError: isFailed,
      // CANCELED and FAILED are terminal; only a still-queued buffered run
      // is partial. A partial failed span would otherwise render as
      // "executing" forever in the timeline.
      isPartial: !isCancelled && !isFailed,
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
        // Mirror RunPresenter: raw span events stay server-side, only
        // timelineEvents ship to the client.
        const { events: spanEvents, ...data } = n.data;
        return {
          ...n,
          data: {
            ...data,
            timelineEvents: createTimelineSpanEventsFromSpanEvents(spanEvents, false, treeRootStartTimeMs),
            duration: n.data.isPartial ? null : n.data.duration,
            offset,
            isRoot: n.id === spanId,
          },
        };
      })
    : [];

  return {
    // Matches RunPresenter's derivation: failed root span -> "failed",
    // otherwise a terminal (non-partial) span -> "completed", else
    // "executing". CANCELED is terminal-but-not-error, so "completed".
    rootSpanStatus: (isFailed ? "failed" : isCancelled ? "completed" : "executing") as
      | "executing"
      | "completed"
      | "failed",
    events,
    duration: totalDuration,
    rootStartedAt: tree?.data.startTime,
    startedAt: null,
    queuedDuration: undefined,
    overridesBySpanId: undefined,
    linkedRunIdBySpanId: {} as Record<string, string>,
  };
}
