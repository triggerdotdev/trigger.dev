import {
  ChevronDownIcon,
  ChevronRightIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
} from "@heroicons/react/20/solid";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { useRef, useState } from "react";
import { WarmStartIconWithTooltip } from "~/components/WarmStarts";
import { Badge } from "~/components/primitives/Badge";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Popover, PopoverArrowTrigger, PopoverContent } from "~/components/primitives/Popover";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type ResizableSnapshot,
} from "~/components/primitives/Resizable";
import { Slider } from "~/components/primitives/Slider";
import { TreeView, useTree } from "~/components/primitives/TreeView/TreeView";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { SpanTitle } from "~/components/runs/v3/SpanTitle";
import { TaskRunStatusIcon, runStatusClassNameColor } from "~/components/runs/v3/TaskRunStatus";
import { cn } from "~/utils/cn";
import { resizableSettings } from "./resizableSettings";
import { TimelineView } from "./TimelineView";
import { KeyboardShortcuts, type TreeShortcutOptions } from "./TraceShortcuts";
import { type TraceEvent } from "./types";

export type TasksTreeViewProps = {
  events: TraceEvent[];
  selectedId?: string;
  onSelectedIdChanged: (selectedId: string | undefined) => void;
  totalDuration: number;
  rootSpanStatus: "executing" | "completed" | "failed";
  rootStartedAt: Date | undefined;
  queuedDuration: number | undefined;
  environmentType: RuntimeEnvironmentType;
  /** Shown above the tree, e.g. links to the root and parent runs. */
  header: React.ReactNode;
  /** Badge the root span as "Root". */
  showRootBadge: boolean;
  isCompleted: boolean;
  treeSnapshot?: ResizableSnapshot;
  /** Saves the tree/timeline split; pages with their own layout pass their own. */
  treeAutosaveId?: string;
  autoFocus?: boolean;
  shortcuts?: TreeShortcutOptions;
  /** Extra footer hints, after the arrow keys and after the level keys. */
  shortcutHints?: { afterNavigation?: React.ReactNode; trailing?: React.ReactNode };
  errorsOnly: boolean;
  filterText: string;
  showQueueTime: boolean;
};

