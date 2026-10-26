import { type Virtualizer } from "@tanstack/react-virtual";
import { formatDurationMilliseconds, nanosecondsToMilliseconds } from "@trigger.dev/core/v3";
import { motion } from "framer-motion";
import { useRef } from "react";
import tileBgPath from "~/assets/images/error-banner-tile@2x.png";
import { DateTimeShort } from "~/components/primitives/DateTime";
import * as Timeline from "~/components/primitives/Timeline";
import { TreeView, type UseTreeStateOutput } from "~/components/primitives/TreeView/TreeView";
import { type NodesState } from "~/components/primitives/TreeView/reducer";
import { eventBackgroundClassName, eventBorderClassName } from "~/components/runs/v3/SpanTitle";
import { useInitialDimensions } from "~/hooks/useInitialDimensions";
import { cn } from "~/utils/cn";
import { lerp } from "~/utils/lerp";
import { type TasksTreeViewProps } from "./TasksTreeView";
import {
  TraceTimelineScaleProvider,
  queueAdjustedNs,
  timelineDurationMs,
  useLiveDuration,
  useTraceTimelineScale,
} from "./timelineScale";
import { type TraceEvent } from "./types";

type TimelineViewProps = Pick<
  TasksTreeViewProps,
  "totalDuration" | "rootSpanStatus" | "events" | "rootStartedAt" | "queuedDuration"
> & {
  scale: number;
  parentRef: React.RefObject<HTMLDivElement>;
  timelineScrollRef: React.RefObject<HTMLDivElement>;
  virtualizer: Virtualizer<HTMLElement, Element>;
  nodes: NodesState;
  getNodeProps: UseTreeStateOutput["getNodeProps"];
  getTreeProps: UseTreeStateOutput["getTreeProps"];
  toggleNodeSelection: UseTreeStateOutput["toggleNodeSelection"];
  showDurations: boolean;
  treeScrollRef: React.RefObject<HTMLDivElement>;
};

const tickCount = 5;

