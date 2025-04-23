import { Attributes, Link } from "@opentelemetry/api";
import {
  correctErrorStackTrace,
  ExceptionEventProperties,
  isExceptionSpanEvent,
  millisecondsToNanoseconds,
  NULL_SENTINEL,
  SemanticInternalAttributes,
  SpanEvent,
  SpanEvents,
  SpanMessagingEvent,
  TaskEventStyle,
  unflattenAttributes,
} from "@trigger.dev/core/v3";
import { Prisma, TaskEvent, TaskEventKind } from "@trigger.dev/database";
import { createTreeFromFlatItems, flattenTree } from "~/components/primitives/TreeView/TreeView";
import type {
  PreparedEvent,
  SpanLink,
  SpanSummary,
  TraceSummary,
} from "~/v3/eventRepository.server";

export type TraceSpan = NonNullable<ReturnType<typeof createSpanFromEvents>>;

export function prepareTrace(events: TaskEvent[]): TraceSummary | undefined {
  let preparedEvents: Array<PreparedEvent> = [];
  let rootSpanId: string | undefined;
  const eventsBySpanId = new Map<string, PreparedEvent>();

  for (const event of events) {
    preparedEvents.push(prepareEvent(event));

    if (!rootSpanId && !event.parentId) {
      rootSpanId = event.spanId;
    }
  }

  for (const event of preparedEvents) {
    const existingEvent = eventsBySpanId.get(event.spanId);

    if (!existingEvent) {
      eventsBySpanId.set(event.spanId, event);
      continue;
    }

    if (event.isCancelled || !event.isPartial) {
      eventsBySpanId.set(event.spanId, event);
    }
  }

  preparedEvents = Array.from(eventsBySpanId.values());

  const spansBySpanId = new Map<string, SpanSummary>();

  const spans = preparedEvents.map((event) => {
    const ancestorCancelled = isAncestorCancelled(eventsBySpanId, event.spanId);
    const duration = calculateDurationIfAncestorIsCancelled(
      eventsBySpanId,
      event.spanId,
      event.duration
    );

    const span = {
      id: event.spanId,
      parentId: event.parentId ?? undefined,
      runId: event.runId,
      data: {
        message: event.message,
        style: event.style,
        duration,
        isError: event.isError,
        isPartial: ancestorCancelled ? false : event.isPartial,
        isCancelled: event.isCancelled === true ? true : event.isPartial && ancestorCancelled,
        startTime: getDateFromNanoseconds(event.startTime),
        level: event.level,
        events: event.events,
        environmentType: event.environmentType,
        isDebug: event.kind === TaskEventKind.LOG,
      },
    } satisfies SpanSummary;

    spansBySpanId.set(event.spanId, span);

    return span;
  });

  if (!rootSpanId) {
    return;
  }

  const rootSpan = spansBySpanId.get(rootSpanId);

  if (!rootSpan) {
    return;
  }

  return {
    rootSpan,
    spans,
  };
}

export function createTraceTreeFromEvents(traceSummary: TraceSummary, spanId: string) {
  //this tree starts at the passed in span (hides parent elements if there are any)
  const tree = createTreeFromFlatItems(traceSummary.spans, spanId);

  //we need the start offset for each item, and the total duration of the entire tree
  const treeRootStartTimeMs = tree ? tree?.data.startTime.getTime() : 0;
  let totalDuration = tree?.data.duration ?? 0;
  const events = tree
    ? flattenTree(tree).map((n) => {
        const offset = millisecondsToNanoseconds(n.data.startTime.getTime() - treeRootStartTimeMs);
        totalDuration = Math.max(totalDuration, offset + n.data.duration);
        return {
          ...n,
          data: {
            ...n.data,
            //set partial nodes to null duration
            duration: n.data.isPartial ? null : n.data.duration,
            offset,
            isRoot: n.id === traceSummary.rootSpan.id,
          },
        };
      })
    : [];

  //total duration should be a minimum of 1ms
  totalDuration = Math.max(totalDuration, millisecondsToNanoseconds(1));

  let rootSpanStatus: "executing" | "completed" | "failed" = "executing";
  if (events[0]) {
    if (events[0].data.isError) {
      rootSpanStatus = "failed";
    } else if (!events[0].data.isPartial) {
      rootSpanStatus = "completed";
    }
  }

  return {
    rootSpanStatus,
    events: events,
    parentRunFriendlyId:
      tree?.id === traceSummary.rootSpan.id ? undefined : traceSummary.rootSpan.runId,
    duration: totalDuration,
    rootStartedAt: tree?.data.startTime,
  };
}

