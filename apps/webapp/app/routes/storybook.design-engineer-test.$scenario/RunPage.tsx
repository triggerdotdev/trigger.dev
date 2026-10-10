import {
  ArrowUturnLeftIcon,
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  StarIcon as StarIconSolid,
} from "@heroicons/react/20/solid";
import { StarIcon as StarIconOutline } from "@heroicons/react/24/outline";
import { Link, useSearchParams } from "@remix-run/react";
import { type Virtualizer } from "@tanstack/react-virtual";
import { formatDurationMilliseconds, nanosecondsToMilliseconds } from "@trigger.dev/core/v3";
import { motion } from "framer-motion";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { ChevronExtraSmallDown } from "~/assets/icons/ChevronExtraSmallDown";
import { ChevronExtraSmallUp } from "~/assets/icons/ChevronExtraSmallUp";
import tileBgPath from "~/assets/images/error-banner-tile@2x.png";
import { WarmStartIconWithTooltip } from "~/components/WarmStarts";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { BreadcrumbIcon } from "~/components/primitives/BreadcrumbIcon";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTimeShort } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Popover, PopoverArrowTrigger, PopoverContent } from "~/components/primitives/Popover";
import {
  RESIZABLE_PANEL_ANIMATION,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  collapsibleHandleClassName,
  useFrozenValue,
} from "~/components/primitives/Resizable";
import { SearchInput } from "~/components/primitives/SearchInput";
import { ShortcutKey, variants } from "~/components/primitives/ShortcutKey";
import { Slider } from "~/components/primitives/Slider";
import { Switch } from "~/components/primitives/Switch";
import * as Timeline from "~/components/primitives/Timeline";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import {
  TreeView,
  type UseTreeStateOutput,
  useTree,
} from "~/components/primitives/TreeView/TreeView";
import { type NodesState } from "~/components/primitives/TreeView/reducer";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import {
  SpanTitle,
  eventBackgroundClassName,
  eventBorderClassName,
} from "~/components/runs/v3/SpanTitle";
import { TaskRunStatusIcon, runStatusClassNameColor } from "~/components/runs/v3/TaskRunStatus";
import { useDebounce } from "~/hooks/useDebounce";
import { useInitialDimensions } from "~/hooks/useInitialDimensions";
import { type Shortcut, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { lerp } from "~/utils/lerp";
import { docsPath, v3RunsPath } from "~/utils/pathBuilder";
import {
  mockEnvironment,
  mockOrganization,
  mockProject,
  type MockTraceEvent,
  type RunPageScenario,
} from "./mockTrace";
import { SpanInspector } from "./SpanInspector";

// The run page, forked from _app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam
// so it can be redesigned freely. It renders a finished run from a production environment, as
// seen by someone who isn't an admin. Links look and behave as they do on the real page but never
// navigate (see PreventNavigation).

// The real page saves panel sizes per user. These groups don't, so every visit starts from the
// defaults; the fixed ids keep server and client renders in step.
const resizableSettings = {
  parent: {
    id: "run-page-mock-parent",
    handleId: "parent-handle",
    main: {
      id: "run",
      min: "100px" as const,
    },
    inspector: {
      id: "inspector",
      default: "500px" as const,
      min: "250px" as const,
    },
  },
  tree: {
    id: "run-page-mock-tree",
    handleId: "tree-handle",
    tree: {
      id: "tree",
      default: "50%" as const,
      min: "50px" as const,
    },
    timeline: {
      id: "timeline",
      default: "50%" as const,
      min: "50px" as const,
    },
  },
};

const runsPath = v3RunsPath(mockOrganization, mockProject, mockEnvironment);

export function RunPage({ scenario }: { scenario: RunPageScenario }) {
  const { run } = scenario;

  return (
    <PreventNavigation>
      <PageContainer>
        <NavBar>
          <PageTitle runFriendlyId={run.friendlyId} />
          <PageAccessories>
            <LinkButton variant={"docs/small"} LeadingIcon={BookOpenIcon} to={docsPath("/runs")}>
              Run docs
            </LinkButton>
            <Button
              variant="secondary/small"
              LeadingIcon={ArrowUturnLeftIcon}
              shortcut={{ key: "R" }}
              className="pr-2"
            >
              Replay run
            </Button>
          </PageAccessories>
        </NavBar>
        <PageBody scrollable={false}>
          <TraceView scenario={scenario} />
        </PageBody>
      </PageContainer>
    </PreventNavigation>
  );
}

/**
 * Cancels every link click inside the mock, including in popovers (React events bubble through
 * portals), so links keep their real hover, focus and href but don't leave the storybook.
 */
function PreventNavigation({ children }: { children: React.ReactNode }) {
  const preventLinkNavigation = (event: React.MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("a")) {
      event.preventDefault();
    }
  };

  return (
    <div
      className="h-full overflow-hidden"
      onClickCapture={preventLinkNavigation}
      onAuxClickCapture={preventLinkNavigation}
    >
      {children}
    </div>
  );
}

