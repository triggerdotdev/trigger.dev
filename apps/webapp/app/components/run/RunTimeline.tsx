import { ClockIcon } from "@heroicons/react/20/solid";
import type { SpanEvent } from "@trigger.dev/core/v3";
import {
  formatDuration,
  millisecondsToNanoseconds,
  nanosecondsToMilliseconds,
} from "@trigger.dev/core/v3/utils/durations";
import { Fragment, ReactNode, useState } from "react";
import { cn } from "~/utils/cn";
import { DateTime, DateTimeAccurate } from "../primitives/DateTime";
import { Spinner } from "../primitives/Spinner";
import { LiveTimer } from "../runs/v3/LiveTimer";

// Types for the RunTimeline component
export type TimelineEventState = "complete" | "error" | "inprogress" | "delayed";

// Timeline item type definitions
export type TimelineEventDefinition = {
  type: "event";
  id: string;
  title: string;
  date?: Date;
  previousDate: Date | undefined;
  state: TimelineEventState;
  shouldRender: boolean;
};

export type TimelineLineDefinition = {
  type: "line";
  id: string;
  title: React.ReactNode;
  state: TimelineEventState;
  shouldRender: boolean;
};

export type TimelineItem = TimelineEventDefinition | TimelineLineDefinition;

/**
 * TimelineSpanRun represents the minimal set of run properties needed
 * to render the RunTimeline component.
 */
export type TimelineSpanRun = {
  // Core timestamps
  createdAt: Date; // When the run was created/triggered
  startedAt?: Date | null; // When the run was dequeued
  executedAt?: Date | null; // When the run actually started executing
  updatedAt: Date; // Last update timestamp (used for finish time)
  expiredAt?: Date | null; // When the run expired (if applicable)
  completedAt?: Date | null; // When the run completed

  // Delay information
  delayUntil?: Date | null; // If the run is delayed, when it will be processed
  ttl?: string | null; // Time-to-live value if applicable

  // Status flags
  isFinished: boolean; // Whether the run has completed
  isError: boolean; // Whether the run ended with an error
};

export function RunTimeline({ run }: { run: TimelineSpanRun }) {
  // Build timeline items based on the run state
  const timelineItems = buildTimelineItems(run);

  // Filter out items that shouldn't be rendered
  const visibleItems = timelineItems.filter((item) => item.shouldRender);

  return (
    <div className="min-w-fit max-w-80">
      {visibleItems.map((item) => {
        if (item.type === "event") {
          return (
            <RunTimelineEvent
              key={item.id}
              title={item.title}
              subtitle={
                item.date ? (
                  <DateTimeAccurate date={item.date} previousDate={item.previousDate} />
                ) : null
              }
              state={item.state as "complete" | "error"}
            />
          );
        } else {
          return <RunTimelineLine key={item.id} title={item.title} state={item.state} />;
        }
      })}
    </div>
  );
}