export function createSpanFromEvents(events: TaskEvent[], spanId: string) {
  const spanEvent = getSpanEvent(events, spanId);

  if (!spanEvent) {
    return;
  }

  const preparedEvent = prepareEvent(spanEvent);
  const span = createSpanFromEvent(events, preparedEvent);

  const output = rehydrateJson(spanEvent.output);
  const payload = rehydrateJson(spanEvent.payload);

  const show = rehydrateShow(spanEvent.properties);

  const properties = sanitizedAttributes(spanEvent.properties);

  const messagingEvent = SpanMessagingEvent.optional().safeParse((properties as any)?.messaging);

  const links: SpanLink[] = [];

  if (messagingEvent.success && messagingEvent.data) {
    if (messagingEvent.data.message && "id" in messagingEvent.data.message) {
      if (messagingEvent.data.message.id.startsWith("run_")) {
        links.push({
          type: "run",
          icon: "runs",
          title: `Run ${messagingEvent.data.message.id}`,
          runId: messagingEvent.data.message.id,
        });
      }
    }
  }

  const backLinks = spanEvent.links as any as Link[] | undefined;

  if (backLinks && backLinks.length > 0) {
    backLinks.forEach((l) => {
      const title = String(l.attributes?.[SemanticInternalAttributes.LINK_TITLE] ?? "Triggered by");

      links.push({
        type: "span",
        icon: "trigger",
        title,
        traceId: l.context.traceId,
        spanId: l.context.spanId,
      });
    });
  }

  const spanEvents = transformEvents(
    preparedEvent.events,
    spanEvent.metadata as Attributes,
    spanEvent.environmentType === "DEVELOPMENT"
  );

  return {
    ...spanEvent,
    ...span.data,
    payload,
    output,
    events: spanEvents,
    show,
    links,
    properties: properties ? JSON.stringify(properties, null, 2) : undefined,
    showActionBar: show?.actions === true,
  };
}

export function createSpanFromEvent(events: TaskEvent[], event: PreparedEvent) {
  let ancestorCancelled = false;
  let duration = event.duration;

  if (!event.isCancelled && event.isPartial) {
    walkSpanAncestors(events, event, (ancestorEvent, level) => {
      if (level >= 8) {
        return { stop: true };
      }

      if (ancestorEvent.isCancelled) {
        ancestorCancelled = true;

        // We need to get the cancellation time from the cancellation span event
        const cancellationEvent = ancestorEvent.events.find(
          (event) => event.name === "cancellation"
        );

        if (cancellationEvent) {
          duration = calculateDurationFromStart(event.startTime, cancellationEvent.time);
        }

        return { stop: true };
      }

      return { stop: false };
    });
  }

  const span = {
    id: event.spanId,
    parentId: event.parentId ?? undefined,
    runId: event.runId,
    idempotencyKey: event.idempotencyKey,
    data: {
      message: event.message,
      style: event.style,
      duration,
      isError: event.isError,
      isPartial: ancestorCancelled ? false : event.isPartial,
      isCancelled: event.isCancelled === true ? true : event.isPartial && ancestorCancelled,
      startTime: getDateFromNanoseconds(event.startTime),
      level: event.level,
      events: event.events,
      environmentType: event.environmentType,
    },
  };

  return span;
}

function walkSpanAncestors(
  events: TaskEvent[],
  event: PreparedEvent,
  callback: (event: PreparedEvent, level: number) => { stop: boolean }
) {
  const parentId = event.parentId;
  if (!parentId) {
    return;
  }

  let parentEvent = getSpanEvent(events, parentId);
  let level = 1;

  while (parentEvent) {
    const preparedParentEvent = prepareEvent(parentEvent);

    const result = callback(preparedParentEvent, level);

    if (result.stop) {
      return;
    }

    if (!preparedParentEvent.parentId) {
      return;
    }

    parentEvent = getSpanEvent(events, preparedParentEvent.parentId);

    level++;
  }
}

function getSpanEvent(events: TaskEvent[], spanId: string) {
  const spans = events.filter((e) => e.spanId === spanId);
  const completedSpan = spans.find((s) => !s.isPartial);

  if (completedSpan) {
    return completedSpan;
  }

  return spans.at(0);
}

export function prepareEvent(event: TaskEvent): PreparedEvent {
  return {
    ...event,
    duration: Number(event.duration),
    events: parseEventsField(event.events),
    style: parseStyleField(event.style),
  };
}

function parseEventsField(events: Prisma.JsonValue): SpanEvents {
  const unsafe = events
    ? (events as any[]).map((e) => ({
        ...e,
        properties: unflattenAttributes(e.properties as Attributes),
      }))
    : undefined;

  return unsafe as SpanEvents;
}

function parseStyleField(style: Prisma.JsonValue): TaskEventStyle {
  const unsafe = unflattenAttributes(style as Attributes);

  if (!unsafe) {
    return {};
  }

  if (typeof unsafe === "object") {
    return Object.assign(
      {
        icon: undefined,
        variant: undefined,
      },
      unsafe
    ) as TaskEventStyle;
  }

  return {};
}

