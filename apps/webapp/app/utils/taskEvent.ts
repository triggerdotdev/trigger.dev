import { Attributes } from "@opentelemetry/api";
import { SpanEvents, TaskEventStyle, unflattenAttributes } from "@trigger.dev/core/v3";
import { Prisma } from "@trigger.dev/database";
import type { PreparedEvent, QueriedEvent, SpanSummary } from "~/v3/eventRepository.server";

export function prepareTrace(events: QueriedEvent[]) {
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
      recordId: event.id,
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

export function prepareEvent(event: QueriedEvent): PreparedEvent {
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