// PageTitle from PageHeader.tsx, with the run page's title. The favorite star is local state
// rather than a saved favorite.
function PageTitle({ runFriendlyId }: { runFriendlyId: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="group -ml-1.5 flex items-center gap-0">
        <Link
          to={runsPath}
          className="rounded px-1.5 py-1 text-xs text-text-dimmed transition focus-custom group-hover:bg-background-raised group-hover:text-text-bright"
        >
          Runs
        </Link>
        <BreadcrumbIcon className="h-5" />
      </div>
      <Header2 className="flex items-center gap-1">
        <div className="flex items-center gap-x-0">
          <CopyableText
            value={runFriendlyId}
            variant="text-below"
            className="-ml-1.75 h-6 px-1.5 font-mono text-xs hover:text-text-bright"
          />
          <div className="flex">
            <AdjacentRunButton direction="previous" />
            <AdjacentRunButton direction="next" />
          </div>
        </div>
      </Header2>
      <FavoritePageButton pageName={`Run: ${runFriendlyId}`} className="-ml-1" />
    </div>
  );
}

function FavoritePageButton({ pageName, className }: { pageName: string; className?: string }) {
  const [isFavorited, setIsFavorited] = useState(false);

  useShortcutKeys({
    shortcut: { key: "f", modifiers: ["alt"] },
    action: (event) => {
      event.preventDefault();
      setIsFavorited((favorited) => !favorited);
    },
  });

  const tooltipLabel = isFavorited
    ? `Remove ${pageName} from favorites`
    : `Add ${pageName} to favorites`;

  return (
    <SimpleTooltip
      delayDuration={500}
      disableHoverableContent
      asChild
      side="bottom"
      button={
        <span className={cn("flex", className)}>
          <Button
            variant="minimal/small"
            className="aspect-square h-6 p-1"
            onClick={() => setIsFavorited((favorited) => !favorited)}
            aria-label={tooltipLabel}
            aria-pressed={isFavorited}
            LeadingIcon={
              isFavorited ? (
                <StarIconSolid className="size-4 text-yellow-500" />
              ) : (
                <StarIconOutline className="size-4 text-text-dimmed transition-colors group-hover/button:text-text-bright" />
              )
            }
          />
        </span>
      }
      content={
        <span className="flex items-center gap-2">
          {tooltipLabel}
          <ShortcutKey shortcut={{ modifiers: ["alt"], key: "f" }} variant="medium/bright" />
        </span>
      }
    />
  );
}

// Shown when you open a run from the runs list, as if this run had a neighbour either side.
function AdjacentRunButton({ direction }: { direction: "previous" | "next" }) {
  const isPrevious = direction === "previous";

  return (
    <div className={cn(isPrevious ? "peer/prev order-1" : "peer/next order-3")}>
      <LinkButton
        to={runsPath}
        variant={"minimal/small"}
        LeadingIcon={isPrevious ? ChevronExtraSmallUp : ChevronExtraSmallDown}
        leadingIconClassName="size-3 group-hover/button:text-text-bright transition-colors"
        className="flex size-6 max-w-6 items-center"
        shortcut={{ key: isPrevious ? "j" : "k" }}
        tooltip={isPrevious ? "Previous Run" : "Next Run"}
        replace
      />
    </div>
  );
}

/** Keeps the selected span and tab in the URL, like the real page, without a navigation. */
function useUrlState(selectedSpanId: string | undefined, tab: string | undefined) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedSpanId) {
      url.searchParams.set("span", selectedSpanId);
    } else {
      url.searchParams.delete("span");
    }
    if (tab) {
      url.searchParams.set("tab", tab);
    } else {
      url.searchParams.delete("tab");
    }
    window.history.replaceState(window.history.state, "", url);
  }, [selectedSpanId, tab]);
}

