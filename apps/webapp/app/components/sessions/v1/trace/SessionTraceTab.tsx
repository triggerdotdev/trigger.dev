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
import { KeyboardShortcuts } from "~/components/runs/v3/trace/TraceShortcuts";
import type { TraceTimelineScale } from "~/components/runs/v3/trace/timelineScale";
import type { TraceEvent } from "~/components/runs/v3/trace/types";
import { useInitialDimensions } from "~/hooks/useInitialDimensions";
import { useInterval } from "~/hooks/useInterval";
import { cn } from "~/utils/cn";
import { isFinalRunStatus } from "~/v3/taskStatus";
import {
  buildSessionTree,
  isSelectableRow,
  runNodeId,
  type SessionTreeRow,
} from "./buildSessionTree";
import { RunTraceSource, type RunTraceSnapshot } from "./RunTraceSource";
import { SessionTimelineRow } from "./SessionTimelineRow";
import { type RunPanelData, useSessionPanelStore } from "./sessionPanelStore";
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
import {
  highlightedNodeId,
  isSameSelection,
  rowSelection,
  selectionNodeId,
  type SessionTraceSelection,
} from "./sessionTraceSelection";
import type { SessionTraceRun } from "./sessionTraceTypes";
import { SESSION_TREE_AUTOSAVE_ID, runReasonLabel } from "./sessionTraceView";
import {
  RUNS_FILL_MAX,
  RUNS_PAGE_SIZE,
  type LoadedRuns,
  useSessionRunPages,
} from "./useSessionRunPages";
import { useSessionTraceSelection } from "./useSessionTraceSelection";

const ROW_HEIGHT_PX = 32;
// Like the run page: arrowing through rows doesn't write the URL on every step.
const SELECTION_URL_DEBOUNCE_MS = 250;

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
  // A run in the URL when the tab opens is a deep link: its page is read with the newest one.
  const { selection, setSelection } = useSessionTraceSelection();
  const [deepLinkRunId] = useState(() =>
    selection.kind === "session" ? undefined : selection.runFriendlyId
  );
  const pages = useSessionRunPages(runsPath, deepLinkRunId);

  // A linked run that isn't in the session: drop it and say so until something is selected.
  const [runNotFound, setRunNotFound] = useState(false);
  const handledNotFound = useRef(false);
  useEffect(() => {
    if (pages.deepLink !== "notFound" || handledNotFound.current) return;
    handledNotFound.current = true;
    setRunNotFound(true);
    setSelection({ kind: "session" });
  }, [pages.deepLink, setSelection]);
  const showRunNotFound = runNotFound && selection.kind === "session";

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
      view={pages.view}
      totalCount={pages.totalCount}
      canLoadEarlier={pages.canLoadEarlier}
      loadingEarlier={pages.loadingEarlier}
      earlierError={pages.earlierError}
      onLoadEarlier={pages.loadEarlier}
      olderLoadBusy={pages.olderLoadBusy}
      fillingRunFriendlyId={pages.fillingRunFriendlyId}
      fillFailedRunFriendlyId={pages.fillFailedRunFriendlyId}
      onFillHole={pages.fillHole}
      onRunDataStale={pages.refreshNewest}
      treeSnapshot={treeSnapshot}
      notice={showRunNotFound ? "That run isn't in this session." : undefined}
    />
  );
}

type SpanData = TraceEvent["data"];
type Row = SessionTreeRow<SpanData>;

