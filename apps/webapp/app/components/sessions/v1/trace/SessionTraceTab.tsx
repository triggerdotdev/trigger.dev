import {
  ChevronDownIcon,
  ChevronRightIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
} from "@heroicons/react/20/solid";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type ResizableSnapshot,
} from "~/components/primitives/Resizable";
import { Slider } from "~/components/primitives/Slider";
import { Spinner } from "~/components/primitives/Spinner";
import * as Timeline from "~/components/primitives/Timeline";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { TreeView, useTree } from "~/components/primitives/TreeView/TreeView";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import { SpanTreeRow } from "~/components/runs/v3/trace/TasksTreeView";
import type { TraceTimelineScale } from "~/components/runs/v3/trace/timelineScale";
import type { TraceEvent } from "~/components/runs/v3/trace/types";
import { useInitialDimensions } from "~/hooks/useInitialDimensions";
import { useInterval } from "~/hooks/useInterval";
import { cn } from "~/utils/cn";
import { isFinalRunStatus } from "~/v3/taskStatus";
import { buildSessionTree, isSelectableRow, type SessionTreeRow } from "./buildSessionTree";
import { RunTraceSource, type RunTraceSnapshot } from "./RunTraceSource";
import { SessionTimelineRow } from "./SessionTimelineRow";
import {
  createSessionRunLoads,
  runLoad,
  runLoadId,
  sessionRunLoadsReducer,
  type SessionRunLoad,
  type SessionRunLoadOutcome,
} from "./sessionRunLoads";
import {
  initiallyExpandedRunFriendlyId,
  liveRunFriendlyId,
  newestRunFriendlyId,
  newRunsPollIntervalMs,
  runDuration,
  runTimelineScale,
} from "./sessionRunTiming";
import type { SessionTraceRun } from "./sessionTraceTypes";
import { SESSION_TREE_AUTOSAVE_ID, runReasonLabel } from "./sessionTraceView";
import { RUNS_PAGE_SIZE, useSessionRunPages } from "./useSessionRunPages";

const ROW_HEIGHT_PX = 32;

// Load states whose trace source stays mounted: collapsing a run keeps its spans.
// A failed run stays mounted too, so the spans it did load stay on screen.
const MOUNTED_LOAD_STATES = new Set<SessionRunLoad["state"]>([
  "loading",
  "paging",
  "progressive",
  "empty",
  "error",
]);
const IN_FLIGHT_LOAD_STATES = new Set<SessionRunLoad["state"]>(["queued", "loading", "paging"]);

/** The session's runs as one tree, newest page first, with earlier pages on request. */
export function SessionTraceTab({
  runsPath,
  treeSnapshot,
}: {
  runsPath: string;
  treeSnapshot: ResizableSnapshot | undefined;
}) {
  const pages = useSessionRunPages(runsPath);

  // New runs: re-read the newest page while the tab is visible (focus also refreshes it). It
  // lives here, not in the tree, so a session with no runs yet still picks up its first one.
  const [checkedAtMs, setCheckedAtMs] = useState(() => Date.now());
  useInterval({
    interval: newRunsPollIntervalMs(pages.runs ?? [], pages.totalCount, checkedAtMs),
    disabled: pages.state.status !== "ready",
    onLoad: false,
    callback: () => {
      setCheckedAtMs(Date.now());
      pages.refreshNewest();
    },
  });

  if (pages.state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center gap-2 bg-background-bright">
        <Spinner className="size-4" />
        <Paragraph variant="small/dimmed">Loading runs…</Paragraph>
      </div>
    );
  }

  if (pages.state.status === "error" || !pages.runs) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-background-bright">
        <Paragraph variant="small/dimmed">
          {pages.state.status === "error" ? pages.state.message : "Couldn't load runs."}
        </Paragraph>
        <Button variant="secondary/small" onClick={pages.retry}>
          Try again
        </Button>
      </div>
    );
  }

  if (pages.runs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-background-bright">
        <Paragraph variant="small/dimmed">No runs yet.</Paragraph>
      </div>
    );
  }

  return (
    <SessionTraceTree
      runs={pages.runs}
      totalCount={pages.totalCount}
      canLoadEarlier={pages.canLoadEarlier}
      loadingEarlier={pages.loadingEarlier}
      earlierError={pages.earlierError}
      onLoadEarlier={pages.loadEarlier}
      onRunDataStale={pages.refreshNewest}
      treeSnapshot={treeSnapshot}
    />
  );
}

