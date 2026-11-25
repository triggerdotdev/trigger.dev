import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import type { TaskRunStatus } from "@trigger.dev/database";
import tileBgPath from "~/assets/images/error-banner-tile@2x.png";
import * as Timeline from "~/components/primitives/Timeline";
import type { FlatTreeItem } from "~/components/primitives/TreeView/TreeView";
import { SpanTimelineRow } from "~/components/runs/v3/trace/TimelineView";
import {
  TraceTimelineScaleProvider,
  type TraceTimelineScale,
} from "~/components/runs/v3/trace/timelineScale";
import type { TraceEvent } from "~/components/runs/v3/trace/types";
import { cn } from "~/utils/cn";
import { isFailedRunStatus, isFinalRunStatus } from "~/v3/taskStatus";
import type { SessionTreeRow } from "./buildSessionTree";
import type { AxisWindow } from "./sessionTimelineAxis";

const GRIDLINE_COUNT = 5;

/** Where a row draws on the session axis, in axis ms. */
export type RowPlacement =
  /** A run's bar. */
  | { kind: "bar"; startMs: number; endMs: number }
  /** A span: drawn on its run's trace scale, shifted to where the run's trace starts. */
  | { kind: "span"; scale: TraceTimelineScale; originMs: number };

/** One row of the session timeline, drawn on the session axis inside the visible axisWindow. */
export function SessionTimelineRow({
  node,
  row,
  isSelected,
  isExpanded,
  placement,
  axisWindow,
  isLiveRun,
  onClick,
}: {
  node: FlatTreeItem<SessionTreeRow<TraceEvent["data"]>>;
  row: SessionTreeRow<TraceEvent["data"]>;
  isSelected: boolean;
  isExpanded: boolean;
  placement: RowPlacement | undefined;
  axisWindow: AxisWindow;
  isLiveRun: boolean;
  onClick: () => void;
}) {
  const rowClassName = cn(
    "group",
    "h-8",
    row.kind === "loadEarlier"
      ? undefined
      : isSelected
        ? "bg-grid-dimmed hover:bg-grid-bright"
        : "hover:bg-grid-dimmed"
  );

  if (!placement) return <Timeline.Row className={rowClassName} onClick={onClick} />;

  if (placement.kind === "span" && row.kind === "span") {
    // The span's own offsets are in its run's trace time; this axisWindow lines them up with the axis.
    return (
      <TraceTimelineScaleProvider scale={placement.scale}>
        <Timeline.Scale
          startMs={axisWindow.startMs - placement.originMs}
          durationMs={axisWindow.endMs - axisWindow.startMs}
        >
          <Timeline.Row className={rowClassName}>
            <RowGridlines />
            <SpanTimelineRow
              node={{ ...node, data: row.span } as TraceEvent}
              isSelected={isSelected}
              showDuration
              isTopSpan={false}
              disableAnimations={!isLiveRun}
              onClick={onClick}
            />
          </Timeline.Row>
        </Timeline.Scale>
      </TraceTimelineScaleProvider>
    );
  }

  // Only run rows get a bar.
  if (placement.kind !== "bar" || row.kind !== "run") {
    return <Timeline.Row className={rowClassName} onClick={onClick} />;
  }
  const durationMs = Math.max(placement.endMs - placement.startMs, 0);
  return (
    <Timeline.Row className={rowClassName} onClick={onClick}>
      <RowGridlines />
      <Timeline.Span startMs={placement.startMs} durationMs={durationMs} className="top-2 h-4">
        <div
          className={cn(
            "relative flex h-full w-full min-w-0.5 items-center rounded-sm",
            runBarClassName(row.run.status)
          )}
        >
          {/* In progress: the same moving tiles as an unfinished span on the run page. */}
          {row.run.status && !isFinalRunStatus(row.run.status) && (
            <div
              className="absolute inset-0 animate-tile-scroll rounded-sm opacity-30"
              style={{ backgroundImage: `url(${tileBgPath})`, backgroundSize: "8px 8px" }}
            />
          )}
          {/* Zoomed out most bars are a few px wide, so the label waits for an open run or hover. */}
          <div
            className={cn(
              "sticky left-0 z-10 whitespace-nowrap rounded-sm px-1 py-0.5 text-xxs text-text-bright text-shadow-custom transition-opacity group-hover:opacity-100",
              !isExpanded && "opacity-0"
            )}
          >
            {formatDurationMilliseconds(durationMs, {
              style: "short",
              maxDecimalPoints: durationMs < 1000 ? 0 : 1,
            })}
          </div>
        </div>
      </Timeline.Span>
    </Timeline.Row>
  );
}

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

/** Same meanings as the run page's bars: green done, red failed, grey canceled or expired. */
function runBarClassName(status: TaskRunStatus | null) {
  if (!status) return "bg-charcoal-600";
  if (status === "COMPLETED_SUCCESSFULLY") return "bg-success";
  if (isFailedRunStatus(status)) return "bg-error";
  if (isFinalRunStatus(status)) return "bg-surface-control";
  return "bg-blue-500";
}
