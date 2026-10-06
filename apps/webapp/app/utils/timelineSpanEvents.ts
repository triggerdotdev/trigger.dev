import type { SpanEvent } from "@trigger.dev/core/v3";
import { millisecondsToNanoseconds } from "@trigger.dev/core/v3/utils/durations";

type TimelineLineVariant = "light" | "normal";

type TimelineEventVariant =
  | "start-cap"
  | "dot-hollow"
  | "dot-solid"
  | "start-cap-thick"
  | "end-cap-thick"
  | "end-cap";

export type TimelineSpanEvent = {
  name: string;
  offset: number;
  timestamp: Date;
  duration?: number;
  helpText?: string;
  markerVariant: TimelineEventVariant;
  lineVariant: TimelineLineVariant;
};

export function createTimelineSpanEventsFromSpanEvents(
  spanEvents: SpanEvent[],
  isAdmin: boolean,
  relativeStartTime?: number
): Array<TimelineSpanEvent> {
  if (!spanEvents) {
    return [];
  }

  const matchingSpanEvents = spanEvents.filter((spanEvent) =>
    spanEvent.name.startsWith("trigger.dev/")
  );

  if (matchingSpanEvents.length === 0) {
    return [];
  }

  // Check if there's a fork event
  const hasForkEvent = matchingSpanEvents.some(
    (spanEvent) =>
      "event" in spanEvent.properties &&
      typeof spanEvent.properties.event === "string" &&
      spanEvent.properties.event === "fork"
  );

  const sortedSpanEvents = [...matchingSpanEvents].sort((a, b) => {
    if (a.time === b.time) {
      return a.name.localeCompare(b.name);
    }

    const aTime = typeof a.time === "string" ? new Date(a.time) : a.time;
    const bTime = typeof b.time === "string" ? new Date(b.time) : b.time;

    return aTime.getTime() - bTime.getTime();
  });

  const visibleSpanEvents = sortedSpanEvents.filter((spanEvent) => {
    const eventName =
      "event" in spanEvent.properties && typeof spanEvent.properties.event === "string"
        ? spanEvent.properties.event
        : spanEvent.name;

    // If we're admin, everything is visible
    if (isAdmin) {
      return true;
    }

    // If there's no fork event, import events are also visible to non-admins
    if (!hasForkEvent && eventName === "import") {
      return true;
    }

    // Otherwise use normal admin-only logic
    return !getAdminOnlyForEvent(eventName);
  });

  if (visibleSpanEvents.length === 0) {
    return [];
  }

  const firstEventTime =
    typeof visibleSpanEvents[0].time === "string"
      ? new Date(visibleSpanEvents[0].time)
      : visibleSpanEvents[0].time;

  const $relativeStartTime = relativeStartTime ?? firstEventTime.getTime();

  const events = visibleSpanEvents.map((spanEvent, index) => {
    const timestamp =
      typeof spanEvent.time === "string" ? new Date(spanEvent.time) : spanEvent.time;

    const offset = millisecondsToNanoseconds(timestamp.getTime() - $relativeStartTime);

    const duration =
      "duration" in spanEvent.properties && typeof spanEvent.properties.duration === "number"
        ? spanEvent.properties.duration
        : undefined;

    const name =
      "event" in spanEvent.properties && typeof spanEvent.properties.event === "string"
        ? spanEvent.properties.event
        : spanEvent.name;

    let markerVariant: TimelineEventVariant = "dot-hollow";

    if (index === 0) {
      markerVariant = "start-cap";
    }

    return {
      name: getFriendlyNameForEvent(name, spanEvent.properties),
      offset,
      timestamp,
      duration,
      helpText: getHelpTextForEvent(name),
      markerVariant,
      lineVariant: "light" as const,
    };
  });

  // Now sort by offset, ascending
  events.sort((a, b) => a.offset - b.offset);

  return events;
}

function getFriendlyNameForEvent(event: string, properties?: Record<string, any>): string {
  switch (event) {
    case "dequeue": {
      return "Dequeued";
    }
    case "fork": {
      return "Launched";
    }
    case "create_attempt": {
      return "Attempt created";
    }
    case "import": {
      return "Importing task file";
    }
    case "lazy_payload": {
      return "Lazy attempt initialized";
    }
    case "pod_scheduled": {
      return "Pod scheduled";
    }
    default: {
      return event;
    }
  }
}

type EventRow = { spanId: string; kind: string; message: string; metadata: string };

function internalEventName(row: EventRow): string {
  try {
    const parsed = JSON.parse(row.metadata) as unknown;
    if (parsed && typeof parsed === "object") {
      const event = (parsed as Record<string, unknown>).event;
      if (typeof event === "string") {
        return event;
      }
    }
  } catch {}
  return row.message;
}

function isInternalTimelineRow(row: EventRow): boolean {
  return (
    (row.kind === "SPAN_EVENT" || row.kind === "ANCESTOR_OVERRIDE") &&
    row.message.startsWith("trigger.dev/")
  );
}

export function stripAdminOnlyEventRows<T extends EventRow>(rows: T[], isAdmin: boolean): T[] {
  if (isAdmin) {
    return rows;
  }

  const spansWithForkEvent = new Set<string>();
  for (const row of rows) {
    if (isInternalTimelineRow(row) && internalEventName(row) === "fork") {
      spansWithForkEvent.add(row.spanId);
    }
  }

  return rows.filter((row) => {
    if (!isInternalTimelineRow(row)) {
      return true;
    }
    const eventName = internalEventName(row);
    if (!spansWithForkEvent.has(row.spanId) && eventName === "import") {
      return true;
    }
    return !getAdminOnlyForEvent(eventName);
  });
}

export function getAdminOnlyForEvent(event: string): boolean {
  switch (event) {
    case "dequeue": {
      return false;
    }
    case "fork": {
      return false;
    }
    case "create_attempt": {
      return true;
    }
    case "import": {
      return false;
    }
    case "lazy_payload": {
      return true;
    }
    case "pod_scheduled": {
      return true;
    }
    default: {
      return true;
    }
  }
}

export function getHelpTextForEvent(event: string): string | undefined {
  switch (event) {
    case "dequeue": {
      return "The run was dequeued from the queue";
    }
    case "fork": {
      return "The process was created to run the task";
    }
    case "create_attempt": {
      return "An attempt was created for the run";
    }
    case "import": {
      return "A task file was imported";
    }
    case "lazy_payload": {
      return "The payload was initialized lazily";
    }
    case "pod_scheduled": {
      return "The Kubernetes pod was scheduled to run";
    }
    case "Triggered": {
      return "The run was triggered";
    }
    case "Dequeued": {
      return "The run was dequeued from the queue";
    }
    case "Started": {
      return "The run began executing";
    }
    case "Finished": {
      return "The run completed execution";
    }
    case "Expired": {
      return "The run expired before it could be started";
    }
    default: {
      return undefined;
    }
  }
}