type SpanData = TraceEvent["data"];
type Row = SessionTreeRow<SpanData>;

function SessionTraceTree({
  runs,
  totalCount,
  canLoadEarlier,
  loadingEarlier,
  earlierError,
  onLoadEarlier,
  onRunDataStale,
  treeSnapshot,
}: {
  runs: SessionTraceRun[];
  totalCount: number;
  canLoadEarlier: boolean;
  loadingEarlier: boolean;
  earlierError: string | undefined;
  onLoadEarlier: () => void;
  onRunDataStale: () => void;
  treeSnapshot: ResizableSnapshot | undefined;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0);

  // Captured once: runs added later (earlier pages, new runs) start collapsed.
  const [openRunId] = useState(() => initiallyExpandedRunFriendlyId(runs, totalCount));
  const [loads, dispatchLoads] = useReducer(sessionRunLoadsReducer, openRunId, (id) =>
    createSessionRunLoads(id ? [id] : [])
  );
  const [snapshots, setSnapshots] = useState<Record<string, RunTraceSnapshot>>({});
  const onSnapshot = useCallback(
    (runFriendlyId: string, snapshot: RunTraceSnapshot | undefined) =>
      setSnapshots((prev) => {
        if (snapshot) return { ...prev, [runFriendlyId]: snapshot };
        if (!(runFriendlyId in prev)) return prev;
        const { [runFriendlyId]: _removed, ...rest } = prev;
        return rest;
      }),
    []
  );
  const onSettle = useCallback(
    (runFriendlyId: string, loadId: number, outcome: SessionRunLoadOutcome) =>
      dispatchLoads({ type: "settle", runFriendlyId, loadId, outcome }),
    []
  );
  const onSpansChanged = useCallback(
    (runFriendlyId: string, hasSpans: boolean) =>
      dispatchLoads({ type: "spansChanged", runFriendlyId, hasSpans }),
    []
  );

  const spansByRun = useMemo(
    () => new Map(Object.entries(snapshots).map(([id, snapshot]) => [id, snapshot.events])),
    [snapshots]
  );
  const { tree, structureKey } = useMemo(
    () => buildSessionTree<SpanData>({ runs, totalCount, spansByRun }),
    [runs, totalCount, spansByRun]
  );
  const rowsById = useMemo(() => new Map(tree.map((node) => [node.id, node.data])), [tree]);
  const runsById = useMemo(() => new Map(runs.map((run) => [run.friendlyId, run])), [runs]);
  const liveRunId = liveRunFriendlyId(runs, totalCount);
  const newestRunId = newestRunFriendlyId(runs, totalCount);

  // The reducer decides what loads; it only needs to know which runs can and which is newest.
  const runsWithStatus = useMemo(
    () => runs.filter((run) => run.status).map((run) => run.friendlyId),
    [runs]
  );
  useEffect(() => {
    dispatchLoads({ type: "runsChanged", withStatus: runsWithStatus, newestRunId });
  }, [runsWithStatus, newestRunId]);

  // Only the live run's scale moves with the clock; the rest are fixed at page load.
  const [openedAtMs] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(openedAtMs);
  useInterval({ interval: 1_000, disabled: !liveRunId, callback: () => setNowMs(Date.now()) });
  const settledScales = useMemo(() => {
    const scales = new Map<string, TraceTimelineScale>();
    for (const run of runs) {
      if (run.friendlyId === liveRunId) continue;
      scales.set(run.friendlyId, runScale(run, snapshots[run.friendlyId], openedAtMs));
    }
    return scales;
  }, [runs, snapshots, liveRunId, openedAtMs]);
  const liveRun = liveRunId ? runsById.get(liveRunId) : undefined;
  const liveScale = liveRun ? runScale(liveRun, snapshots[liveRun.friendlyId], nowMs) : undefined;
  const scaleOfRun = (runFriendlyId: string) =>
    runFriendlyId === liveRunId ? liveScale : settledScales.get(runFriendlyId);

  const {
    nodes,
    getTreeProps,
    getNodeProps,
    selectNode,
    toggleExpandNode,
    expandNode,
    collapseNode,
    virtualizer,
  } = useTree<Row, undefined>({
    tree,
    parentRef,
    estimatedRowHeight: () => ROW_HEIGHT_PX,
    isCollapsedByDefault: (node) =>
      node.data.kind === "run" && node.data.run.friendlyId !== openRunId,
    canExpand: (node) => node.data.kind === "run" || node.hasChildren,
    structureKey,
    onExpandedChange: (id, expanded) => {
      const row = rowsById.get(id);
      if (row?.kind === "run") {
        dispatchLoads({ type: "expanded", runFriendlyId: row.run.friendlyId, expanded });
      }
    },
  });

  // Visible rows: the tree takes a new list in an effect, so scroll fixes wait for this to change.
  const visibleRowCount = virtualizer.options.count;

  // Open at the latest run, like the conversation.
  const openedAtLatest = useRef(false);
  useLayoutEffect(() => {
    if (openedAtLatest.current || visibleRowCount === 0) return;
    openedAtLatest.current = true;
    virtualizer.scrollToIndex(visibleRowCount - 1, { align: "end" });
  }, [virtualizer, visibleRowCount]);

  // Earlier runs are added above; move down by the added rows so the view stays put.
  const earlierLoad = useRef<{ visibleRows: number; treeRows: number } | null>(null);
  const oldestRunNodeId = tree.find((node) => node.data.kind === "run")?.id;
  useLayoutEffect(() => {
    const pending = earlierLoad.current;
    if (!pending || loadingEarlier) return;
    // Failed, or one run took the load-earlier row's place: nothing above the view moved.
    if (tree.length === pending.treeRows) {
      earlierLoad.current = null;
      return;
    }
    // Wait until the tree has taken the new list: the new oldest run then has a node.
    if (!oldestRunNodeId || !(oldestRunNodeId in nodes)) return;
    earlierLoad.current = null;
    const added = visibleRowCount - pending.visibleRows;
    if (added > 0 && parentRef.current) parentRef.current.scrollTop += added * ROW_HEIGHT_PX;
  }, [loadingEarlier, tree.length, oldestRunNodeId, nodes, visibleRowCount]);

  const loadEarlier = () => {
    earlierLoad.current = { visibleRows: visibleRowCount, treeRows: tree.length };
    onLoadEarlier();
  };

  // Follow the newest run's new spans, but only if the view was at the bottom when they arrived.
  // The tree takes the new rows a render later, so scroll once its node state has changed.
  const atBottom = useRef(true);
  const newestSpanCount = newestRunId ? (snapshots[newestRunId]?.events.length ?? 0) : 0;
  const pendingFollow = useRef<{ nodes: typeof nodes } | null>(null);
  const latestNodes = useRef(nodes);
  useLayoutEffect(() => {
    const pending = pendingFollow.current;
    latestNodes.current = nodes;
    if (!pending || pending.nodes === nodes) return;
    pendingFollow.current = null;
    // A span that didn't change the tree leaves this pending; don't jump if the user scrolled up.
    const scrollElement = parentRef.current;
    if (scrollElement && atBottom.current) scrollElement.scrollTop = scrollElement.scrollHeight;
  }, [nodes]);
  const followedSpanCount = useRef(newestSpanCount);
  useLayoutEffect(() => {
    if (followedSpanCount.current === newestSpanCount) return;
    followedSpanCount.current = newestSpanCount;
    pendingFollow.current =
      atBottom.current && !earlierLoad.current ? { nodes: latestNodes.current } : null;
  }, [newestSpanCount]);

  const runNodeIds = tree.filter((node) => node.data.kind === "run").map((node) => node.id);
  const allExpanded = runNodeIds.every((id) => nodes[id]?.expanded);
  const toggleAll = () => {
    for (const id of runNodeIds) {
      if (allExpanded) collapseNode(id);
      else expandNode(id, false);
    }
  };

  const selectRow = (id: string) => {
    const row = rowsById.get(id);
    if (row && isSelectableRow(row)) selectNode(id);
  };
  const scaleForRow = (row: Row) =>
    row.kind === "run"
      ? scaleOfRun(row.run.friendlyId)
      : row.kind === "span"
        ? scaleOfRun(row.runFriendlyId)
        : undefined;

  return (
    <div className="grid h-full grid-rows-[2.25rem_1fr_2.5rem] overflow-hidden bg-background-bright">
      {runs.map((run) => {
        const load = runLoad(loads, run.friendlyId);
        if (!run.status || !MOUNTED_LOAD_STATES.has(load.state)) return null;
        // Keyed by attempt: a retry or a fresh read starts from scratch, never from the old trace.
        return (
          <RunTraceSource
            key={`${run.friendlyId}:${runLoadId(load)}`}
            run={{ ...run, status: run.status }}
            load={load}
            live={run.friendlyId === newestRunId}
            onSettle={onSettle}
            onSnapshot={onSnapshot}
            onSpansChanged={onSpansChanged}
            onRunDataStale={onRunDataStale}
          />
        );
      })}
      <div className="flex items-center justify-end gap-2 border-b border-grid-bright px-3">
        <Button variant="tertiary/small" onClick={toggleAll}>
          {/* Both labels share one cell so the button keeps the wider one's width. */}
          <span className="inline-grid">
            <span className="invisible col-start-1 row-start-1">Collapse all</span>
            <span className="col-start-1 row-start-1 text-center">
              {allExpanded ? "Collapse all" : "Expand all"}
            </span>
          </span>
        </Button>
      </div>
      <ResizablePanelGroup autosaveId={SESSION_TREE_AUTOSAVE_ID} snapshot={treeSnapshot}>
        <ResizablePanel id="session-tree" default="50%" min="50px">
          <div className="grid h-full grid-rows-[2rem_1fr] overflow-hidden">
            <div />
            <TreeView
              parentRef={parentRef}
              scrollRef={treeScrollRef}
              virtualizer={virtualizer}
              staticRowHeight
              tree={tree}
              nodes={nodes}
              // No keyboard navigation until selection lands: keys would stop on label rows.
              getTreeProps={() => ({ ...getTreeProps(), onKeyDown: undefined })}
              getNodeProps={(id) => ({ ...getNodeProps(id), onClick: () => selectRow(id) })}
              parentClassName="pl-3"
              renderNode={({ node, state }) =>
                node.data.kind === "span" ? (
                  <SpanTreeRow
                    node={{ ...node, data: node.data.span } as TraceEvent}
                    isSelected={state.selected}
                    isExpanded={state.expanded}
                    canExpand={node.hasChildren}
                    showRootBadge={false}
                    onChevronClick={() => toggleExpandNode(node.id, false)}
                  />
                ) : (
                  <SessionTreeRowView
                    row={node.data}
                    level={node.level}
                    isSelected={state.selected}
                    isExpanded={state.expanded}
                    canExpand={node.data.kind === "run" || node.hasChildren}
                    onToggle={() => toggleExpandNode(node.id, false)}
                    isLive={node.data.kind === "run" && node.data.run.friendlyId === liveRunId}
                    load={
                      node.data.kind === "run"
                        ? runLoad(loads, node.data.run.friendlyId)
                        : undefined
                    }
                    canLoadEarlier={canLoadEarlier}
                    loadingEarlier={loadingEarlier}
                    earlierError={earlierError}
                    onLoadEarlier={loadEarlier}
                  />
                )
              }
              onScroll={(scrollTop) => {
                const element = treeScrollRef.current;
                if (element) {
                  atBottom.current =
                    scrollTop + element.clientHeight >= element.scrollHeight - ROW_HEIGHT_PX;
                }
                const timeline = timelineScrollRef.current;
                if (timeline && Math.abs(timeline.scrollTop - scrollTop) >= 0.5) {
                  timeline.scrollTop = scrollTop;
                }
              }}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle id="session-tree-handle" />
        <ResizablePanel id="session-timeline" default="50%" min="50px">
          <SessionTimelineColumn zoom={zoom}>
            <TreeView
              scrollRef={timelineScrollRef}
              virtualizer={virtualizer}
              staticRowHeight
              tree={tree}
              nodes={nodes}
              getNodeProps={getNodeProps}
              getTreeProps={() => ({ ...getTreeProps(), onKeyDown: undefined })}
              parentClassName="h-full scrollbar-hide"
              renderNode={({ node, state }) => (
                <SessionTimelineRow
                  node={node}
                  row={node.data}
                  isSelected={state.selected}
                  scale={scaleForRow(node.data)}
                  isLiveRun={node.data.kind === "span" && node.data.runFriendlyId === liveRunId}
                  onClick={() => selectRow(node.id)}
                />
              )}
              onScroll={(scrollTop) => {
                const tree = treeScrollRef.current;
                if (tree && Math.abs(tree.scrollTop - scrollTop) >= 0.5) tree.scrollTop = scrollTop;
              }}
            />
          </SessionTimelineColumn>
        </ResizablePanel>
      </ResizablePanelGroup>
      <div className="flex items-center justify-end gap-2 border-t border-grid-dimmed px-4">
        <Slider
          variant="tertiary"
          className="w-20"
          LeadingIcon={MagnifyingGlassMinusIcon}
          TrailingIcon={MagnifyingGlassPlusIcon}
          value={[zoom]}
          onValueChange={(value) => setZoom(value[0])}
          min={0}
          max={1}
          step={0.05}
        />
      </div>
    </div>
  );
}