export function TimelineView({
  totalDuration,
  scale,
  rootSpanStatus,
  rootStartedAt,
  timelineScrollRef,
  virtualizer,
  events,
  nodes,
  getNodeProps,
  getTreeProps,
  toggleNodeSelection,
  showDurations,
  treeScrollRef,
  queuedDuration,
}: TimelineViewProps) {
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const initialTimelineDimensions = useInitialDimensions(timelineContainerRef);
  const minTimelineWidth = initialTimelineDimensions?.width ?? 300;
  const maxTimelineWidth = minTimelineWidth * 10;
  const disableSpansAnimations = rootSpanStatus !== "executing";

  //we want to live-update the duration if the root span is still executing
  const duration = useLiveDuration({
    totalDuration,
    rootSpanStatus,
    rootStartedAt,
    queuedDuration,
  });

  return (
    <div
      className="h-full overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
      ref={timelineContainerRef}
    >
      <Timeline.Root
        durationMs={timelineDurationMs(duration)}
        scale={scale}
        className="h-full overflow-hidden"
        minWidth={minTimelineWidth}
        maxWidth={maxTimelineWidth}
      >
        {/* Follows the cursor */}
        <CurrentTimeIndicator
          totalDuration={duration}
          rootStartedAt={rootStartedAt}
          queuedDurationNs={queuedDuration}
        />

        <Timeline.Row className="grid h-full grid-rows-[2rem_1fr]">
          {/* The duration labels */}
          <Timeline.Row>
            <Timeline.Row className="h-6">
              <Timeline.EquallyDistribute count={tickCount}>
                {(ms: number, index: number) => {
                  if (index === tickCount - 1) return null;
                  return (
                    <Timeline.Point
                      ms={ms}
                      className={"relative bottom-[2px] text-xxs text-text-dimmed"}
                    >
                      {(ms) => (
                        <div
                          className={cn(
                            "whitespace-nowrap",
                            index === 0
                              ? "ml-1"
                              : index === tickCount - 1
                                ? "-ml-1 -translate-x-full"
                                : "-translate-x-1/2"
                          )}
                        >
                          {formatDurationMilliseconds(ms, {
                            style: "short",
                            maxDecimalPoints: ms < 1000 ? 0 : 1,
                          })}
                        </div>
                      )}
                    </Timeline.Point>
                  );
                }}
              </Timeline.EquallyDistribute>
              {rootSpanStatus !== "executing" && (
                <Timeline.Point
                  ms={nanosecondsToMilliseconds(duration)}
                  className={cn(
                    "relative bottom-[2px] text-xxs",
                    rootSpanStatus === "completed" ? "text-success" : "text-error"
                  )}
                >
                  {(ms) => (
                    <div className={cn("-translate-x-1/2 whitespace-nowrap")}>
                      {formatDurationMilliseconds(ms, {
                        style: "short",
                        maxDecimalPoints: ms < 1000 ? 0 : 1,
                      })}
                    </div>
                  )}
                </Timeline.Point>
              )}
            </Timeline.Row>
            <Timeline.Row className="h-2">
              <Timeline.EquallyDistribute count={tickCount}>
                {(ms: number, index: number) => {
                  if (index === 0 || index === tickCount - 1) return null;
                  return (
                    <Timeline.Point ms={ms} className={"h-full border-r border-grid-dimmed"} />
                  );
                }}
              </Timeline.EquallyDistribute>
              <Timeline.Point
                ms={nanosecondsToMilliseconds(duration)}
                className={cn(
                  "h-full border-r",
                  rootSpanStatus === "completed" ? "border-success/30" : "border-error/30"
                )}
              />
            </Timeline.Row>
          </Timeline.Row>
          {/* Main timeline body */}
          <Timeline.Row className="overflow-hidden">
            {/* The vertical tick lines */}
            <Timeline.EquallyDistribute count={tickCount}>
              {(ms: number, index: number) => {
                if (index === 0) return null;
                return <Timeline.Point ms={ms} className={"h-full border-r border-grid-dimmed"} />;
              }}
            </Timeline.EquallyDistribute>
            {/* The completed line  */}
            {rootSpanStatus !== "executing" && (
              <Timeline.Point
                ms={nanosecondsToMilliseconds(duration)}
                className={cn(
                  "h-full border-r",
                  rootSpanStatus === "completed" ? "border-success/30" : "border-error/30"
                )}
              />
            )}
            <TraceTimelineScaleProvider
              scale={{ durationNs: duration, queuedDurationNs: queuedDuration }}
            >
              <TreeView
                scrollRef={timelineScrollRef}
                virtualizer={virtualizer}
                staticRowHeight
                tree={events}
                nodes={nodes}
                getNodeProps={getNodeProps}
                getTreeProps={getTreeProps}
                parentClassName="h-full scrollbar-hide"
                renderNode={({ node, state, index }) => (
                  <SpanTimelineRow
                    key={index}
                    node={node}
                    isSelected={state.selected}
                    showDuration={state.selected ? true : showDurations}
                    isTopSpan={node.id === events[0]?.id}
                    disableAnimations={disableSpansAnimations}
                    onClick={() => toggleNodeSelection(node.id)}
                  />
                )}
                onScroll={(scrollTop) => {
                  const el = treeScrollRef.current;
                  if (el && Math.abs(el.scrollTop - scrollTop) >= 0.5) {
                    el.scrollTop = scrollTop;
                  }
                }}
              />
            </TraceTimelineScaleProvider>
          </Timeline.Row>
        </Timeline.Row>
      </Timeline.Root>
    </div>
  );
}

