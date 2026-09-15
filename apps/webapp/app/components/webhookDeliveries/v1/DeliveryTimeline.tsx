import { formatDuration } from "@trigger.dev/core/v3/utils/durations";
import { Fragment } from "react";
import { AIChatIcon } from "~/assets/icons/AIChatIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { DateTimeAccurate } from "~/components/primitives/DateTime";
import { TextLink } from "~/components/primitives/TextLink";
import { RunTimelineEvent, RunTimelineLine } from "~/components/run/RunTimeline";
import { LiveTimer } from "~/components/runs/v3/LiveTimer";
import {
  buildDeliveryTimelineItems,
  type BuildDeliveryTimelineInput,
  type DeliveryTimelineEventItem,
} from "./buildDeliveryTimelineItems";

type DeliveryTimelineProps = {
  delivery: BuildDeliveryTimelineInput;
  runPath?: string;
  sessionPath?: string;
};

export function DeliveryTimeline({ delivery, runPath, sessionPath }: DeliveryTimelineProps) {
  const items = buildDeliveryTimelineItems(delivery);

  return (
    <div className="mb-4 min-w-fit max-w-full border-b border-grid-dimmed pb-4">
      {items.map((item) => {
        if (item.type === "line") {
          return (
            <RunTimelineLine
              key={item.id}
              state={item.state}
              variant={item.variant}
              // "Received" is a thin start-cap, so a thick line here begins the bar and has to
              // round its own top. Thin ("light") lines, as in the FILTERED case, need nothing.
              roundedTop={item.variant === "normal"}
              title={
                <span className="flex items-center gap-1.5">
                  {item.to ? (
                    formatDuration(item.from, item.to)
                  ) : (
                    <LiveTimer startTime={item.from} />
                  )}
                  {item.label ? (
                    <span className="text-text-dimmed/60">({item.label.toLowerCase()})</span>
                  ) : null}
                </span>
              }
            />
          );
        }

        return (
          <Fragment key={item.id}>
            <RunTimelineEvent
              title={item.title}
              state={item.state}
              variant={item.variant}
              subtitle={
                item.date ? (
                  <DateTimeAccurate date={item.date} previousDate={item.previousDate} />
                ) : null
              }
            />
            <TimelineEventExtras item={item} runPath={runPath} sessionPath={sessionPath} />
          </Fragment>
        );
      })}
    </div>
  );
}

function TimelineEventExtras({
  item,
  runPath,
  sessionPath,
}: {
  item: DeliveryTimelineEventItem;
  runPath?: string;
  sessionPath?: string;
}) {
  const showSession = Boolean(item.target?.session && sessionPath);
  const showRun = Boolean(item.target?.run && runPath);
  const hasTarget = showSession || showRun;

  if (!item.note && !hasTarget) {
    return null;
  }

  return (
    <div className="grid grid-cols-[1.125rem_1fr] gap-1">
      <div />
      <div className="flex flex-col gap-0.5 pb-1">
        {item.note ? (
          <span
            className={item.state === "error" ? "text-xs text-error" : "text-xs text-text-dimmed"}
          >
            {item.note}
          </span>
        ) : null}
        {showSession && item.target?.session ? (
          <TextLink to={sessionPath!} className="inline-flex items-center gap-1 font-mono text-xs">
            <AIChatIcon className="size-3.5 text-sessions" />
            {item.target.session.friendlyId}
          </TextLink>
        ) : showRun && item.target?.run ? (
          <TextLink to={runPath!} className="inline-flex items-center gap-1 font-mono text-xs">
            <RunsIcon className="size-3.5 text-runs" />
            {item.target.run.friendlyId}
          </TextLink>
        ) : null}
      </div>
    </div>
  );
}