function runScale(run: SessionTraceRun, snapshot: RunTraceSnapshot | undefined, nowMs: number) {
  return runTimelineScale({
    run,
    traceDurationNs: snapshot?.duration ?? 0,
    rootStartedAt: snapshot?.rootStartedAt ?? run.createdAt ?? undefined,
    nowMs,
  });
}

// Each run has its own scale, so the column's own range only sets the width the zoom scales.
function SessionTimelineColumn({ zoom, children }: { zoom: number; children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const minWidth = useInitialDimensions(containerRef)?.width ?? 300;

  return (
    <div
      ref={containerRef}
      className="h-full overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
    >
      <Timeline.Root
        durationMs={1}
        scale={zoom}
        minWidth={minWidth}
        maxWidth={minWidth * 10}
        className="h-full overflow-hidden"
      >
        <Timeline.Row className="grid h-full grid-rows-[2rem_1fr]">
          <div className="flex items-center px-2 text-xxs text-text-faint">
            Each run on its own scale
          </div>
          <Timeline.Row className="overflow-hidden">{children}</Timeline.Row>
        </Timeline.Row>
      </Timeline.Root>
    </div>
  );
}

function SessionTreeRowView({
  row,
  level,
  isSelected,
  isExpanded,
  canExpand,
  onToggle,
  isLive,
  load,
  canLoadEarlier,
  loadingEarlier,
  earlierError,
  onLoadEarlier,
}: {
  row: Row;
  level: number;
  isSelected: boolean;
  isExpanded: boolean;
  canExpand: boolean;
  onToggle: () => void;
  isLive: boolean;
  load: SessionRunLoad | undefined;
  canLoadEarlier: boolean;
  loadingEarlier: boolean;
  earlierError: string | undefined;
  onLoadEarlier: () => void;
}) {
  switch (row.kind) {
    case "loadEarlier": {
      const count = Math.min(row.count, RUNS_PAGE_SIZE);
      return (
        <RowFrame level={level}>
          <Button
            variant="secondary/small"
            disabled={!canLoadEarlier || loadingEarlier}
            LeadingIcon={loadingEarlier ? Spinner : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onLoadEarlier();
            }}
          >
            {loadingEarlier
              ? "Loading runs…"
              : `Load ${count} earlier run${count === 1 ? "" : "s"}`}
          </Button>
          {earlierError ? (
            <span className="text-xs text-error">Couldn't load earlier runs. Try again.</span>
          ) : (
            <span className="text-xs text-text-faint">{row.count} not shown</span>
          )}
        </RowFrame>
      );
    }
    case "notLoaded":
      return (
        <RowFrame level={level}>
          <span className="text-xs text-text-dimmed">
            {row.count} run{row.count === 1 ? "" : "s"} not loaded
          </span>
        </RowFrame>
      );
    case "gap":
      return (
        <RowFrame level={level}>
          <span className="whitespace-nowrap text-xs text-text-faint">
            {formatDurationMilliseconds(row.durationMs, { style: "short" })} with no activity
          </span>
          <span className="h-px flex-1 border-t border-dashed border-grid-bright" />
        </RowFrame>
      );
    case "session":
      return (
        <RowFrame
          level={level}
          isSelected={isSelected}
          canExpand={canExpand}
          isExpanded={isExpanded}
          onToggle={onToggle}
        >
          <RunIcon name="agent" spanName="session" className="size-5 min-w-5" />
          <span className="text-sm text-text-bright">Session</span>
          <span className="ml-auto pr-2 text-xs tabular-nums text-text-dimmed">
            {row.runCount} run{row.runCount === 1 ? "" : "s"}
          </span>
        </RowFrame>
      );
    case "run":
      return (
        <RowFrame
          level={level}
          isSelected={isSelected}
          canExpand={canExpand}
          isExpanded={isExpanded}
          onToggle={onToggle}
        >
          <RunRowContent
            run={row.run}
            isLive={isLive}
            isLoading={!!load && IN_FLIGHT_LOAD_STATES.has(load.state)}
          />
        </RowFrame>
      );
    case "span":
      return null;
  }
}

