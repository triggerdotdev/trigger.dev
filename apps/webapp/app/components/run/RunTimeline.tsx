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
import tileBgPath from "~/assets/images/error-banner-tile@2x.png";

// Types for the RunTimeline component
export type TimelineEventState = "complete" | "error" | "inprogress" | "delayed";

type TimelineLineVariant = "light" | "normal";

type TimelineEventVariant =
  | "start-cap"
  | "dot-hollow"
  | "dot-solid"
  | "start-cap-thick"
  | "end-cap-thick"
  | "end-cap";

// Timeline item type definitions
export type TimelineEventDefinition = {
  type: "event";
  id: string;
  title: string;
  date?: Date;
  previousDate: Date | undefined;
  state?: TimelineEventState;
  shouldRender: boolean;
  variant: TimelineEventVariant;
};

export type TimelineLineDefinition = {
  type: "line";
  id: string;
  title: React.ReactNode;
  state?: TimelineEventState;
  shouldRender: boolean;
  variant: TimelineLineVariant;
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
              variant={item.variant}
            />
          );
        } else {
          return (
            <RunTimelineLine
              key={item.id}
              title={item.title}
              state={item.state}
              variant={item.variant}
            />
          );
        }
      })}
    </div>
  );
}

// Centralized function to build all timeline items
function buildTimelineItems(run: TimelineSpanRun): TimelineItem[] {
  const state = run.isError ? "error" : run.isFinished ? "complete" : "inprogress";
  const items: TimelineItem[] = [];

  // 1. Triggered Event
  items.push({
    type: "event",
    id: "triggered",
    title: "Triggered",
    date: run.createdAt,
    previousDate: undefined,
    state,
    shouldRender: true,
    variant: "start-cap",
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
      state,
      shouldRender: true,
      variant: "light",
    });
  } else if (run.startedAt) {
    // Already dequeued - show the waiting duration
    items.push({
      type: "line",
      id: "waiting-to-dequeue",
      title: formatDuration(run.createdAt, run.startedAt),
      state,
      shouldRender: true,
      variant: "light",
    });
  } else if (run.expiredAt) {
    // Expired before dequeuing
    items.push({
      type: "line",
      id: "waiting-to-dequeue",
      title: formatDuration(run.createdAt, run.expiredAt),
      state,
      shouldRender: true,
      variant: "light",
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
      state,
      shouldRender: true,
      variant: "light",
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
      state,
      shouldRender: true,
      variant: "dot-hollow",
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
        state,
        shouldRender: true,
        variant: "light",
      });

      // 4b. Show Started event
      items.push({
        type: "event",
        id: "started",
        title: "Started",
        date: run.executedAt,
        previousDate: run.startedAt,
        state,
        shouldRender: true,
        variant: "start-cap-thick",
      });

      // 4c. Show executing line if applicable
      if (run.isFinished) {
        items.push({
          type: "line",
          id: "executing",
          title: formatDuration(run.executedAt, run.updatedAt),
          state,
          shouldRender: true,
          variant: "normal",
        });
      } else {
        items.push({
          type: "line",
          id: "executing",
          title: <LiveTimer startTime={run.executedAt} />,
          state,
          shouldRender: true,
          variant: "normal",
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
          state,
          shouldRender: true,
          variant: "normal",
        });
      } else {
        // Still waiting to start or execute (can't distinguish without executedAt)
        items.push({
          type: "line",
          id: "legacy-waiting-or-executing",
          title: <LiveTimer startTime={run.startedAt} />,
          state,
          shouldRender: true,
          variant: "light",
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
      state,
      shouldRender: true,
      variant: "end-cap-thick",
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
      variant: "dot-solid",
    });
  }

  return items;
}

export type RunTimelineEventProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  state?: "complete" | "error" | "inprogress";
  variant?: TimelineEventVariant;
};