// Centralized function to build all timeline items
function buildTimelineItems(run: TimelineSpanRun): TimelineItem[] {
  const items: TimelineItem[] = [];

  // 1. Triggered Event
  items.push({
    type: "event",
    id: "triggered",
    title: "Triggered",
    date: run.createdAt,
    previousDate: undefined,
    state: "complete",
    shouldRender: true,
  });

  // 2. Waiting to dequeue line
  if (run.delayUntil && !run.startedAt && !run.expiredAt) {
    // Delayed, not yet started
    items.push({
      type: "line",
      id: "waiting-to-dequeue",
      title: (
        <span className="flex items-center gap-1">
          <ClockIcon className="size-4" />
          <span>
            Delayed until <DateTime date={run.delayUntil} /> {run.ttl && <>(TTL {run.ttl})</>}
          </span>
        </span>
      ),
      state: "delayed",
      shouldRender: true,
    });
  } else if (run.startedAt) {
    // Already dequeued - show the waiting duration
    items.push({
      type: "line",
      id: "waiting-to-dequeue",
      title: formatDuration(run.createdAt, run.startedAt),
      state: "complete",
      shouldRender: true,
    });
  } else if (run.expiredAt) {
    // Expired before dequeuing
    items.push({
      type: "line",
      id: "waiting-to-dequeue",
      title: formatDuration(run.createdAt, run.expiredAt),
      state: "complete",
      shouldRender: true,
    });
  } else {
    // Still waiting to be dequeued
    items.push({
      type: "line",
      id: "waiting-to-dequeue",
      title: (
        <>
          <LiveTimer
            startTime={run.createdAt}
            endTime={run.startedAt ?? run.expiredAt ?? undefined}
          />{" "}
          {run.ttl && <>(TTL {run.ttl})</>}
        </>
      ),
      state: "inprogress",
      shouldRender: true,
    });
  }

  // 3. Dequeued Event (if applicable)
  if (run.startedAt) {
    items.push({
      type: "event",
      id: "dequeued",
      title: "Dequeued",
      date: run.startedAt,
      previousDate: run.createdAt,
      state: "complete",
      shouldRender: true,
    });
  }

  // 4. Handle the case based on whether executedAt exists
  if (run.startedAt && !run.expiredAt) {
    if (run.executedAt) {
      // New behavior: Run has executedAt timestamp

      // 4a. Show waiting to execute line
      items.push({
        type: "line",
        id: "waiting-to-execute",
        title: formatDuration(run.startedAt, run.executedAt),
        state: "complete",
        shouldRender: true,
      });

      // 4b. Show Started event
      items.push({
        type: "event",
        id: "started",
        title: "Started",
        date: run.executedAt,
        previousDate: run.startedAt,
        state: "complete",
        shouldRender: true,
      });

      // 4c. Show executing line if applicable
      if (run.isFinished) {
        items.push({
          type: "line",
          id: "executing",
          title: formatDuration(run.executedAt, run.updatedAt),
          state: "complete",
          shouldRender: true,
        });
      } else {
        items.push({
          type: "line",
          id: "executing",
          title: (
            <span className="flex items-center gap-1">
              <Spinner className="size-4" />
              <span>
                <LiveTimer startTime={run.executedAt} />
              </span>
            </span>
          ),
          state: "inprogress",
          shouldRender: true,
        });
      }
    } else {
      // Legacy behavior: Run doesn't have executedAt timestamp

      // If the run is finished, show a line directly from Dequeued to Finished
      if (run.isFinished) {
        items.push({
          type: "line",
          id: "legacy-executing",
          title: formatDuration(run.startedAt, run.updatedAt),
          state: "complete",
          shouldRender: true,
        });
      } else {
        // Still waiting to start or execute (can't distinguish without executedAt)
        items.push({
          type: "line",
          id: "legacy-waiting-or-executing",
          title: (
            <span className="flex items-center gap-1">
              <Spinner className="size-4" />
              <span>
                <LiveTimer startTime={run.startedAt} />
              </span>
            </span>
          ),
          state: "inprogress",
          shouldRender: true,
        });
      }
    }
  }

  // 5. Finished Event (if applicable)
  if (run.isFinished && !run.expiredAt) {
    items.push({
      type: "event",
      id: "finished",
      title: "Finished",
      date: run.updatedAt,
      previousDate: run.executedAt ?? run.startedAt ?? undefined,
      state: run.isError ? "error" : "complete",
      shouldRender: true,
    });
  }

  // 6. Expired Event (if applicable)
  if (run.expiredAt) {
    items.push({
      type: "event",
      id: "expired",
      title: "Expired",
      date: run.expiredAt,
      previousDate: run.createdAt,
      state: "error",
      shouldRender: true,
    });
  }

  return items;
}

export type RunTimelineEventProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  state: "complete" | "error";
};

export function RunTimelineEvent({ title, subtitle, state }: RunTimelineEventProps) {
  return (
    <div className="grid h-5 grid-cols-[1.125rem_1fr] text-sm">
      <div className="flex items-center justify-center">
        <div
          className={cn(
            "size-[0.3125rem] rounded-full",
            state === "complete" ? "bg-success" : "bg-error"
          )}
        ></div>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-text-bright">{title}</span>
        {subtitle ? (
          <span className="text-xs tabular-nums text-text-dimmed">{subtitle}</span>
        ) : null}
      </div>
    </div>
  );
}

export type RunTimelineLineProps = {
  title: ReactNode;
  state: TimelineEventState;
};

export function RunTimelineLine({ title, state }: RunTimelineLineProps) {
  return (
    <div className="grid h-6 grid-cols-[1.125rem_1fr] text-xs">
      <div className="flex items-stretch justify-center">
        <div
          className={cn(
            "w-px",
            state === "complete" ? "bg-success" : state === "delayed" ? "bg-text-dimmed" : ""
          )}
          style={
            state === "inprogress"
              ? {
                  width: "1px",
                  height: "100%",
                  background:
                    "repeating-linear-gradient(to bottom, #3B82F6 0%, #3B82F6 50%, transparent 50%, transparent 100%)",
                  backgroundSize: "1px 6px",
                  maskImage: "linear-gradient(to bottom, black 50%, transparent 100%)",
                  WebkitMaskImage: "linear-gradient(to bottom, black 50%, transparent 100%)",
                }
              : undefined
          }
        ></div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-text-dimmed">{title}</span>
      </div>
    </div>
  );
}

export type SpanTimelineProps = {
  startTime: Date;
  duration: number;
  inProgress: boolean;
  isError: boolean;
  events?: TimelineSpanEvent[];
  showAdminOnlyEvents?: boolean;
};

