import { nanosecondsToMilliseconds } from "@trigger.dev/core/v3";
import type { TaskRunStatus } from "@trigger.dev/database";
import * as Timeline from "~/components/primitives/Timeline";
import type { FlatTreeItem } from "~/components/primitives/TreeView/TreeView";
import { SpanTimelineRow } from "~/components/runs/v3/trace/TimelineView";
import {
  TraceTimelineRowScale,
  type TraceTimelineScale,
} from "~/components/runs/v3/trace/timelineScale";
import type { TraceEvent } from "~/components/runs/v3/trace/types";
import { cn } from "~/utils/cn";
import { isFailedRunStatus, isFinalRunStatus } from "~/v3/taskStatus";
import type { SessionTreeRow } from "./buildSessionTree";

const GRIDLINE_COUNT = 5;

/** One row of the session timeline. Runs and their spans draw on that run's own scale. */
export function SessionTimelineRow({
  node,
  row,
  isSelected,
  scale,
  isLiveRun,
  onClick,
}: {
  node: FlatTreeItem<SessionTreeRow<TraceEvent["data"]>>;
  row: SessionTreeRow<TraceEvent["data"]>;
  isSelected: boolean;
  /** The scale of the run this row belongs to; absent for session and label rows. */
  scale: TraceTimelineScale | undefined;
  isLiveRun: boolean;
  onClick: () => void;
}) {
  const rowClassName = cn(
    "h-8",
    isSelected ? "bg-grid-dimmed hover:bg-grid-bright" : "hover:bg-grid-dimmed"
  );

  if (!scale || (row.kind !== "run" && row.kind !== "span")) {
    return <Timeline.Row className={rowClassName} onClick={onClick} />;
  }

  return (
    <TraceTimelineRowScale scale={scale}>
      <Timeline.Row className={rowClassName} onClick={onClick}>
        <RowGridlines />
        {row.kind === "run" ? (
          <Timeline.Span
            startMs={0}
            durationMs={nanosecondsToMilliseconds(scale.durationNs)}
            className="top-3 h-2"
          >
            <div className={cn("h-full w-full rounded-[2px]", runBarClassName(row.run.status))} />
          </Timeline.Span>
        ) : (
          <SpanTimelineRow
            node={{ ...node, data: row.span } as TraceEvent}
            isSelected={isSelected}
            showDuration
            isTopSpan={false}
            disableAnimations={!isLiveRun}
            onClick={onClick}
          />
        )}
      </Timeline.Row>
    </TraceTimelineRowScale>
  );
}

// Every run has its own scale, so there are no shared ticks: each row gets its own lines.
function RowGridlines() {
  return (
    <Timeline.EquallyDistribute count={GRIDLINE_COUNT}>
      {(ms, index) =>
        index === 0 ? null : (
          <Timeline.Point
            ms={ms}
            className="pointer-events-none top-0 h-full border-r border-grid-dimmed"
          />
        )
      }
    </Timeline.EquallyDistribute>
  );
}

function runBarClassName(status: TaskRunStatus | null) {
  if (!status) return "bg-charcoal-600";
  if (isFailedRunStatus(status)) return "bg-error/60";
  if (isFinalRunStatus(status)) return "bg-blue-500/60";
  return "bg-pending/60";
}