/** One span's bars and events on the timeline, drawn on the scale from the nearest TraceTimelineScaleProvider. */
export function SpanTimelineRow({
  node,
  isSelected,
  showDuration,
  isTopSpan,
  disableAnimations,
  onClick,
}: {
  node: TraceEvent;
  isSelected: boolean;
  showDuration: boolean;
  isTopSpan: boolean;
  disableAnimations: boolean;
  onClick: () => void;
}) {
  const { durationNs: duration, queuedDurationNs } = useTraceTimelineScale();

  return (
    <Timeline.Row
      className={cn(
        "group flex h-8 items-center",
        isSelected ? "bg-grid-dimmed hover:bg-grid-bright" : "bg-transparent hover:bg-grid-dimmed"
      )}
      onClick={onClick}
    >
      {node.data.level === "TRACE" ? (
        <>
          {/* Add a span for the line, Make the vertical line the first one with 1px wide, and full height */}
          {node.data.timelineEvents.map((event, eventIndex) =>
            eventIndex === 0 ? (
              <Timeline.Point
                key={eventIndex}
                ms={nanosecondsToMilliseconds(queueAdjustedNs(event.offset, queuedDurationNs))}
              >
                {(ms) => (
                  <motion.div
                    className={cn(
                      "ml-[-0.5px] h-2.25 w-px rounded-none",
                      eventBackgroundClassName(node.data)
                    )}
                    layoutId={disableAnimations ? undefined : `${node.id}-${event.name}`}
                    animate={disableAnimations ? false : undefined}
                  />
                )}
              </Timeline.Point>
            ) : (
              <Timeline.Point
                key={eventIndex}
                ms={nanosecondsToMilliseconds(queueAdjustedNs(event.offset, queuedDurationNs))}
                className="z-10"
              >
                {(ms) => (
                  <motion.div
                    className={cn(
                      "ml-[-0.1562rem] size-1.25 rounded-full border bg-background-bright",
                      eventBorderClassName(node.data)
                    )}
                    layoutId={disableAnimations ? undefined : `${node.id}-${event.name}`}
                    animate={disableAnimations ? false : undefined}
                  />
                )}
              </Timeline.Point>
            )
          )}
          {node.data.timelineEvents &&
          node.data.timelineEvents[0] &&
          node.data.timelineEvents[0].offset < node.data.offset ? (
            <Timeline.Span
              startMs={nanosecondsToMilliseconds(
                queueAdjustedNs(node.data.timelineEvents[0].offset, queuedDurationNs)
              )}
              durationMs={nanosecondsToMilliseconds(
                node.data.offset - node.data.timelineEvents[0].offset
              )}
            >
              <motion.div
                className={cn("h-px w-full", eventBackgroundClassName(node.data))}
                layoutId={disableAnimations ? undefined : `mark-${node.id}`}
                animate={disableAnimations ? false : undefined}
              />
            </Timeline.Span>
          ) : null}
          <SpanWithDuration
            showDuration={showDuration}
            startMs={nanosecondsToMilliseconds(
              Math.max(queueAdjustedNs(node.data.offset, queuedDurationNs), 0)
            )}
            durationMs={
              node.data.duration
                ? //completed
                  nanosecondsToMilliseconds(Math.min(node.data.duration, duration))
                : //in progress
                  nanosecondsToMilliseconds(
                    Math.min(duration + (queuedDurationNs ?? 0) - node.data.offset, duration)
                  )
            }
            node={node}
            fadeLeft={isTopSpan && queuedDurationNs !== undefined}
            disableAnimations={disableAnimations}
          />
        </>
      ) : (
        <Timeline.Point
          ms={nanosecondsToMilliseconds(queueAdjustedNs(node.data.offset, queuedDurationNs))}
        >
          {(ms) => (
            <motion.div
              className={cn(
                "timeline-point -ml-0.5 size-3 rounded-full border-2 border-background-bright",
                eventBackgroundClassName(node.data)
              )}
              layoutId={disableAnimations ? undefined : node.id}
              animate={disableAnimations ? false : undefined}
            />
          )}
        </Timeline.Point>
      )}
    </Timeline.Row>
  );
}