export function TasksTreeView({
  events,
  selectedId,
  onSelectedIdChanged,
  totalDuration,
  rootSpanStatus,
  rootStartedAt,
  queuedDuration,
  environmentType,
  header,
  showRootBadge,
  isCompleted,
  treeSnapshot,
  treeAutosaveId = resizableSettings.tree.autosaveId,
  autoFocus = true,
  shortcuts,
  shortcutHints,
  errorsOnly,
  filterText,
  showQueueTime,
}: TasksTreeViewProps) {
  const [showDurations] = useState(true);
  const [scale, setScale] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const displayEvents = events;
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
    tree: displayEvents,
    selectedId,
    // collapsedIds,
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

  const shortcutProps = {
    enabled: shortcuts?.enabled ?? true,
    onExpandAll: shortcuts?.onExpandAll ?? (() => expandAllBelowDepth(0)),
    onCollapseAll: shortcuts?.onCollapseAll ?? (() => collapseAllBelowDepth(1)),
    onToggleLevel: shortcuts?.onToggleLevel ?? toggleExpandLevel,
    afterNavigation: shortcutHints?.afterNavigation,
    trailing: shortcutHints?.trailing,
  };

  const getInteractiveNodeProps = (id: string) => ({
    ...getNodeProps(id),
    onClick: () => selectNode(id),
  });

  return (
    <div className="grid h-full grid-rows-[1fr_3.25rem] overflow-hidden">
      <ResizablePanelGroup autosaveId={treeAutosaveId} snapshot={treeSnapshot}>
        {/* Tree list */}
        <ResizablePanel
          id={resizableSettings.tree.tree.id}
          default={resizableSettings.tree.tree.default}
          min={resizableSettings.tree.tree.min}
        >
          <div className="grid h-full grid-rows-[2rem_1fr] overflow-hidden">
            <div className="flex items-center justify-between pl-1 pr-2">{header}</div>
            <TreeView
              parentRef={parentRef}
              scrollRef={treeScrollRef}
              virtualizer={virtualizer}
              autoFocus={autoFocus}
              staticRowHeight
              tree={events}
              nodes={nodes}
              getNodeProps={getInteractiveNodeProps}
              getTreeProps={getTreeProps}
              parentClassName="pl-3"
              renderNode={({ node, state }) => (
                <SpanTreeRow
                  node={node}
                  isSelected={state.selected}
                  isExpanded={state.expanded}
                  canExpand={node.hasChildren}
                  showRootBadge={showRootBadge}
                  onChevronClick={(e) => {
                    if (e.altKey) {
                      if (state.expanded) {
                        collapseAllBelowDepth(node.level);
                      } else {
                        expandAllBelowDepth(node.level);
                      }
                    } else if (node.hasChildren) {
                      toggleExpandNode(node.id);
                    } else {
                      selectNode(node.id, false);
                    }
                    scrollToNode(node.id);
                    parentRef.current?.focus({ preventScroll: true });
                  }}
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
            parentRef={parentRef}
            timelineScrollRef={timelineScrollRef}
            nodes={nodes}
            getNodeProps={getNodeProps}
            getTreeProps={getTreeProps}
            showDurations={showDurations}
            treeScrollRef={treeScrollRef}
            virtualizer={virtualizer}
            toggleNodeSelection={toggleNodeSelection}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-4">
        <div className="grow @container">
          <div className="hidden items-center gap-4 @[48rem]:flex">
            <KeyboardShortcuts {...shortcutProps} />
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
                  <KeyboardShortcuts {...shortcutProps} />
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

/** One span's row in the tree: indent lines, expand chevron, icon, title and status. */
export function SpanTreeRow({
  node,
  isSelected,
  isExpanded,
  canExpand,
  showRootBadge,
  onChevronClick,
}: {
  node: TraceEvent;
  isSelected: boolean;
  isExpanded: boolean;
  /** Shows the chevron; a run whose spans aren't loaded yet can expand with no children. */
  canExpand: boolean;
  showRootBadge: boolean;
  onChevronClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div
      className={cn(
        "group/spannode flex h-8 cursor-pointer items-center overflow-hidden rounded-l-sm pr-2",
        isSelected ? "bg-grid-dimmed hover:bg-grid-bright" : "bg-transparent hover:bg-grid-dimmed"
      )}
    >
      <div className="flex h-8 items-center">
        {Array.from({ length: node.level }).map((_, index) => (
          <TaskLine key={index} isError={node.data.isError} isSelected={isSelected} />
        ))}
        <button
          type="button"
          tabIndex={-1}
          aria-label={canExpand ? (isExpanded ? "Collapse task" : "Expand task") : "Select task"}
          className={cn(
            "flex h-8 w-4 items-center focus-custom",
            canExpand && "hover:bg-surface-control"
          )}
          onClick={(e) => {
            e.stopPropagation();
            onChevronClick(e);
          }}
        >
          {canExpand ? (
            isExpanded ? (
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
            name={
              node.data.isAgentRun &&
              (node.data.style?.icon === "task" || node.data.style?.icon === "task-cached")
                ? "agent"
                : node.data.style?.icon
            }
            spanName={node.data.message}
            className="size-5 min-h-5 min-w-5"
          />
          <NodeText node={node} />
          {node.data.isRoot && showRootBadge && <Badge variant="extra-small">Root</Badge>}
        </div>
        <div className="flex items-center gap-1">
          <NodeStatusIcon node={node} />
        </div>
      </div>
    </div>
  );
}

function NodeText({ node }: { node: TraceEvent }) {
  const className = "truncate";
  // Only mark task-level spans as agent so the agents colour applies to
  // the task row itself, not unrelated sub-spans (wait/log/etc.) that
  // live underneath an agent run.
  const isAgentTaskRow =
    node.data.isAgentRun &&
    (node.data.style?.icon === "task" || node.data.style?.icon === "task-cached");
  return (
    <Paragraph variant="small" className={cn(className)}>
      <SpanTitle {...node.data} size="small" isAgentRun={isAgentTaskRow} />
    </Paragraph>
  );
}

function NodeStatusIcon({ node }: { node: TraceEvent }) {
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

function TaskLine({ isError, isSelected }: { isError: boolean; isSelected: boolean }) {
  return <div className={cn("h-8 w-2 border-r border-grid-bright")} />;
}