export function RunTimelineEvent({
  title,
  subtitle,
  state,
  variant = "dot-hollow",
}: RunTimelineEventProps) {
  return (
    <div className="grid h-5 grid-cols-[1.125rem_1fr] gap-1 text-sm">
      <div className="relative flex flex-col items-center justify-center">
        <EventMarker variant={variant} state={state} />
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

function EventMarker({
  variant,
  state,
}: {
  variant: TimelineEventVariant;
  state?: TimelineEventState;
}) {
  switch (variant) {
    case "start-cap":
      return (
        <>
          <div
            className={cn(
              "h-full w-[0.4375rem] border-b",
              state === "complete"
                ? "border-success"
                : state === "error"
                ? "border-error"
                : state === "inprogress"
                ? "border-pending"
                : "border-text-dimmed"
            )}
          />
          <div
            className={cn(
              "h-full w-px",
              state === "complete"
                ? "bg-success"
                : state === "error"
                ? "bg-error"
                : state === "inprogress"
                ? "animate-tile-scroll bg-pending"
                : "bg-text-dimmed"
            )}
            style={
              state === "inprogress"
                ? {
                    height: "100%",
                    backgroundImage: `url(${tileBgPath})`,
                    backgroundSize: "8px 8px",
                  }
                : undefined
            }
          />
        </>
      );
    case "dot-hollow":
      return (
        <>
          <div
            className={cn(
              "h-full w-px",
              state === "complete"
                ? "bg-success"
                : state === "error"
                ? "bg-error"
                : state === "inprogress"
                ? "animate-tile-scroll-offset bg-pending"
                : "bg-text-dimmed"
            )}
            style={
              state === "inprogress"
                ? {
                    height: "100%",
                    backgroundImage: `url(${tileBgPath})`,
                    backgroundSize: "8px 8px",
                  }
                : undefined
            }
          />
          <div
            className={cn(
              "size-[0.3125rem] min-h-[0.3125rem] rounded-full border",
              state === "complete"
                ? "border-success"
                : state === "error"
                ? "border-error"
                : state === "inprogress"
                ? "border-pending"
                : "border-text-dimmed"
            )}
          />
          <div
            className={cn(
              "h-full w-px",
              state === "complete"
                ? "bg-success"
                : state === "error"
                ? "bg-error"
                : state === "inprogress"
                ? "animate-tile-scroll-offset bg-pending"
                : "bg-text-dimmed"
            )}
            style={
              state === "inprogress"
                ? {
                    height: "100%",
                    backgroundImage: `url(${tileBgPath})`,
                    backgroundSize: "8px 8px",
                  }
                : undefined
            }
          />
        </>
      );
    case "dot-solid":
      return (
        <div
          className={cn(
            "size-[0.3125rem] rounded-full",
            state === "complete" ? "bg-success" : state === "error" ? "bg-error" : "bg-text-dimmed"
          )}
        />
      );
    case "start-cap-thick":
      return (
        <div
          className={cn(
            "h-full w-[0.4375rem] rounded-t-[0.125rem]",
            state === "complete"
              ? "bg-success"
              : state === "error"
              ? "bg-error"
              : state === "inprogress"
              ? "animate-tile-scroll-offset bg-pending"
              : "bg-text-dimmed"
          )}
          style={
            state === "inprogress"
              ? {
                  height: "100%",
                  backgroundImage: `url(${tileBgPath})`,
                  backgroundSize: "8px 8px",
                }
              : undefined
          }
        />
      );
    case "end-cap-thick":
      return (
        <div
          className={cn(
            "h-full w-[0.4375rem] rounded-b-[0.125rem]",
            state === "complete" ? "bg-success" : state === "error" ? "bg-error" : "bg-text-dimmed"
          )}
        />
      );
    default:
      return <div className={cn("size-[0.3125rem] rounded-full bg-yellow-500")} />;
  }
}

export type RunTimelineLineProps = {
  title: ReactNode;
  state?: TimelineEventState;
  variant?: TimelineLineVariant;
};

export function RunTimelineLine({ title, state, variant = "normal" }: RunTimelineLineProps) {
  return (
    <div className="grid h-6 grid-cols-[1.125rem_1fr] gap-1 text-xs">
      <div className="flex items-stretch justify-center">
        <LineMarker state={state} variant={variant} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-text-dimmed">{title}</span>
      </div>
    </div>
  );
}

function LineMarker({
  state,
  variant,
}: {
  state?: TimelineEventState;
  variant: TimelineLineVariant;
}) {
  switch (variant) {
    case "normal":
      return (
        <div
          className={cn(
            "w-[0.4375rem]",
            state === "complete"
              ? "bg-success"
              : state === "error"
              ? "bg-error"
              : state === "delayed"
              ? "bg-text-dimmed"
              : state === "inprogress"
              ? "animate-tile-scroll rounded-b-[0.125rem] bg-pending"
              : "bg-text-dimmed"
          )}
          style={
            state === "inprogress"
              ? {
                  height: "100%",
                  backgroundImage: `url(${tileBgPath})`,
                  backgroundSize: "8px 8px",
                }
              : undefined
          }
        />
      );
    case "light":
      return (
        <div
          className={cn(
            "w-px",
            state === "complete"
              ? "bg-success"
              : state === "error"
              ? "bg-error"
              : state === "delayed"
              ? "bg-text-dimmed"
              : state === "inprogress"
              ? "animate-tile-scroll bg-pending"
              : "bg-text-dimmed"
          )}
          style={
            state === "inprogress"
              ? {
                  height: "100%",
                  backgroundImage: `url(${tileBgPath})`,
                  backgroundSize: "8px 8px",
                }
              : undefined
          }
        />
      );
    default:
      return <div className="w-px rounded-[0.125rem] bg-text-dimmed" />;
  }
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
  const state = isError ? "error" : inProgress ? "inprogress" : undefined;

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
                variant={event.markerVariant}
                state={state}
              />
              <RunTimelineLine
                title={
                  index === visibleEvents.length - 1
                    ? // Last event - calculate duration until span start time
                      formatDuration(event.timestamp, startTime)
                    : // Calculate duration until next event
                      formatDuration(event.timestamp, visibleEvents[index + 1].timestamp)
                }
                variant={event.lineVariant}
                state={state}
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
          variant={"start-cap-thick"}
          state={state}
        />
        {state === "inprogress" ? (
          <RunTimelineLine
            title={<LiveTimer startTime={startTime} />}
            state={state}
            variant={visibleEvents.length > 0 ? "light" : "normal"}
          />
        ) : (
          <>
            <RunTimelineLine
              title={formatDuration(
                startTime,
                new Date(startTime.getTime() + nanosecondsToMilliseconds(duration))
              )}
              state={isError ? "error" : undefined}
              variant="normal"
            />
            <RunTimelineEvent
              title="Finished"
              subtitle={
                <DateTimeAccurate
                  date={new Date(startTime.getTime() + nanosecondsToMilliseconds(duration))}
                  previousDate={startTime}
                />
              }
              state={isError ? "error" : undefined}
              variant="end-cap-thick"
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
  markerVariant: TimelineEventVariant;
  lineVariant: TimelineLineVariant;
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

  const events = matchingSpanEvents.map((spanEvent, index) => {
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
    } else if (index === matchingSpanEvents.length - 1) {
      markerVariant = "end-cap-thick";
    }

    return {
      name: getFriendlyNameForEvent(name),
      offset,
      timestamp,
      duration,
      properties: spanEvent.properties,
      adminOnly: getAdminOnlyForEvent(name),
      helpText: getHelpTextForEvent(name),
      markerVariant,
      lineVariant: "light" as const,
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