function SpanWithDuration({
  showDuration,
  node,
  fadeLeft,
  disableAnimations,
  ...props
}: Timeline.SpanProps & {
  node: TraceEvent;
  showDuration: boolean;
  fadeLeft: boolean;
  disableAnimations?: boolean;
}) {
  return (
    <Timeline.Span {...props}>
      <motion.div
        className={cn(
          "timeline-span relative flex h-4 w-full min-w-0.5 items-center",
          eventBackgroundClassName(node.data),
          fadeLeft ? "rounded-r-sm bg-linear-to-r from-black/50 to-transparent" : "rounded-sm"
        )}
        style={{ backgroundSize: "20px 100%", backgroundRepeat: "no-repeat" }}
        layoutId={disableAnimations ? undefined : node.id}
        animate={disableAnimations ? false : undefined}
      >
        {node.data.isPartial && (
          <div
            className="absolute left-0 top-0 h-full w-full animate-tile-scroll rounded-sm opacity-30"
            style={{ backgroundImage: `url(${tileBgPath})`, backgroundSize: "8px 8px" }}
          />
        )}
        <motion.div
          className={cn(
            "sticky left-0 z-10 transition-opacity group-hover:opacity-100",
            !showDuration && "opacity-0"
          )}
          animate={disableAnimations ? false : undefined}
        >
          <motion.div
            className="whitespace-nowrap rounded-sm px-1 py-0.5 text-xxs text-text-bright text-shadow-custom"
            layout={disableAnimations ? undefined : "position"}
            animate={disableAnimations ? false : undefined}
          >
            {formatDurationMilliseconds(props.durationMs, {
              style: "short",
              maxDecimalPoints: props.durationMs < 1000 ? 0 : 1,
            })}
          </motion.div>
        </motion.div>
      </motion.div>
    </Timeline.Span>
  );
}

const edgeBoundary = 0.17;

function CurrentTimeIndicator({
  totalDuration,
  rootStartedAt,
  queuedDurationNs,
}: {
  totalDuration: number;
  rootStartedAt: Date | undefined;
  queuedDurationNs: number | undefined;
}) {
  return (
    <Timeline.FollowCursor>
      {(ms) => {
        const ratio = ms / nanosecondsToMilliseconds(totalDuration);
        let offset = 0.5;
        if (ratio < edgeBoundary) {
          offset = lerp(0, 0.5, ratio / edgeBoundary);
        } else if (ratio > 1 - edgeBoundary) {
          offset = lerp(0.5, 1, (ratio - (1 - edgeBoundary)) / edgeBoundary);
        }

        const currentTime = rootStartedAt
          ? new Date(
              rootStartedAt.getTime() + ms + nanosecondsToMilliseconds(queuedDurationNs ?? 0)
            )
          : undefined;
        const currentTimeComponent = currentTime ? <DateTimeShort date={currentTime} /> : null;

        return (
          <div className="relative z-50 flex h-full flex-col">
            <div className="relative flex h-6 items-end">
              <div
                className="absolute w-fit whitespace-nowrap rounded-sm border border-border-bright bg-background-hover px-1 py-0.5 text-xxs tabular-nums text-text-bright"
                style={{
                  left: `${offset * 100}%`,
                  transform: `translateX(-${offset * 100}%)`,
                }}
              >
                {currentTimeComponent ? (
                  <span>
                    {formatDurationMilliseconds(ms, {
                      style: "short",
                      maxDecimalPoints: ms < 1000 ? 0 : 1,
                    })}
                    <span className="mx-1 text-text-dimmed">–</span>
                    {currentTimeComponent}
                  </span>
                ) : (
                  <>
                    {formatDurationMilliseconds(ms, {
                      style: "short",
                      maxDecimalPoints: ms < 1000 ? 0 : 1,
                    })}
                  </>
                )}
              </div>
            </div>
            <div className="w-px grow border-r border-border-bright" />
          </div>
        );
      }}
    </Timeline.FollowCursor>
  );
}
