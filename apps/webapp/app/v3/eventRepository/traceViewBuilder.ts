import { millisecondsToNanoseconds } from "@trigger.dev/core/v3";
import type {
  AttemptFailedSpanEvent,
  ExceptionSpanEvent,
  SpanEvents,
} from "@trigger.dev/core/v3/schemas";
import { createTreeFromFlatItems, flattenTree } from "~/components/primitives/TreeView/TreeView";
import { createTimelineSpanEventsFromSpanEvents } from "~/utils/timelineSpanEvents";
import type { SpanOverride, SpanSummary } from "./eventRepository.types";

function calculateEndTimeFromStartTime(startTime: Date, duration: number): Date {
  return new Date(startTime.getTime() + duration / 1_000_000);
}

function calculateDurationFromStartJsDate(startTime: Date, endTime: Date): number {
  return (endTime.getTime() - startTime.getTime()) * 1_000_000;
}

function cloneSpan(span: SpanSummary): SpanSummary {
  return {
    ...span,
    data: {
      ...span.data,
      events: [...span.data.events],
    },
  };
}

function applyAncestorToSpan(
  span: SpanSummary,
  overrideSpan: SpanSummary,
  overridesBySpanId: Record<string, SpanOverride>
): void {
  if (overridesBySpanId[span.id]) {
    return;
  }

  let override: SpanOverride | undefined = undefined;

  const overrideEndTime = calculateEndTimeFromStartTime(
    overrideSpan.data.startTime,
    overrideSpan.data.duration
  );

  if (overrideSpan.data.isCancelled) {
    override = {
      isCancelled: true,
      duration: calculateDurationFromStartJsDate(span.data.startTime, overrideEndTime),
    };

    span.data.isCancelled = true;
    span.data.isPartial = false;
    span.data.isError = false;
    span.data.duration = calculateDurationFromStartJsDate(span.data.startTime, overrideEndTime);

    const cancellationEvent = overrideSpan.data.events.find(
      (event) => event.name === "cancellation"
    );

    if (cancellationEvent) {
      span.data.events.push(cancellationEvent);
      override.events = [cancellationEvent];
    }
  }

  if (overrideSpan.data.isError && span.data.attemptNumber) {
    const attemptFailedEvent = overrideSpan.data.events.find(
      (event) =>
        event.name === "attempt_failed" &&
        event.properties.attemptNumber === span.data.attemptNumber &&
        event.properties.runId === span.runId
    ) as AttemptFailedSpanEvent | undefined;

    if (attemptFailedEvent) {
      const exceptionEvent = {
        name: "exception",
        time: attemptFailedEvent.time,
        properties: {
          exception: attemptFailedEvent.properties.exception,
        },
      } satisfies ExceptionSpanEvent;

      span.data.isError = true;
      span.data.isPartial = false;
      span.data.isCancelled = false;
      span.data.duration = calculateDurationFromStartJsDate(span.data.startTime, overrideEndTime);
      span.data.events.push(exceptionEvent);
      span.data.events.push(attemptFailedEvent);

      override = {
        isError: true,
        events: [exceptionEvent],
        duration: calculateDurationFromStartJsDate(span.data.startTime, overrideEndTime),
      };
    }
  }

  if (override) {
    overridesBySpanId[span.id] = override;
  }
}

export function applyAncestorOverrides(rawSpans: SpanSummary[]): {
  spans: SpanSummary[];
  overridesBySpanId: Record<string, SpanOverride>;
} {
  const spans = rawSpans.map(cloneSpan);
  const spansById = new Map<string, SpanSummary>(spans.map((span) => [span.id, span]));
  const overridesBySpanId: Record<string, SpanOverride> = {};

  for (const span of spans) {
    if (span.data.level !== "TRACE" || !span.data.isPartial || !span.parentId) {
      continue;
    }

    let parentSpanId: string | undefined = span.parentId;
    let overrideSpan: SpanSummary | undefined;

    while (parentSpanId) {
      const parentSpan = spansById.get(parentSpanId);
      if (!parentSpan) {
        break;
      }
      if (parentSpan.data.level === "TRACE" && !parentSpan.data.isPartial) {
        overrideSpan = parentSpan;
        break;
      }
      parentSpanId = parentSpan.parentId;
    }

    if (overrideSpan) {
      applyAncestorToSpan(span, overrideSpan, overridesBySpanId);
    }
  }

  return { spans, overridesBySpanId };
}

export type BuildTraceViewOptions = {
  rootSpanId: string;
  runFriendlyId: string;
  isAgentRun: boolean;
  isAdmin: boolean;
  isRootSpanId?: string;
};

export type TraceViewEvent = ReturnType<typeof buildTraceEvents>["events"][number];

export type TraceViewResult = {
  events: TraceViewEvent[];
  duration: number;
  rootStartedAt: Date | undefined;
  rootSpanStatus: "executing" | "completed" | "failed";
  rootSpanId: string;
  linkedRunIdBySpanId: Record<string, string>;
  missingAnchor: boolean;
};

function buildTraceEvents(spans: SpanSummary[], options: BuildTraceViewOptions) {
  const { rootSpanId, runFriendlyId, isAgentRun, isAdmin } = options;
  const isRootSpanId = options.isRootSpanId ?? rootSpanId;

  const tree = createTreeFromFlatItems(spans, rootSpanId);
  const treeRootStartTimeMs = tree ? tree.data.startTime.getTime() : 0;
  let totalDuration = tree?.data.duration ?? 0;

  const linkedRunIdBySpanId: Record<string, string> = {};

  const events = tree
    ? flattenTree(tree).map((node) => {
        const offset = millisecondsToNanoseconds(
          node.data.startTime.getTime() - treeRootStartTimeMs
        );
        if (!node.data.isDebug) {
          totalDuration = Math.max(totalDuration, offset + node.data.duration);
        }

        if (node.data.style?.icon === "task-cached" && node.runId) {
          linkedRunIdBySpanId[node.id] = node.runId;
        }

        const { events: spanEvents, ...data } = node.data;

        return {
          ...node,
          data: {
            ...data,
            timelineEvents: createTimelineSpanEventsFromSpanEvents(
              spanEvents as SpanEvents,
              isAdmin,
              treeRootStartTimeMs
            ),
            duration: node.data.isPartial ? null : node.data.duration,
            offset,
            isRoot: node.id === isRootSpanId,
            isAgentRun: node.runId === runFriendlyId && isAgentRun,
          },
        };
      })
    : [];

  return { events, totalDuration, treeRootStartTimeMs, tree, linkedRunIdBySpanId };
}

export function buildTraceView(
  spans: SpanSummary[],
  options: BuildTraceViewOptions
): TraceViewResult {
  const { events, totalDuration, tree, linkedRunIdBySpanId } = buildTraceEvents(spans, options);

  const duration = Math.max(totalDuration, millisecondsToNanoseconds(1));

  let rootSpanStatus: "executing" | "completed" | "failed" = "executing";
  if (events[0]) {
    if (events[0].data.isError) {
      rootSpanStatus = "failed";
    } else if (!events[0].data.isPartial) {
      rootSpanStatus = "completed";
    }
  }

  const missingAnchor = !spans.some((span) => span.id === options.rootSpanId) || !tree;

  return {
    events,
    duration,
    rootStartedAt: tree?.data.startTime,
    rootSpanStatus,
    rootSpanId: options.rootSpanId,
    linkedRunIdBySpanId,
    missingAnchor,
  };
}
