import { ClockIcon } from "@heroicons/react/20/solid";
import {
  formatDuration,
  formatDurationMilliseconds,
  millisecondsToNanoseconds,
  nanosecondsToMilliseconds,
} from "@trigger.dev/core/v3/utils/durations";
import { Fragment, ReactNode, useState, useEffect } from "react";
import type { SpanPresenter } from "~/presenters/v3/SpanPresenter.server";
import { cn } from "~/utils/cn";
import { DateTime, DateTimeAccurate, SmartDateTime } from "../primitives/DateTime";
import { Spinner } from "../primitives/Spinner";
import { LiveTimer } from "../runs/v3/LiveTimer";
import type { SpanEvent } from "@trigger.dev/core/v3";

type SpanPresenterResult = Awaited<ReturnType<SpanPresenter["call"]>>;

export type TimelineSpan = NonNullable<NonNullable<SpanPresenterResult>["span"]>;
export type TimelineSpanRun = NonNullable<NonNullable<SpanPresenterResult>["run"]>;

export function RunTimeline({ run }: { run: TimelineSpanRun }) {
  return (
    <div className="min-w-fit max-w-80">
      <RunTimelineEvent
        title="Triggered"
        subtitle={<DateTimeAccurate date={run.createdAt} />}
        state="complete"
      />
      {run.delayUntil && !run.expiredAt ? (
        <RunTimelineLine
          title={
            run.startedAt ? (
              <>{formatDuration(run.createdAt, run.delayUntil)} delay</>
            ) : (
              <span className="flex items-center gap-1">
                <ClockIcon className="size-4" />
                <span>
                  Delayed until <DateTime date={run.delayUntil} /> {run.ttl && <>(TTL {run.ttl})</>}
                </span>
              </span>
            )
          }
          state={run.startedAt ? "complete" : "delayed"}
        />
      ) : run.startedAt ? (
        <RunTimelineLine title={formatDuration(run.createdAt, run.startedAt)} state={"complete"} />
      ) : (
        <RunTimelineLine
          title={
            <>
              <LiveTimer
                startTime={run.createdAt}
                endTime={run.startedAt ?? run.expiredAt ?? undefined}
              />{" "}
              {run.ttl && <>(TTL {run.ttl})</>}
            </>
          }
          state={run.startedAt || run.expiredAt ? "complete" : "inprogress"}
        />
      )}
      {run.expiredAt ? (
        <RunTimelineEvent
          title="Expired"
          subtitle={<DateTimeAccurate date={run.expiredAt} previousDate={run.createdAt} />}
          state="error"
        />
      ) : run.startedAt ? (
        <>
          <RunTimelineEvent
            title="Started"
            subtitle={<DateTimeAccurate date={run.startedAt} previousDate={run.createdAt} />}
            state="complete"
          />
          {run.isFinished ? (
            <>
              <RunTimelineLine
                title={formatDuration(run.startedAt, run.updatedAt)}
                state={"complete"}
              />
              <RunTimelineEvent
                title="Finished"
                subtitle={<DateTimeAccurate date={run.updatedAt} previousDate={run.startedAt} />}
                state={run.isError ? "error" : "complete"}
              />
            </>
          ) : (
            <RunTimelineLine
              title={
                <span className="flex items-center gap-1">
                  <Spinner className="size-4" />
                  <span>
                    <LiveTimer startTime={run.startedAt} />
                  </span>
                </span>
              }
              state={"inprogress"}
            />
          )}
        </>
      ) : null}
    </div>
  );
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

  // Keep track of the last date shown to avoid repeating
  const [lastShownDate, setLastShownDate] = useState<Date | null>(null);

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

export type RunTimelineLineProps = {
  title: ReactNode;
  state: "complete" | "delayed" | "inprogress";
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