function SessionTraceTree({
  runs,
  view,
  totalCount,
  canLoadEarlier,
  loadingEarlier,
  earlierError,
  onLoadEarlier,
  olderLoadBusy,
  fillingRunFriendlyId,
  fillFailedRunFriendlyId,
  onFillHole,
  onRunDataStale,
  treeSnapshot,
  notice,
}: {
  runs: SessionTraceRun[];
  view: LoadedRuns["view"];
  totalCount: number;
  canLoadEarlier: boolean;
  loadingEarlier: boolean;
  earlierError: string | undefined;
  onLoadEarlier: () => void;
  olderLoadBusy: boolean;
  fillingRunFriendlyId: string | undefined;
  fillFailedRunFriendlyId: string | undefined;
  onFillHole: (newerRunFriendlyId: string, missing: number) => void;
  onRunDataStale: () => void;
  treeSnapshot: ResizableSnapshot | undefined;
  notice: string | undefined;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0);

  // The URL holds the selection. A click or arrow key sets the intended selection at once and
  // writes the URL after a pause. Any URL selection change, ours catching up or one from
  // elsewhere (closing a panel), clears it, so the URL wins.
  const { selection, setSelection } = useSessionTraceSelection();
  const selectedNodeId = selectionNodeId(selection);
  const [local, setLocal] = useState<SessionTraceSelection>();
  const [localFor, setLocalFor] = useState(selectedNodeId);
  if (localFor !== selectedNodeId) {
    setLocalFor(selectedNodeId);
    setLocal(undefined);
  }
  const intended = local ?? selection;

  // Captured once: runs added later (earlier pages, new runs) start collapsed.
  const [openRunId] = useState(() => initiallyExpandedRunFriendlyId(runs, totalCount));
  // A selection in the URL at mount whose run loaded: open there instead of at the bottom.
  const [deepLink] = useState(() => {
    if (selection.kind === "session") return undefined;
    if (!runs.some((run) => run.friendlyId === selection.runFriendlyId)) return undefined;
    return selection;
  });
  const [loads, dispatchLoads] = useReducer(sessionRunLoadsReducer, undefined, () => {
    const initial = createSessionRunLoads(openRunId ? [openRunId] : []);
    return deepLink
      ? sessionRunLoadsReducer(initial, {
          type: "deepLinked",
          runFriendlyId: deepLink.runFriendlyId,
        })
      : initial;
  });
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

  // The side panel is a sibling: it reads run span ids and live panel data from the store.
  const panelStore = useSessionPanelStore();
  useEffect(() => {
    panelStore?.setRunSpanIds(view);
  }, [panelStore, view]);
  const onPanelData = useCallback(
    (runFriendlyId: string, data: RunPanelData | undefined) =>
      panelStore?.setRunData(runFriendlyId, data),
    [panelStore]
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

  const highlightedId = highlightedNodeId(intended, (id) => rowsById.has(id));
  const pendingUrlWrite = local && !isSameSelection(local, selection) ? local : undefined;
  useEffect(() => {
    if (!pendingUrlWrite) return;
    const timer = setTimeout(() => setSelection(pendingUrlWrite), SELECTION_URL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [pendingUrlWrite, setSelection]);

  const {
    selected,
    nodes,
    getTreeProps,
    getNodeProps,
    selectNode,
    toggleExpandNode,
    expandNode,
    collapseNode,
    expandLevel,
    collapseLevel,
    scrollToNode,
    virtualizer,
  } = useTree<Row, undefined>({
    tree,
    parentRef,
    estimatedRowHeight: () => ROW_HEIGHT_PX,
    // Arrow keys, Home and End skip the gap, "not loaded" and "Load earlier" rows.
    canSelect: (node) => isSelectableRow(node.data),
    isCollapsedByDefault: (node) =>
      node.data.kind === "run" &&
      node.data.run.friendlyId !== openRunId &&
      node.data.run.friendlyId !== deepLink?.runFriendlyId,
    canExpand: (node) => node.data.kind === "run" || node.hasChildren,
    structureKey,
    // Derived, never set by code: a span not in the tree yet highlights its run.
    selectedId: highlightedId,
    // Changes that match the highlight come from the prop; only the user's become intent.
    onSelectedIdChanged: (id) => {
      if (!id || id === highlightedId) return;
      const row = rowsById.get(id);
      const next = row ? rowSelection(row) : undefined;
      if (next) setLocal(next);
    },
    onExpandedChange: (id, expanded) => {
      const row = rowsById.get(id);
      if (row?.kind === "run") {
        dispatchLoads({ type: "expanded", runFriendlyId: row.run.friendlyId, expanded });
      }
    },
  });

  // Visible rows: the tree takes a new list in an effect, so scroll fixes wait for this to change.
  const visibleRowCount = virtualizer.options.count;

  // Deep link: reveal the linked row (open its parents, centre it) the first time it's in the
  // tree. It never selects, so it can't override a row picked while the linked run loads.
  const pendingScroll = useRef<string | undefined>(
    deepLink ? runNodeId(deepLink.runFriendlyId) : undefined
  );
  // Built once per tree, and only while a deep link needs it.
  const parentByIdCache = useRef<{
    tree: typeof tree;
    parentById: Map<string, string | undefined>;
  }>();
  const ancestorsOf = useCallback(
    (id: string) => {
      let cached = parentByIdCache.current;
      if (cached?.tree !== tree) {
        cached = { tree, parentById: new Map(tree.map((node) => [node.id, node.parentId])) };
        parentByIdCache.current = cached;
      }
      const { parentById } = cached;
      const ancestors: string[] = [];
      for (let parent = parentById.get(id); parent; parent = parentById.get(parent)) {
        ancestors.push(parent);
      }
      return ancestors;
    },
    [tree]
  );
  const revealedDeepLink = useRef(deepLink === undefined);
  const deepLinkStillIntended = deepLink !== undefined && isSameSelection(intended, deepLink);
  useLayoutEffect(() => {
    if (!deepLink || revealedDeepLink.current) return;
    if (!deepLinkStillIntended) {
      revealedDeepLink.current = true;
      return;
    }
    const target = selectionNodeId(deepLink);
    if (!(target in nodes)) return;
    revealedDeepLink.current = true;
    for (const ancestor of ancestorsOf(target)) {
      if (!nodes[ancestor]?.expanded) expandNode(ancestor, false);
    }
    pendingScroll.current = target;
  }, [deepLink, deepLinkStillIntended, nodes, ancestorsOf, expandNode]);
  // Scrolling, a click or a key in the tab means the user has moved on: stop revealing.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || revealedDeepLink.current) return;
    const stopRevealing = () => {
      revealedDeepLink.current = true;
      pendingScroll.current = undefined;
    };
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const event of events) {
      container.addEventListener(event, stopRevealing, { passive: true, once: true });
    }
    return () => {
      for (const event of events) container.removeEventListener(event, stopRevealing);
    };
  }, []);
  useLayoutEffect(() => {
    const id = pendingScroll.current;
    if (!id || !(id in nodes)) return;
    if (ancestorsOf(id).some((ancestor) => !nodes[ancestor]?.expanded)) return;
    pendingScroll.current = undefined;
    scrollToNode(id, "center");
  }, [nodes, visibleRowCount, ancestorsOf, scrollToNode]);

  // The side panel opens a span once the tree has it, so a span route miss can't leave the page.
  // Read from the intended selection, so a clicked span is confirmed before its URL write.
  const intendedNodeId = selectionNodeId(intended);
  useEffect(() => {
    if (intended.kind !== "span" || !rowsById.has(intendedNodeId)) return;
    panelStore?.confirmSpan(intended.runFriendlyId, intended.spanId);
  }, [intended, intendedNodeId, rowsById, panelStore]);

  // Open at the latest run, like the conversation.
  const openedAtLatest = useRef(deepLink !== undefined);
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
  const atBottom = useRef(deepLink === undefined);
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

  // Run rows always expand and collapse one by one, so the load reducer hears about each.
  const runNodes = tree.filter((node) => node.data.kind === "run");
  const allExpanded = runNodes.every((node) => nodes[node.id]?.expanded);
  const expandAllRuns = () => {
    for (const node of runNodes) if (!nodes[node.id]?.expanded) expandNode(node.id, false);
  };
  const collapseAllRuns = () => {
    for (const node of runNodes) if (nodes[node.id]?.expanded) collapseNode(node.id);
  };
  const toggleAll = () => (allExpanded ? collapseAllRuns() : expandAllRuns());

  // Level keys never start a load: a run only has children once its spans are in, so the
  // tree's level actions only reach loaded runs. Those are opened first through expandNode.
  const expandLoadedToLevel = (level: number) => {
    for (const node of runNodes) {
      if (node.hasChildren && !nodes[node.id]?.expanded) expandNode(node.id, false);
    }
    expandLevel(level);
  };
  const collapseToLevel = (level: number) =>
    level <= 1 ? collapseAllRuns() : collapseLevel(level);
  const toggleLevel = (level: number) => {
    if (level <= 1) return collapseAllRuns();
    const first = tree.find((node) => node.level === level && node.hasChildren);
    if (!first) return;
    const state = nodes[first.id];
    if (state?.expanded && state.visible) collapseLevel(level);
    else expandLoadedToLevel(level);
  };

  // Escape goes back to the session; Alt+←/→ use the level rules above.
  const treeKeyDown = getTreeProps().onKeyDown;
  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      selectNode(selectionNodeId({ kind: "session" }));
      return;
    }
    if (event.altKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      const level = selected ? tree.find((node) => node.id === selected)?.level : undefined;
      if (level === undefined) return;
      if (event.key === "ArrowRight") expandLoadedToLevel(level);
      else collapseToLevel(level);
      return;
    }
    treeKeyDown?.(event);
  };

  // Keyboard focus stays on the tree, not the row: a selected row loses its tabIndex when the
  // selection moves on, which would drop focus to the page.
  const selectRow = (id: string) => {
    parentRef.current?.focus({ preventScroll: true });
    const row = rowsById.get(id);
    const next = row ? rowSelection(row) : undefined;
    if (!next) return;
    // The run row standing in for a span that isn't in the tree is already highlighted, so the
    // tree sees no change: clicking it picks the run.
    if (id === highlightedId && id !== intendedNodeId) {
      setLocal(next);
      return;
    }
    selectNode(id);
  };
  const scaleForRow = (row: Row) =>
    row.kind === "run"
      ? scaleOfRun(row.run.friendlyId)
      : row.kind === "span"
        ? scaleOfRun(row.runFriendlyId)
        : undefined;

  return (
    <div
      ref={containerRef}
      className="grid h-full grid-rows-[2.25rem_1fr_2.5rem] overflow-hidden bg-background-bright"
    >
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
            selectedSpanId={
              deepLink?.kind === "span" && deepLink.runFriendlyId === run.friendlyId
                ? deepLink.spanId
                : undefined
            }
            onSettle={onSettle}
            onSnapshot={onSnapshot}
            onSpansChanged={onSpansChanged}
            onPanelData={onPanelData}
            onRunDataStale={onRunDataStale}
          />
        );
      })}
      <div className="flex items-center justify-end gap-2 border-b border-grid-bright px-3">
        {notice && <span className="mr-auto truncate text-xs text-text-dimmed">{notice}</span>}
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
              getTreeProps={() => ({ ...getTreeProps(), onKeyDown: onTreeKeyDown })}
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
                    olderLoadBusy={olderLoadBusy}
                    fillingRunFriendlyId={fillingRunFriendlyId}
                    fillFailedRunFriendlyId={fillFailedRunFriendlyId}
                    onFillHole={onFillHole}
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
      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-4">
        <div className="flex items-center gap-4 overflow-hidden">
          <KeyboardShortcuts
            enabled
            onExpandAll={expandAllRuns}
            onCollapseAll={collapseAllRuns}
            onToggleLevel={toggleLevel}
          />
        </div>
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
  olderLoadBusy,
  fillingRunFriendlyId,
  fillFailedRunFriendlyId,
  onFillHole,
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
  olderLoadBusy: boolean;
  fillingRunFriendlyId: string | undefined;
  fillFailedRunFriendlyId: string | undefined;
  onFillHole: (newerRunFriendlyId: string, missing: number) => void;
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
    case "notLoaded": {
      // Filled from the newer side, so the runs appear under this row and it stays in place.
      const count = Math.min(row.count, RUNS_FILL_MAX);
      const filling = fillingRunFriendlyId === row.newerRunFriendlyId;
      return (
        <RowFrame level={level}>
          <Button
            variant="secondary/small"
            disabled={olderLoadBusy}
            LeadingIcon={filling ? Spinner : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onFillHole(row.newerRunFriendlyId, row.count);
            }}
          >
            {filling
              ? "Loading runs…"
              : count === row.count
                ? `Load ${count} run${count === 1 ? "" : "s"}`
                : `Load ${count} of ${row.count}`}
          </Button>
          {fillFailedRunFriendlyId === row.newerRunFriendlyId ? (
            <span className="text-xs text-error">Couldn't load these runs. Try again.</span>
          ) : (
            <span className="text-xs text-text-faint">{row.count} not loaded</span>
          )}
        </RowFrame>
      );
    }
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