function RunRowContent({
  run,
  isLive,
  isLoading,
}: {
  run: SessionTraceRun;
  isLive: boolean;
  isLoading: boolean;
}) {
  return (
    <>
      <RunIcon name="task" spanName="run" className="size-5 min-w-5" />
      <SimpleTooltip
        button={
          <span className="shrink-0 whitespace-nowrap text-sm text-text-bright">
            Run {run.number}
          </span>
        }
        content={<span className="font-mono">{run.friendlyId}</span>}
        disableHoverableContent
      />
      {run.status ? (
        <TaskRunStatusCombo status={run.status} className="shrink-0 text-xs" />
      ) : (
        <span className="text-xs text-text-faint">–</span>
      )}
      <span className="min-w-0 truncate text-xs text-text-dimmed">{runReasonLabel(run)}</span>
      {isLoading && <Spinner className="size-3 shrink-0" />}
      <span className="ml-auto shrink-0 pr-2 text-xs tabular-nums text-text-dimmed">
        <RunDurationLabel run={run} isLive={isLive} />
      </span>
    </>
  );
}

// Only the live run counts up; an older unfinished run shows when it started instead.
function RunDurationLabel({ run, isLive }: { run: SessionTraceRun; isLive: boolean }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useInterval({ interval: 1_000, disabled: !isLive, callback: () => setNowMs(Date.now()) });

  const duration = runDuration(run, nowMs);
  if (!duration) return run.status && !isFinalRunStatus(run.status) ? <>Queued</> : null;
  if (duration.finished) return <>{formatDurationMilliseconds(duration.ms, { style: "short" })}</>;
  if (isLive) return <>{formatDurationMilliseconds(duration.ms, { style: "short" })} so far</>;
  return run.startedAt ? (
    <>
      Started <DateTime date={run.startedAt} />
    </>
  ) : null;
}

function RowFrame({
  level,
  isSelected = false,
  canExpand = false,
  isExpanded = false,
  onToggle,
  children,
}: {
  level: number;
  isSelected?: boolean;
  canExpand?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-8 items-center gap-1.5 overflow-hidden rounded-l-sm",
        isSelected ? "bg-grid-dimmed hover:bg-grid-bright" : "hover:bg-grid-dimmed"
      )}
    >
      {Array.from({ length: level }).map((_, index) => (
        <div key={index} className="h-8 w-2 shrink-0 border-r border-grid-bright" />
      ))}
      {canExpand ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          className="flex h-8 w-4 shrink-0 items-center hover:bg-surface-control"
          onClick={(event) => {
            event.stopPropagation();
            onToggle?.();
          }}
        >
          {isExpanded ? (
            <ChevronDownIcon className="size-4 text-text-dimmed" />
          ) : (
            <ChevronRightIcon className="size-4 text-text-dimmed" />
          )}
        </button>
      ) : (
        <div className="w-4 shrink-0" />
      )}
      {children}
    </div>
  );
}