export function isAncestorCancelled(events: Map<string, PreparedEvent>, spanId: string) {
  const event = events.get(spanId);

  if (!event) {
    return false;
  }

  if (event.isCancelled) {
    return true;
  }

  if (event.parentId) {
    return isAncestorCancelled(events, event.parentId);
  }

  return false;
}

function calculateDurationIfAncestorIsCancelled(
  events: Map<string, PreparedEvent>,
  spanId: string,
  defaultDuration: number
) {
  const event = events.get(spanId);

  if (!event) {
    return defaultDuration;
  }

  if (event.isCancelled) {
    return defaultDuration;
  }

  if (!event.isPartial) {
    return defaultDuration;
  }

  if (event.parentId) {
    const cancelledAncestor = findFirstCancelledAncestor(events, event.parentId);

    if (cancelledAncestor) {
      // We need to get the cancellation time from the cancellation span event
      const cancellationEvent = cancelledAncestor.events.find(
        (event) => event.name === "cancellation"
      );

      if (cancellationEvent) {
        return calculateDurationFromStart(event.startTime, cancellationEvent.time);
      }
    }
  }

  return defaultDuration;
}

export function calculateDurationFromStart(startTime: bigint, endTime: Date = new Date()) {
  const $endtime = typeof endTime === "string" ? new Date(endTime) : endTime;

  return Number(BigInt($endtime.getTime() * 1_000_000) - startTime);
}

function findFirstCancelledAncestor(events: Map<string, PreparedEvent>, spanId: string) {
  const event = events.get(spanId);

  if (!event) {
    return;
  }

  if (event.isCancelled) {
    return event;
  }

  if (event.parentId) {
    return findFirstCancelledAncestor(events, event.parentId);
  }

  return;
}

export function getDateFromNanoseconds(nanoseconds: bigint) {
  return new Date(Number(nanoseconds) / 1_000_000);
}

export function getNowInNanoseconds(): bigint {
  return BigInt(new Date().getTime() * 1_000_000);
}

export function rehydrateJson(json: Prisma.JsonValue): any {
  if (json === null) {
    return undefined;
  }

  if (json === NULL_SENTINEL) {
    return null;
  }

  if (typeof json === "string") {
    return json;
  }

  if (typeof json === "number") {
    return json;
  }

  if (typeof json === "boolean") {
    return json;
  }

  if (Array.isArray(json)) {
    return json.map((item) => rehydrateJson(item));
  }

  if (typeof json === "object") {
    return unflattenAttributes(json as Attributes);
  }

  return null;
}

export function rehydrateShow(properties: Prisma.JsonValue): { actions?: boolean } | undefined {
  if (properties === null || properties === undefined) {
    return;
  }

  if (typeof properties !== "object") {
    return;
  }

  if (Array.isArray(properties)) {
    return;
  }

  const actions = properties[SemanticInternalAttributes.SHOW_ACTIONS];

  if (typeof actions === "boolean") {
    return { actions };
  }

  return;
}

export function sanitizedAttributes(json: Prisma.JsonValue) {
  if (json === null || json === undefined) {
    return;
  }

  const withoutPrivateProperties = removePrivateProperties(json as Attributes);
  if (!withoutPrivateProperties) {
    return;
  }

  return unflattenAttributes(withoutPrivateProperties);
}
// removes keys that start with a $ sign. If there are no keys left, return undefined
function removePrivateProperties(
  attributes: Attributes | undefined | null
): Attributes | undefined {
  if (!attributes) {
    return undefined;
  }

  const result: Attributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("$")) {
      continue;
    }

    result[key] = value;
  }

  if (Object.keys(result).length === 0) {
    return undefined;
  }

  return result;
}

export function transformEvents(
  events: SpanEvents,
  properties: Attributes,
  isDev: boolean
): SpanEvents {
  return (events ?? []).map((event) => transformEvent(event, properties, isDev));
}

function transformEvent(event: SpanEvent, properties: Attributes, isDev: boolean): SpanEvent {
  if (isExceptionSpanEvent(event)) {
    return {
      ...event,
      properties: {
        exception: transformException(event.properties.exception, properties, isDev),
      },
    };
  }

  return event;
}

function transformException(
  exception: ExceptionEventProperties,
  properties: Attributes,
  isDev: boolean
): ExceptionEventProperties {
  const projectDirAttributeValue = properties[SemanticInternalAttributes.PROJECT_DIR];

  if (projectDirAttributeValue !== undefined && typeof projectDirAttributeValue !== "string") {
    return exception;
  }

  return {
    ...exception,
    stacktrace: exception.stacktrace
      ? correctErrorStackTrace(exception.stacktrace, projectDirAttributeValue, {
          removeFirstLine: true,
          isDev,
        })
      : undefined,
  };
}