export type SpanTimelineState = "error" | "pending" | "complete";

export function SpanTimeline({
  startTime,
  duration,
  inProgress,
  isError,
  events,
  showAdminOnlyEvents,
}: SpanTimelineProps) {
  const state = isError ? "error" : inProgress ? "pending" : "complete";

  // Filter events if needed
  const visibleEvents = events?.filter((event) => !event.adminOnly || showAdminOnlyEvents) ?? [];

  return (
    <>
      <div className="min-w-fit max-w-80">
        {visibleEvents.map((event, index) => {
          // Store previous date to compare
          const prevDate = index === 0 ? null : visibleEvents[index - 1].timestamp;

          return (
            <Fragment key={index}>
              <RunTimelineEvent
                title={event.name}
                subtitle={<DateTimeAccurate date={event.timestamp} previousDate={prevDate} />}
                state={"complete"}
              />
              <RunTimelineLine
                title={
                  index === visibleEvents.length - 1
                    ? // Last event - calculate duration until span start time
                      formatDuration(event.timestamp, startTime)
                    : // Calculate duration until next event
                      formatDuration(event.timestamp, visibleEvents[index + 1].timestamp)
                }
                state={"complete"}
              />
            </Fragment>
          );
        })}
        <RunTimelineEvent
          title="Started"
          subtitle={
            <DateTimeAccurate
              date={startTime}
              previousDate={
                visibleEvents.length > 0 ? visibleEvents[visibleEvents.length - 1].timestamp : null
              }
            />
          }
          state="complete"
        />
        {state === "pending" ? (
          <RunTimelineLine
            title={
              <span className="flex items-center gap-1">
                <Spinner className="size-4" />
                <span>
                  <LiveTimer startTime={startTime} />
                </span>
              </span>
            }
            state={"inprogress"}
          />
        ) : (
          <>
            <RunTimelineLine
              title={formatDuration(
                startTime,
                new Date(startTime.getTime() + nanosecondsToMilliseconds(duration))
              )}
              state={"complete"}
            />
            <RunTimelineEvent
              title="Finished"
              subtitle={
                <DateTimeAccurate
                  date={new Date(startTime.getTime() + nanosecondsToMilliseconds(duration))}
                  previousDate={startTime}
                />
              }
              state={isError ? "error" : "complete"}
            />
          </>
        )}
      </div>
    </>
  );
}

export type TimelineSpanEvent = {
  name: string;
  offset: number;
  timestamp: Date;
  duration?: number;
  helpText?: string;
  adminOnly: boolean;
};

export function createTimelineSpanEventsFromSpanEvents(
  spanEvents: SpanEvent[],
  relativeStartTime?: number
): Array<TimelineSpanEvent> {
  // Rest of function remains the same
  if (!spanEvents) {
    return [];
  }

  const matchingSpanEvents = spanEvents.filter((spanEvent) =>
    spanEvent.name.startsWith("trigger.dev/")
  );

  if (matchingSpanEvents.length === 0) {
    return [];
  }

  const sortedSpanEvents = [...matchingSpanEvents].sort((a, b) => {
    if (a.time === b.time) {
      return a.name.localeCompare(b.name);
    }

    const aTime = typeof a.time === "string" ? new Date(a.time) : a.time;
    const bTime = typeof b.time === "string" ? new Date(b.time) : b.time;

    return aTime.getTime() - bTime.getTime();
  });

  const firstEventTime =
    typeof sortedSpanEvents[0].time === "string"
      ? new Date(sortedSpanEvents[0].time)
      : sortedSpanEvents[0].time;

  const $relativeStartTime = relativeStartTime ?? firstEventTime.getTime();

  const events = matchingSpanEvents.map((spanEvent) => {
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

    return {
      name: getFriendlyNameForEvent(name),
      offset,
      timestamp,
      duration,
      properties: spanEvent.properties,
      adminOnly: getAdminOnlyForEvent(name),
      helpText: getHelpTextForEvent(name),
    };
  });

  // Now sort by offset, ascending
  events.sort((a, b) => a.offset - b.offset);

  return events;
}

function getFriendlyNameForEvent(event: string): string {
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
      return "Imported task file";
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

function getAdminOnlyForEvent(event: string): boolean {
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
      return true;
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

function getHelpTextForEvent(event: string): string | undefined {
  switch (event) {
    case "dequeue": {
      return "The task was dequeued from the queue";
    }
    case "fork": {
      return "The process was created to run the task";
    }
    case "create_attempt": {
      return "An attempt was created for the task";
    }
    case "import": {
      return "A task file was imported";
    }
    default: {
      return undefined;
    }
  }
}