function TraceView({ scenario }: { scenario: RunPageScenario }) {
  const { run, trace, spans } = scenario;
  const [searchParams] = useSearchParams();
  const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>(() => {
    const spanParam = searchParams.get("span");
    return spanParam && spans[spanParam] ? spanParam : run.spanId;
  });
  const [tab, setTab] = useState<string | undefined>(() => searchParams.get("tab") ?? undefined);
  useUrlState(selectedSpanId, tab);

  // Keeps the inspector's content while it animates closed.
  const frozenSpanId = useFrozenValue(selectedSpanId);
  const displaySpanId = selectedSpanId ?? frozenSpanId;
  const displayEntry = displaySpanId ? spans[displaySpanId] : undefined;

  const [errorsOnly, setErrorsOnly] = useState(false);

  return (
    <div className={cn("grid h-full max-h-full grid-cols-1 overflow-hidden")}>
      <ResizablePanelGroup id={resizableSettings.parent.id} className="h-full max-h-full">
        <ResizablePanel
          id={resizableSettings.parent.main.id}
          min={resizableSettings.parent.main.min}
        >
          <div className="flex h-full flex-col overflow-hidden">
            <div className="min-h-0 flex-1">
              <TasksTreeView
                selectedId={selectedSpanId}
                events={trace.events}
                onSelectedIdChanged={setSelectedSpanId}
                totalDuration={trace.duration}
                rootSpanStatus={trace.rootSpanStatus}
                rootStartedAt={trace.rootStartedAt}
                queuedDuration={trace.queuedDuration}
                errorsOnly={errorsOnly}
                onErrorsOnlyChanged={setErrorsOnly}
              />
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle
          id={resizableSettings.parent.handleId}
          className={collapsibleHandleClassName(!!selectedSpanId)}
        />
        <ResizablePanel
          id={resizableSettings.parent.inspector.id}
          default={resizableSettings.parent.inspector.default}
          min={resizableSettings.parent.inspector.min}
          className="overflow-hidden"
          collapsible
          collapsed={!selectedSpanId}
          onCollapseChange={() => {}}
          collapsedSize="0px"
          collapseAnimation={RESIZABLE_PANEL_ANIMATION}
        >
          <div
            className="h-full"
            style={{ minWidth: parseInt(resizableSettings.parent.inspector.min) }}
          >
            {displayEntry && (
              <SpanInspector
                entry={displayEntry}
                runParam={run.friendlyId}
                tab={tab}
                onTabChange={setTab}
                closePanel={() => setSelectedSpanId(undefined)}
              />
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

type TasksTreeViewProps = {
  events: MockTraceEvent[];
  selectedId?: string;
  onSelectedIdChanged: (selectedId: string | undefined) => void;
  totalDuration: number;
  rootSpanStatus: "executing" | "completed" | "failed";
  rootStartedAt: Date | undefined;
  queuedDuration: number | undefined;
  errorsOnly: boolean;
  onErrorsOnlyChanged: (errorsOnly: boolean) => void;
};

function TasksTreeView({
  events,
  selectedId,
  onSelectedIdChanged,
  totalDuration,
  rootSpanStatus,
  rootStartedAt,
  queuedDuration,
  errorsOnly,
  onErrorsOnlyChanged,
}: TasksTreeViewProps) {
  const [filterText, setFilterText] = useState("");
  const [showDurations, setShowDurations] = useState(true);
  const [showQueueTime, setShowQueueTime] = useState(false);
  const [scale, setScale] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);

  const queuedTime = showQueueTime ? undefined : queuedDuration;

  const {
    nodes,
    getTreeProps,
    getNodeProps,
    toggleNodeSelection,
    toggleExpandNode,
    expandAllBelowDepth,
    toggleExpandLevel,
    collapseAllBelowDepth,
    selectNode,
    scrollToNode,
    virtualizer,
  } = useTree({
    tree: events,
    selectedId,
    onSelectedIdChanged,
    estimatedRowHeight: () => 32,
    parentRef,
    filter: {
      value: { text: filterText, errorsOnly },
      fn: (value, node) => {
        const nodePassesErrorTest = (value.errorsOnly && node.data.isError) || !value.errorsOnly;
        if (!nodePassesErrorTest) return false;

        if (value.text === "") return true;
        if (node.data.message.toLowerCase().includes(value.text.toLowerCase())) {
          return true;
        }
        return false;
      },
    },
  });

  const getInteractiveNodeProps = (id: string) => ({
    ...getNodeProps(id),
    onClick: () => selectNode(id),
  });

  // The rows are memoised so scrolling only renders the rows coming into view. Their click
  // handlers need a stable identity for that, so they call the tree's latest actions via a ref.
  const treeActions = useRef({
    toggleExpandNode,
    expandAllBelowDepth,
    collapseAllBelowDepth,
    selectNode,
    scrollToNode,
    toggleNodeSelection,
  });
  useEffect(() => {
    treeActions.current = {
      toggleExpandNode,
      expandAllBelowDepth,
      collapseAllBelowDepth,
      selectNode,
      scrollToNode,
      toggleNodeSelection,
    };
  });

  const onChevronClick = useCallback((node: MockTraceEvent, expanded: boolean, altKey: boolean) => {
    const actions = treeActions.current;
    if (altKey) {
      if (expanded) {
        actions.collapseAllBelowDepth(node.level);
      } else {
        actions.expandAllBelowDepth(node.level);
      }
    } else if (node.hasChildren) {
      actions.toggleExpandNode(node.id);
    } else {
      actions.selectNode(node.id, false);
    }
    actions.scrollToNode(node.id);
    parentRef.current?.focus({ preventScroll: true });
  }, []);

  const onTimelineRowClick = useCallback((id: string) => {
    treeActions.current.toggleNodeSelection(id);
  }, []);

  return (
    <div className="grid h-full grid-rows-[2.5rem_1fr_3.25rem] overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-grid-dimmed px-1.5">
        <div className="flex flex-1 items-center gap-1.5">
          <SearchField onChange={setFilterText} />
        </div>
        <div className="flex items-center gap-1.5">
          <Switch
            variant="secondary/small"
            label="Queue time"
            checked={showQueueTime}
            onCheckedChange={(e) => setShowQueueTime(e.valueOf())}
            shortcut={{ key: "Q" }}
          />
          <Switch
            variant="secondary/small"
            label="Errors only"
            checked={errorsOnly}
            onCheckedChange={(e) => onErrorsOnlyChanged(e.valueOf())}
          />
        </div>
      </div>
      <ResizablePanelGroup id={resizableSettings.tree.id}>
        {/* Tree list */}
        <ResizablePanel
          id={resizableSettings.tree.tree.id}
          default={resizableSettings.tree.tree.default}
          min={resizableSettings.tree.tree.min}
        >
          <div className="grid h-full grid-rows-[2rem_1fr] overflow-hidden">
            <div className="flex items-center justify-between pl-1 pr-2">
              <Paragraph variant="extra-small" className="flex-1 pl-3 text-text-faint">
                This is the root task
              </Paragraph>
            </div>
            <TreeView
              parentRef={parentRef}
              scrollRef={treeScrollRef}
              virtualizer={virtualizer}
              autoFocus
              staticRowHeight
              tree={events}
              nodes={nodes}
              getNodeProps={getInteractiveNodeProps}
              getTreeProps={getTreeProps}
              parentClassName="pl-3"
              renderNode={({ node, state }) => (
                <TreeRow
                  node={node}
                  selected={state.selected}
                  expanded={state.expanded}
                  onChevronClick={onChevronClick}
                />
              )}
              onScroll={(scrollTop) => {
                const el = timelineScrollRef.current;
                if (el && Math.abs(el.scrollTop - scrollTop) >= 0.5) {
                  el.scrollTop = scrollTop;
                }
              }}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle id={resizableSettings.tree.handleId} />
        {/* Timeline */}
        <ResizablePanel
          id={resizableSettings.tree.timeline.id}
          default={resizableSettings.tree.timeline.default}
          min={resizableSettings.tree.timeline.min}
        >
          <TimelineView
            totalDuration={totalDuration}
            scale={scale}
            events={events}
            rootSpanStatus={rootSpanStatus}
            rootStartedAt={rootStartedAt}
            queuedDuration={queuedTime}
            timelineScrollRef={timelineScrollRef}
            nodes={nodes}
            getNodeProps={getNodeProps}
            getTreeProps={getTreeProps}
            showDurations={showDurations}
            treeScrollRef={treeScrollRef}
            virtualizer={virtualizer}
            onRowClick={onTimelineRowClick}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-4">
        <div className="grow @container">
          <div className="hidden items-center gap-4 @[48rem]:flex">
            <KeyboardShortcuts
              expandAllBelowDepth={expandAllBelowDepth}
              collapseAllBelowDepth={collapseAllBelowDepth}
              toggleExpandLevel={toggleExpandLevel}
              setShowDurations={setShowDurations}
            />
          </div>
          <div className="@[48rem]:hidden">
            <Popover>
              <PopoverArrowTrigger>Shortcuts</PopoverArrowTrigger>
              <PopoverContent
                className="min-w-80 overflow-y-auto p-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
                align="start"
              >
                <Header3 spacing>Keyboard shortcuts</Header3>
                <div className="flex flex-col gap-2">
                  <KeyboardShortcuts
                    expandAllBelowDepth={expandAllBelowDepth}
                    collapseAllBelowDepth={collapseAllBelowDepth}
                    toggleExpandLevel={toggleExpandLevel}
                    setShowDurations={setShowDurations}
                  />
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Slider
            variant={"tertiary"}
            className="w-20"
            LeadingIcon={MagnifyingGlassMinusIcon}
            TrailingIcon={MagnifyingGlassPlusIcon}
            value={[scale]}
            onValueChange={(value) => setScale(value[0])}
            min={0}
            max={1}
            step={0.05}
          />
        </div>
      </div>
    </div>
  );
}

type TimelineViewProps = Pick<
  TasksTreeViewProps,
  "totalDuration" | "rootSpanStatus" | "events" | "rootStartedAt" | "queuedDuration"
> & {
  scale: number;
  timelineScrollRef: React.RefObject<HTMLDivElement>;
  virtualizer: Virtualizer<HTMLElement, Element>;
  nodes: NodesState;
  getNodeProps: UseTreeStateOutput["getNodeProps"];
  getTreeProps: UseTreeStateOutput["getTreeProps"];
  onRowClick: (id: string) => void;
  showDurations: boolean;
  treeScrollRef: React.RefObject<HTMLDivElement>;
};

const tickCount = 5;

function TimelineView({
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
  onRowClick,
  showDurations,
  treeScrollRef,
  queuedDuration,
}: TimelineViewProps) {
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const initialTimelineDimensions = useInitialDimensions(timelineContainerRef);
  const minTimelineWidth = initialTimelineDimensions?.width ?? 300;
  const maxTimelineWidth = minTimelineWidth * 10;
  const disableSpansAnimations = rootSpanStatus !== "executing";
  // The real page ticks this up while the root span is executing; every scenario has finished.
  const duration = queueAdjustedNs(totalDuration, queuedDuration);

  return (
    <div
      className="h-full overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
      ref={timelineContainerRef}
    >
      <Timeline.Root
        durationMs={nanosecondsToMilliseconds(duration * 1.05)}
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
            <TreeView
              scrollRef={timelineScrollRef}
              virtualizer={virtualizer}
              staticRowHeight
              tree={events}
              nodes={nodes}
              getNodeProps={getNodeProps}
              getTreeProps={getTreeProps}
              parentClassName="h-full scrollbar-hide"
              renderNode={({ node, state }) => (
                <TimelineRow
                  node={node}
                  selected={state.selected}
                  showDuration={state.selected || showDurations}
                  isTopSpan={node.id === events[0]?.id}
                  duration={duration}
                  queuedDuration={queuedDuration}
                  disableAnimations={disableSpansAnimations}
                  onClick={onRowClick}
                />
              )}
              onScroll={(scrollTop) => {
                const el = treeScrollRef.current;
                if (el && Math.abs(el.scrollTop - scrollTop) >= 0.5) {
                  el.scrollTop = scrollTop;
                }
              }}
            />
          </Timeline.Row>
        </Timeline.Row>
      </Timeline.Root>
    </div>
  );
}

function queueAdjustedNs(timeNs: number, queuedDurationNs: number | undefined) {
  if (queuedDurationNs) {
    return timeNs - queuedDurationNs;
  }

  return timeNs;
}

// Memoised, so when scrolling moves the virtualised range only the rows coming into view render.
const TreeRow = memo(function TreeRow({
  node,
  selected,
  expanded,
  onChevronClick,
}: {
  node: MockTraceEvent;
  selected: boolean;
  expanded: boolean;
  onChevronClick: (node: MockTraceEvent, expanded: boolean, altKey: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "group/spannode flex h-8 cursor-pointer items-center overflow-hidden rounded-l-sm pr-2",
        selected ? "bg-grid-dimmed hover:bg-grid-bright" : "bg-transparent hover:bg-grid-dimmed"
      )}
    >
      <div className="flex h-8 items-center">
        {Array.from({ length: node.level }).map((_, index) => (
          <TaskLine key={index} />
        ))}
        <button
          type="button"
          tabIndex={-1}
          aria-label={
            node.hasChildren ? (expanded ? "Collapse task" : "Expand task") : "Select task"
          }
          className={cn(
            "flex h-8 w-4 items-center focus-custom",
            node.hasChildren && "hover:bg-surface-control"
          )}
          onClick={(e) => {
            e.stopPropagation();
            onChevronClick(node, expanded, e.altKey);
          }}
        >
          {node.hasChildren ? (
            expanded ? (
              <ChevronDownIcon className="h-4 w-4 text-text-dimmed" />
            ) : (
              <ChevronRightIcon className="h-4 w-4 text-text-dimmed" />
            )
          ) : (
            <div className="h-8 w-4" />
          )}
        </button>
      </div>

      <div className="flex w-full items-center justify-between gap-2 pl-1">
        <div className="flex items-center gap-1.5 overflow-x-hidden">
          <RunIcon
            name={node.data.style?.icon}
            spanName={node.data.message}
            className="size-5 min-h-5 min-w-5"
          />
          <NodeText node={node} />
          {node.data.isRoot && <Badge variant="extra-small">Root</Badge>}
        </div>
        <div className="flex items-center gap-1">
          <NodeStatusIcon node={node} />
        </div>
      </div>
    </div>
  );
});

const TimelineRow = memo(function TimelineRow({
  node,
  selected,
  showDuration,
  isTopSpan,
  duration,
  queuedDuration,
  disableAnimations,
  onClick,
}: {
  node: MockTraceEvent;
  selected: boolean;
  showDuration: boolean;
  isTopSpan: boolean;
  duration: number;
  queuedDuration: number | undefined;
  disableAnimations: boolean;
  onClick: (id: string) => void;
}) {
  return (
    <Timeline.Row
      className={cn(
        "group flex h-8 items-center",
        selected ? "bg-grid-dimmed hover:bg-grid-bright" : "bg-transparent hover:bg-grid-dimmed"
      )}
      onClick={() => onClick(node.id)}
    >
      {node.data.level === "TRACE" ? (
        <>
          {/* Add a span for the line, Make the vertical line the first one with 1px wide, and full height */}
          {node.data.timelineEvents.map((event, eventIndex) =>
            eventIndex === 0 ? (
              <Timeline.Point
                key={eventIndex}
                ms={nanosecondsToMilliseconds(queueAdjustedNs(event.offset, queuedDuration))}
              >
                {() => (
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
                ms={nanosecondsToMilliseconds(queueAdjustedNs(event.offset, queuedDuration))}
                className="z-10"
              >
                {() => (
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
                queueAdjustedNs(node.data.timelineEvents[0].offset, queuedDuration)
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
              Math.max(queueAdjustedNs(node.data.offset, queuedDuration), 0)
            )}
            durationMs={
              node.data.duration
                ? //completed
                  nanosecondsToMilliseconds(Math.min(node.data.duration, duration))
                : //in progress
                  nanosecondsToMilliseconds(
                    Math.min(duration + (queuedDuration ?? 0) - node.data.offset, duration)
                  )
            }
            node={node}
            fadeLeft={isTopSpan && queuedDuration !== undefined}
            disableAnimations={disableAnimations}
          />
        </>
      ) : (
        <Timeline.Point
          ms={nanosecondsToMilliseconds(queueAdjustedNs(node.data.offset, queuedDuration))}
        >
          {() => (
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
});

function NodeText({ node }: { node: MockTraceEvent }) {
  return (
    <Paragraph variant="small" className="truncate">
      <SpanTitle {...node.data} size="small" />
    </Paragraph>
  );
}

function NodeStatusIcon({ node }: { node: MockTraceEvent }) {
  if (node.data.level !== "TRACE") return null;
  if (!node.data.style.variant) return null;

  if (node.data.style.variant === "warm") {
    return <WarmStartIconWithTooltip isWarmStart={true} className="size-4" />;
  } else if (node.data.style.variant === "cold") {
    return <WarmStartIconWithTooltip isWarmStart={false} className="size-4" />;
  }

  if (node.data.isCancelled) {
    return (
      <>
        <Paragraph variant="extra-small" className={runStatusClassNameColor("CANCELED")}>
          Canceled
        </Paragraph>
        <TaskRunStatusIcon status="CANCELED" className={cn("size-4")} />
      </>
    );
  }

  if (node.data.isError) {
    return <TaskRunStatusIcon status="COMPLETED_WITH_ERRORS" className={cn("size-4")} />;
  }

  if (node.data.isPartial) {
    return <TaskRunStatusIcon status={"EXECUTING"} className={cn("size-4")} />;
  }

  return <TaskRunStatusIcon status="COMPLETED_SUCCESSFULLY" className={cn("size-4")} />;
}

function TaskLine() {
  return <div className={cn("h-8 w-2 border-r border-grid-bright")} />;
}

function SpanWithDuration({
  showDuration,
  node,
  fadeLeft,
  disableAnimations,
  ...props
}: Timeline.SpanProps & {
  node: MockTraceEvent;
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

function KeyboardShortcuts({
  expandAllBelowDepth,
  collapseAllBelowDepth,
  toggleExpandLevel,
}: {
  expandAllBelowDepth: (depth: number) => void;
  collapseAllBelowDepth: (depth: number) => void;
  toggleExpandLevel: (depth: number) => void;
  setShowDurations?: (show: (show: boolean) => boolean) => void;
}) {
  return (
    <>
      <ArrowKeyShortcuts />
      <AdjacentRunsShortcuts />
      <ShortcutWithAction
        shortcut={{ key: "e" }}
        action={() => expandAllBelowDepth(0)}
        title="Expand all"
      />
      <ShortcutWithAction
        shortcut={{ key: "w" }}
        action={() => collapseAllBelowDepth(1)}
        title="Collapse all"
      />
      <NumberShortcuts toggleLevel={(number) => toggleExpandLevel(number)} />
      <ShortcutWithAction shortcut={{ key: "Q" }} title="Queue time" action={() => {}} />
    </>
  );
}

function AdjacentRunsShortcuts() {
  return (
    <div className="flex items-center gap-0.5">
      <ShortcutKey shortcut={{ key: "[" }} variant="medium" className="ml-0 mr-0 px-1" />
      <ShortcutKey shortcut={{ key: "]" }} variant="medium" className="ml-0 mr-0 px-1" />
      <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
        Next/previous run
      </Paragraph>
    </div>
  );
}

function ArrowKeyShortcuts() {
  return (
    <div className="flex items-center gap-0.5">
      <ShortcutKey shortcut={{ key: "arrowup" }} variant="medium" className="ml-0 mr-0" />
      <ShortcutKey shortcut={{ key: "arrowdown" }} variant="medium" className="ml-0 mr-0" />
      <ShortcutKey shortcut={{ key: "arrowleft" }} variant="medium" className="ml-0 mr-0" />
      <ShortcutKey shortcut={{ key: "arrowright" }} variant="medium" className="ml-0 mr-0" />
      <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
        Navigate
      </Paragraph>
    </div>
  );
}

function ShortcutWithAction({
  shortcut,
  title,
  action,
}: {
  shortcut: Shortcut;
  title: string;
  action: () => void;
}) {
  useShortcutKeys({
    shortcut,
    action,
  });

  return (
    <div className="flex items-center gap-0.5">
      <ShortcutKey shortcut={shortcut} variant="medium" className="ml-0 mr-0" />
      <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
        {title}
      </Paragraph>
    </div>
  );
}

function NumberShortcuts({ toggleLevel }: { toggleLevel: (depth: number) => void }) {
  useHotkeys(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"], (event) => {
    toggleLevel(Number(event.key));
  });

  return (
    <div className="flex items-center gap-0.5">
      <span className={cn(variants.medium, "ml-0 mr-0")}>0</span>
      <span className="text-[0.65rem] text-text-dimmed">–</span>
      <span className={cn(variants.medium, "ml-0 mr-0")}>9</span>
      <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
        Toggle level
      </Paragraph>
    </div>
  );
}

function SearchField({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("");

  const updateFilterText = useDebounce((text: string) => {
    onChange(text);
  }, 250);

  const updateValue = (next: string) => {
    setValue(next);
    updateFilterText(next);
  };

  return <SearchInput placeholder="Search logs…" value={value} onValueChange={updateValue} />;
}
