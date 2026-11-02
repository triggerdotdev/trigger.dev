import {
  ChevronDownIcon,
  ChevronRightIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
} from "@heroicons/react/20/solid";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Button, LinkButton } from "~/components/primitives/Buttons";
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
import { TraceFilters } from "~/components/runs/v3/trace/TraceToolbar";
import type { TraceTimelineScale } from "~/components/runs/v3/trace/timelineScale";
import type { TraceEvent } from "~/components/runs/v3/trace/types";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useInitialDimensions } from "~/hooks/useInitialDimensions";
import { useInterval } from "~/hooks/useInterval";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { formatNumber } from "~/utils/numberFormatter";
import { v3RunPath } from "~/utils/pathBuilder";
import { isFinalRunStatus } from "~/v3/taskStatus";
import {
  buildSessionTree,
  isSelectableRow,
  runNodeId,
  type SessionTreeRow,
} from "./buildSessionTree";
import { RunTraceSource, type RunTraceSnapshot } from "./RunTraceSource";
import {
  EMERGENCY_CAP_NOTICE,
  isRunStarting,
  runLoadBlock,
  runsUnavailableBeforeRead,
  unavailableReasonText,
  type RunLoadBlock,
} from "./sessionRunFallback";
import { SessionTimelineRow } from "./SessionTimelineRow";
import { type RunPanelData, useSessionPanelStore } from "./sessionPanelStore";
import {
  createSessionRunLoads,
  isRunTraceMounted,
  pageCheck,
  runLoad,
  runLoadId,
  runOpensExpanded,
  runSpanCount,
  sessionRunLoadsReducer,
  type SessionRunLoad,
  type SessionRunLoadOutcome,
  type SessionRunLoadsAction,
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
import {
  countMatches,
  isFiltering,
  NO_FILTER,
  runShowsResults,
  runsToCollapseOnClear,
  searchCoverage,
  sessionRowPassesFilter,
  type SearchCoverage,
  type SessionTraceFilter,
} from "./sessionTraceSearch";
import { newBudgetOutcomes, searchStarted, type BudgetOutcome } from "./sessionViewAnalytics";
import { useSessionViewAnalytics } from "./useSessionViewAnalytics";
import type { SessionTraceRun } from "./sessionTraceTypes";
import { SESSION_TREE_AUTOSAVE_ID, runReasonLabel } from "./sessionTraceView";
import {
  RUNS_FILL_MAX,
  RUNS_PAGE_SIZE,
  type LoadedRuns,
  type NewestPageReason,
  useSessionRunPages,
} from "./useSessionRunPages";
import { useSessionTraceSelection } from "./useSessionTraceSelection";

const ROW_HEIGHT_PX = 32;

function isScrolledToBottom(element: HTMLElement) {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - ROW_HEIGHT_PX;
}
// Like the run page: arrowing through rows doesn't write the URL on every step.
const SELECTION_URL_DEBOUNCE_MS = 250;

// Rows' clocks stop while the tab is hidden.
const TraceTabActiveContext = createContext(true);

/** The session's runs as one tree, newest page first, with earlier pages on request. */
export function SessionTraceTab({
  runsPath,
  treeSnapshot,
  active,
}: {
  runsPath: string;
  treeSnapshot: ResizableSnapshot | undefined;
  /** False while the Conversation tab is shown: the tab stays mounted but makes no requests. */
  active: boolean;
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
  const { refreshNewest } = pages;
  const checkNewest = useCallback(
    (reason: NewestPageReason) => {
      setCheckedAtMs(Date.now());
      refreshNewest(reason);
    },
    [refreshNewest]
  );
  useInterval({
    interval: newRunsPollIntervalMs(pages.runs ?? [], pages.totalCount, checkedAtMs),
    disabled: pages.state.status !== "ready" || !active,
    onLoad: false,
    onFocus: false,
    callback: () => checkNewest("poll"),
  });
  useInterval({
    disabled: pages.state.status !== "ready" || !active,
    onLoad: false,
    callback: () => checkNewest("focus"),
  });
  // Shown again after Conversation: check at once instead of waiting for the next poll.
  const wasActive = useRef(active);
  useEffect(() => {
    const shown = active && !wasActive.current;
    wasActive.current = active;
    if (shown && pages.state.status === "ready") checkNewest("focus");
  }, [active, pages.state.status, checkNewest]);

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
    <TraceTabActiveContext.Provider value={active}>
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
        checkedAtMs={checkedAtMs}
        treeSnapshot={treeSnapshot}
        notice={showRunNotFound ? "That run isn't in this session." : undefined}
        active={active}
      />
    </TraceTabActiveContext.Provider>
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
  checkedAtMs,
  treeSnapshot,
  notice,
  active,
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
  /** When the runs were last checked: a run still missing from the run store is judged by it. */
  checkedAtMs: number;
  treeSnapshot: ResizableSnapshot | undefined;
  notice: string | undefined;
  active: boolean;
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

  // Search and errors only. Runs Load all opens collapse again when the search is cleared,
  // unless the user expanded or collapsed them meanwhile, or they hold the selection.
  const [filter, setFilter] = useState<SessionTraceFilter>(NO_FILTER);
  const filtering = isFiltering(filter);
  const openedForSearch = useRef(new Set<string>());
  const touchedDuringSearch = useRef(new Set<string>());
  // Set while Load all or the clear handler move rows, so those moves aren't "touched".
  const searchMovingRows = useRef(false);

  // Captured once. Runs added later start collapsed, apart from a new newest run (the reducer).
  const [openRunId] = useState(() => initiallyExpandedRunFriendlyId(runs, totalCount));
  // A selection in the URL at mount whose run loaded: open there instead of at the bottom.
  const [deepLink] = useState(() => {
    if (selection.kind === "session") return undefined;
    if (!runs.some((run) => run.friendlyId === selection.runFriendlyId)) return undefined;
    return selection;
  });
  const [loads, reactDispatchLoads] = useReducer(sessionRunLoadsReducer, undefined, () => {
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
  // The page check runs between renders, so it reads a ref that every event updates at once,
  // with the same reducer React runs: a count or a release just sent is never missed.
  const loadsRef = useRef(loads);
  const track = useSessionViewAnalytics(runs.length);
  // Budget reached: each outcome once per page view (Expand all near the limit hits it often).
  const reportedBudget = useRef(new Set<BudgetOutcome>());
  const lastBudgetHits = useRef(loads.budgetHits);
  useEffect(() => {
    const outcomes = newBudgetOutcomes(
      lastBudgetHits.current,
      loads.budgetHits,
      reportedBudget.current
    );
    lastBudgetHits.current = loads.budgetHits;
    for (const outcome of outcomes) {
      reportedBudget.current.add(outcome);
      track("budget_reached", { outcome });
    }
  }, [loads.budgetHits, track]);
  const dispatchLoads = useCallback((action: SessionRunLoadsAction) => {
    loadsRef.current = sessionRunLoadsReducer(loadsRef.current, action);
    reactDispatchLoads(action);
  }, []);
  useEffect(() => {
    dispatchLoads({ type: "paused", paused: !active });
  }, [active, dispatchLoads]);
  const onSettle = useCallback(
    (runFriendlyId: string, loadId: number, outcome: SessionRunLoadOutcome) =>
      dispatchLoads({ type: "settle", runFriendlyId, loadId, outcome }),
    [dispatchLoads]
  );
  const onSpanCount = useCallback(
    (runFriendlyId: string, count: number) =>
      dispatchLoads({ type: "spanCount", runFriendlyId, count }),
    [dispatchLoads]
  );

  const onLoadedSpans = useCallback(
    (runFriendlyId: string, loaded: number) =>
      dispatchLoads({ type: "spansLoaded", runFriendlyId, loaded }),
    [dispatchLoads]
  );
  const askPage = useCallback(
    (runFriendlyId: string, loaded: number) => {
      const { allowed, action } = pageCheck(loadsRef.current, runFriendlyId, loaded);
      if (action) dispatchLoads(action);
      return allowed;
    },
    [dispatchLoads]
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
  const runsUnavailable = useMemo(() => runsUnavailableBeforeRead(view), [view]);
  useEffect(() => {
    dispatchLoads({
      type: "runsChanged",
      withStatus: runsWithStatus,
      unavailable: runsUnavailable,
      newestRunId,
    });
  }, [runsWithStatus, runsUnavailable, newestRunId, dispatchLoads]);

  // Runs that can't load here have no chevron, and Expand all and search leave them alone.
  const loadBlock = (run: SessionTraceRun) =>
    runLoadBlock(run, view[run.friendlyId], runLoad(loads, run.friendlyId));
  const rowCanExpand = (node: { data: Row; hasChildren: boolean }) =>
    node.data.kind === "run" ? !loadBlock(node.data.run) : node.hasChildren;
  // The cap applies to every run, so it's said once instead of on each row.
  const emergencyCap = Object.values(view).some((entry) => entry.unavailable === "emergencyCap");
  const barNotice = notice ?? (emergencyCap ? EMERGENCY_CAP_NOTICE : undefined);

  // Only the live run's scale moves with the clock; the rest are fixed at page load.
  const [openedAtMs] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(openedAtMs);
  useInterval({
    interval: 1_000,
    disabled: !liveRunId || !active,
    callback: () => setNowMs(Date.now()),
  });
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

  // The run holding the selected span keeps its spans under budget pressure.
  const selectedSpanRunId = intended.kind === "span" ? intended.runFriendlyId : undefined;
  useEffect(() => {
    dispatchLoads({ type: "selected", runFriendlyId: selectedSpanRunId });
  }, [selectedSpanRunId, dispatchLoads]);

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
    expandNodes,
    collapseNodes,
    expandLevel,
    collapseLevel,
    scrollToNode,
    virtualizer,
  } = useTree<Row, SessionTraceFilter>({
    tree,
    parentRef,
    estimatedRowHeight: () => ROW_HEIGHT_PX,
    // Arrow keys, Home and End skip the gap, "not loaded" and "Load earlier" rows.
    canSelect: (node) => isSelectableRow(node.data),
    // The load reducer owns which runs are expanded: the opening run, a deep link, a new run.
    isCollapsedByDefault: (node) =>
      node.data.kind === "run" &&
      !runOpensExpanded(loadsRef.current, node.data.run.friendlyId, newestRunId),
    canExpand: rowCanExpand,
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
        if (filtering && !searchMovingRows.current) {
          touchedDuringSearch.current.add(row.run.friendlyId);
        }
        dispatchLoads({ type: "expanded", runFriendlyId: row.run.friendlyId, expanded });
      }
    },
    // No value means no filter: the session row passing would otherwise hide every run's spans.
    filter: {
      value: filtering ? filter : undefined,
      fn: (value, node) => sessionRowPassesFilter(value, node.data),
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
  // After a deep link, following new spans waits for the user's own scroll, click or key: the
  // reveal can leave a short live trace at the bottom, and following from there would push the
  // linked row away. Until armed, scrolls don't update `atBottom`.
  const followArmed = useRef(deepLink === undefined);
  const atBottom = useRef(deepLink === undefined);
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
    expandNodes(ancestorsOf(target).filter((ancestor) => !nodes[ancestor]?.expanded));
    pendingScroll.current = target;
  }, [deepLink, deepLinkStillIntended, nodes, ancestorsOf, expandNodes]);
  // Scrolling, a click or a key in the tab means the user has moved on: stop revealing.
  useEffect(() => {
    const container = containerRef.current;
    // Until following is armed: a run link's reveal is already done by the time this runs.
    if (!container || followArmed.current) return;
    const stopRevealing = () => {
      revealedDeepLink.current = true;
      pendingScroll.current = undefined;
      followArmed.current = true;
      const scrollElement = parentRef.current;
      atBottom.current = scrollElement ? isScrolledToBottom(scrollElement) : false;
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

  // Follow a new run and the newest run's new spans, but only if the view was at the bottom when
  // they arrived. `atBottom` is tracked on scroll, so rows added without a scroll keep it true.
  // The tree takes the new rows a render later, so scroll once its node state has changed.
  const newestSpanCount = newestRunId ? (snapshots[newestRunId]?.events.length ?? 0) : 0;
  const followKey = `${newestRunId}:${newestSpanCount}`;
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
  const followedKey = useRef(followKey);
  useLayoutEffect(() => {
    if (followedKey.current === followKey) return;
    followedKey.current = followKey;
    pendingFollow.current =
      atBottom.current && !earlierLoad.current ? { nodes: latestNodes.current } : null;
  }, [followKey]);

  // Several run rows change in one tree pass; the load reducer still hears about each. Expand
  // all tells it first, newest first, so the newest runs load first; the per-row events that
  // follow change nothing.
  const runNodes = useMemo(() => tree.filter((node) => node.data.kind === "run"), [tree]);
  const expandableRunNodes = runNodes.filter(rowCanExpand);
  const allExpanded =
    expandableRunNodes.length > 0 && expandableRunNodes.every((node) => nodes[node.id]?.expanded);
  const expandAllRuns = () => {
    const collapsed = expandableRunNodes.filter((node) => !nodes[node.id]?.expanded);
    const newestFirst: SessionRunLoadsAction = {
      type: "expandedMany",
      runFriendlyIds: collapsed.flatMap((node) =>
        node.data.kind === "run" ? [node.data.run.friendlyId] : []
      ),
    };
    newestFirst.runFriendlyIds.reverse();
    track("expand_all", { runs: newestFirst.runFriendlyIds.length });
    dispatchLoads(newestFirst);
    expandNodes(collapsed.map((node) => node.id));
  };
  const retryRun = (runFriendlyId: string) => {
    track("retry");
    dispatchLoads({ type: "retry", runFriendlyId });
    const id = runNodeId(runFriendlyId);
    if (!nodes[id]?.expanded) expandNode(id, false);
  };
  const collapseAllRuns = () =>
    collapseNodes(runNodes.filter((node) => nodes[node.id]?.expanded).map((node) => node.id));
  // During a search a run's chevron shows or hides its matches; nothing loads or unloads.
  const hiddenRuns = useMemo(() => new Set(filter.hiddenRuns), [filter.hiddenRuns]);
  const setRunHidden = (runFriendlyId: string, hidden: boolean) =>
    setFilter((prev) => ({
      ...prev,
      hiddenRuns: hidden
        ? [...prev.hiddenRuns.filter((id) => id !== runFriendlyId), runFriendlyId]
        : prev.hiddenRuns.filter((id) => id !== runFriendlyId),
    }));
  const showsResults = (runFriendlyId: string) =>
    runShowsResults(runLoad(loads, runFriendlyId)) && !hiddenRuns.has(runFriendlyId);
  const runIsOpen = (row: Row, expanded: boolean) =>
    filtering && row.kind === "run" ? showsResults(row.run.friendlyId) : expanded;
  // A run that never loaded opens for real (it loads); a loaded run's results hide or show.
  const toggleRunInSearch = (runFriendlyId: string, open: boolean) => {
    const run = runsById.get(runFriendlyId);
    if (!run || loadBlock(run)) return;
    if (runShowsResults(runLoad(loads, runFriendlyId))) return setRunHidden(runFriendlyId, !open);
    const nodeId = runNodeId(runFriendlyId);
    if (open && !nodes[nodeId]?.expanded) expandNode(nodeId, false);
  };
  // During a search, Collapse all hides every run's results and Expand all shows them again;
  // only Load all loads.
  const allShown = filtering ? hiddenRuns.size === 0 : allExpanded;
  const expandAll = () => {
    if (!filtering) return expandAllRuns();
    setFilter((prev) => ({ ...prev, hiddenRuns: [] }));
  };
  const collapseAll = () => {
    if (!filtering) return collapseAllRuns();
    setFilter((prev) => ({
      ...prev,
      hiddenRuns: runNodes.flatMap((node) =>
        node.data.kind === "run" ? [node.data.run.friendlyId] : []
      ),
    }));
  };
  const toggleAll = () => (allShown ? collapseAll() : expandAll());
  // Nothing to open: every run can't load here (the emergency cap), outside a search.
  const nothingToExpand = !filtering && expandableRunNodes.length === 0;

  // Load all: Expand all's newest-first queue for the runs the search hasn't covered yet.
  const coverage = searchCoverage({ runs, view, loads });
  const matchCount = useMemo(
    () => (filtering ? countMatches(tree, filter) : 0),
    [filtering, tree, filter]
  );
  const loadAllForSearch = () => {
    if (coverage.toLoad.length === 0) return;
    track("load_all", { runs: coverage.toLoad.length });
    for (const id of coverage.toLoad) openedForSearch.current.add(id);
    dispatchLoads({ type: "expandedMany", runFriendlyIds: coverage.toLoad });
    searchMovingRows.current = true;
    expandNodes(coverage.toLoad.map(runNodeId));
    searchMovingRows.current = false;
  };

  // Clearing the search undoes Load all and keeps what the user was looking at in view: the
  // selected row, else the row at the top.
  const pendingClearScroll = useRef<{ id: string; align: "start" | "center" }>();
  const topVisibleNodeId = () => {
    const top = parentRef.current?.scrollTop ?? 0;
    const item = virtualizer.getVirtualItems().find((virtualItem) => virtualItem.end > top);
    return item ? String(item.key) : undefined;
  };
  const updateFilter = (change: Partial<SessionTraceFilter>) => {
    const next = { ...filter, ...change };
    next.text = next.text.toLowerCase();
    if (!isFiltering(next)) next.hiddenRuns = [];
    setFilter(next);
    if (searchStarted(filter, next)) {
      track("search_used", { text: next.text !== "", errors_only: next.errorsOnly });
    }
    if (!filtering || isFiltering(next)) return;

    const keep = new Set(touchedDuringSearch.current);
    if (intended.kind !== "session") keep.add(intended.runFriendlyId);
    const collapse = runsToCollapseOnClear(openedForSearch.current, keep);
    openedForSearch.current = new Set();
    touchedDuringSearch.current = new Set();

    const selectedRow = intended.kind !== "session" ? highlightedId : undefined;
    const target = selectedRow ?? topVisibleNodeId();
    searchMovingRows.current = true;
    collapseNodes(collapse.map(runNodeId).filter((id) => nodes[id]?.expanded));
    // The filter showed the selected row inside rows that may be collapsed.
    if (selectedRow) {
      expandNodes(ancestorsOf(selectedRow).filter((ancestor) => !nodes[ancestor]?.expanded));
    }
    searchMovingRows.current = false;
    if (target)
      pendingClearScroll.current = { id: target, align: selectedRow ? "center" : "start" };
  };
  // The debounced search box calls back later: always reach this render's handler.
  const updateFilterRef = useRef(updateFilter);
  useLayoutEffect(() => {
    updateFilterRef.current = updateFilter;
  });
  const onFilterTextChange = useCallback((text: string) => updateFilterRef.current({ text }), []);
  const onErrorsOnlyChange = useCallback(
    (errorsOnly: boolean) => updateFilterRef.current({ errorsOnly }),
    []
  );
  useLayoutEffect(() => {
    const pending = pendingClearScroll.current;
    if (!pending) return;
    // The tree drops the filter a render later: wait until its rows are the unfiltered ones.
    const shown = tree.filter((node) => nodes[node.id]?.visible);
    if (shown.length !== visibleRowCount) return;
    pendingClearScroll.current = undefined;
    // A top row inside a run that just collapsed: keep its run in place instead.
    const target = [pending.id, ...ancestorsOf(pending.id)].find((id) => nodes[id]?.visible);
    const index = shown.findIndex((node) => node.id === target);
    if (index !== -1) virtualizer.scrollToIndex(index, { align: pending.align });
  }, [nodes, visibleRowCount, tree, ancestorsOf, virtualizer]);

  // Level keys never start a load: a run only has children once its spans are in, so the
  // tree's level actions only reach loaded runs. Those are opened first through expandNodes.
  const expandLoadedToLevel = (level: number) => {
    expandNodes(
      runNodes.filter((node) => node.hasChildren && !nodes[node.id]?.expanded).map((n) => n.id)
    );
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
    const selectedRow = selected ? rowsById.get(selected) : undefined;
    if (
      filtering &&
      !event.altKey &&
      selectedRow?.kind === "run" &&
      (event.key === "ArrowRight" || event.key === "ArrowLeft")
    ) {
      event.preventDefault();
      toggleRunInSearch(selectedRow.run.friendlyId, event.key === "ArrowRight");
      return;
    }
    // The tree's Right key expands without asking `canExpand`.
    if (
      !event.altKey &&
      event.key === "ArrowRight" &&
      selectedRow?.kind === "run" &&
      loadBlock(selectedRow.run)
    ) {
      event.preventDefault();
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
        if (!run.status || !isRunTraceMounted(load)) return null;
        // Keyed by attempt: a retry or a fresh read starts from scratch, never from the old trace.
        return (
          <RunTraceSource
            key={`${run.friendlyId}:${runLoadId(load)}`}
            run={{ ...run, status: run.status }}
            load={load}
            live={run.friendlyId === newestRunId}
            paused={!active}
            errorsOnly={filter.errorsOnly}
            selectedSpanId={
              deepLink?.kind === "span" && deepLink.runFriendlyId === run.friendlyId
                ? deepLink.spanId
                : undefined
            }
            onSettle={onSettle}
            onSnapshot={onSnapshot}
            onSpanCount={onSpanCount}
            onLoadedSpans={onLoadedSpans}
            askPage={askPage}
            onPanelData={onPanelData}
            onRunDataStale={onRunDataStale}
          />
        );
      })}
      <div className="flex items-center gap-2 border-b border-grid-bright pl-1.5 pr-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-none">
          <TraceFilters
            onFilterTextChange={onFilterTextChange}
            errorsOnly={filter.errorsOnly}
            onErrorsOnlyChange={onErrorsOnlyChange}
          />
          {filtering ? (
            <SearchCoverageNote
              coverage={coverage}
              matches={matchCount}
              errorsOnly={filter.errorsOnly}
              onLoadAll={loadAllForSearch}
            />
          ) : (
            barNotice && <span className="truncate text-xs text-text-dimmed">{barNotice}</span>
          )}
        </div>
        <Button variant="tertiary/small" onClick={toggleAll} disabled={nothingToExpand}>
          {/* Both labels share one cell so the button keeps the wider one's width. */}
          <span className="inline-grid">
            <span className="invisible col-start-1 row-start-1">Collapse all</span>
            <span className="col-start-1 row-start-1 text-center">
              {allShown ? "Collapse all" : "Expand all"}
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
                    isExpanded={runIsOpen(node.data, state.expanded)}
                    canExpand={rowCanExpand(node)}
                    onToggle={() => {
                      const row = node.data;
                      if (filtering && row.kind === "run") {
                        toggleRunInSearch(row.run.friendlyId, !showsResults(row.run.friendlyId));
                        return;
                      }
                      toggleExpandNode(node.id, false);
                    }}
                    isLive={node.data.kind === "run" && node.data.run.friendlyId === liveRunId}
                    load={
                      node.data.kind === "run"
                        ? runLoad(loads, node.data.run.friendlyId)
                        : undefined
                    }
                    spanCount={
                      node.data.kind === "run" ? runSpanCount(loads, node.data.run.friendlyId) : 0
                    }
                    loadBlock={node.data.kind === "run" ? loadBlock(node.data.run) : undefined}
                    checkedAtMs={checkedAtMs}
                    onRetry={retryRun}
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
                if (element && followArmed.current) atBottom.current = isScrolledToBottom(element);
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
          {/* Shortcuts listen on the document, so `inert` on the hidden tab doesn't stop them. */}
          <KeyboardShortcuts
            enabled={active}
            onExpandAll={expandAll}
            onCollapseAll={collapseAll}
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

function SearchCoverageNote({
  coverage,
  matches,
  errorsOnly,
  onLoadAll,
}: {
  coverage: SearchCoverage;
  matches: number;
  errorsOnly: boolean;
  onLoadAll: () => void;
}) {
  const { partly } = coverage;
  const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? "" : "es"}`;
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-text-dimmed">
      <span>
        Searching {coverage.searched} of {coverage.searchable} shown runs ·{" "}
        {plural(matches, "match")}
      </span>
      {partly > 0 && (
        <SimpleTooltip
          button={<span className="text-text-faint">· {partly} partly</span>}
          content={
            errorsOnly
              ? `${partly} ${partly === 1 ? "run" : "runs"} stopped at a span limit. Their errors are also read from the server, but other matches only come from the spans loaded here.`
              : `${partly} ${partly === 1 ? "run" : "runs"} stopped at a span limit, so only the spans loaded here were searched.`
          }
          disableHoverableContent
        />
      )}
      {coverage.notLoaded > 0 && (
        <SimpleTooltip
          button={
            <span className="text-text-faint">· {coverage.notLoaded} not loaded (span limit)</span>
          }
          content="The session reached its span limit before these runs loaded. Open their run pages to see them."
          disableHoverableContent
        />
      )}
      {coverage.failed > 0 && <span className="text-error">· {coverage.failed} failed</span>}
      {coverage.toLoad.length > 0 && (
        <Button variant="tertiary/small" onClick={onLoadAll}>
          Load all
        </Button>
      )}
    </span>
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
  spanCount,
  loadBlock,
  checkedAtMs,
  onRetry,
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
  spanCount: number;
  loadBlock: RunLoadBlock | undefined;
  checkedAtMs: number;
  onRetry: (runFriendlyId: string) => void;
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
            load={load}
            spanCount={spanCount}
            loadBlock={loadBlock}
            checkedAtMs={checkedAtMs}
            onRetry={onRetry}
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
  load,
  spanCount,
  loadBlock,
  checkedAtMs,
  onRetry,
}: {
  run: SessionTraceRun;
  isLive: boolean;
  load: SessionRunLoad | undefined;
  spanCount: number;
  loadBlock: RunLoadBlock | undefined;
  checkedAtMs: number;
  onRetry: (runFriendlyId: string) => void;
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
        <span className="shrink-0 text-xs text-text-faint">
          {isRunStarting(run, checkedAtMs) ? "Starting…" : "Unavailable"}
        </span>
      )}
      <span className="min-w-0 truncate text-xs text-text-dimmed">{runReasonLabel(run)}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pr-2 text-xs tabular-nums text-text-dimmed">
        {loadBlock ? (
          <RunFallback run={run} block={loadBlock} />
        ) : load && hasLoadStatus(load) ? (
          <RunLoadStatus run={run} load={load} spanCount={spanCount} onRetry={onRetry} />
        ) : (
          <RunDurationLabel run={run} isLive={isLive} />
        )}
      </span>
    </>
  );
}

// A run whose trace can't load here links to its run page instead of expanding.
function RunFallback({ run, block }: { run: SessionTraceRun; block: RunLoadBlock }) {
  const track = useSessionViewAnalytics();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  // Not in the run store: the status slot says so, and a run page may not exist yet.
  if (block.kind === "notInRunStore") return null;

  const reason = block.kind === "unavailable" ? unavailableReasonText(block.reason) : undefined;
  const label = block.kind === "logsDeleted" ? "Logs deleted" : "Can't show here";
  return (
    <>
      {reason ? (
        <SimpleTooltip button={<span>{label}</span>} content={reason} disableHoverableContent />
      ) : (
        <span>{label}</span>
      )}
      <LinkButton
        variant="secondary/small"
        to={v3RunPath(organization, project, environment, run)}
        onClick={(event) => {
          event.stopPropagation();
          track("open_run_page", { from: "row", reason: block.kind });
        }}
      >
        Open run page
      </LinkButton>
    </>
  );
}

function hasLoadStatus(load: SessionRunLoad) {
  return ["queued", "loading", "paging", "error", "cutOff"].includes(load.state);
}

// Takes the duration's place while the run waits, loads, failed or hit a span limit.
function RunLoadStatus({
  run,
  load,
  spanCount,
  onRetry,
}: {
  run: SessionTraceRun;
  load: SessionRunLoad;
  spanCount: number;
  onRetry: (runFriendlyId: string) => void;
}) {
  const track = useSessionViewAnalytics();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  switch (load.state) {
    case "queued":
      return <>Waiting to load…</>;
    case "loading":
      return <Spinner className="size-3" />;
    case "paging":
      return (
        <>
          <Spinner className="size-3" />
          {spanCount > 0 && <>{formatNumber(spanCount)} spans</>}
        </>
      );
    case "error":
      return (
        <>
          <SimpleTooltip
            button={<span className="text-error">Couldn't load</span>}
            content={load.message}
            disableHoverableContent
          />
          <Button
            variant="secondary/small"
            onClick={(event) => {
              event.stopPropagation();
              onRetry(run.friendlyId);
            }}
          >
            Retry
          </Button>
        </>
      );
    case "cutOff": {
      const limit = formatNumber(load.spanLimit);
      const reason =
        load.limit === "run"
          ? `Stopped at this run's limit of ${limit} spans.`
          : load.started
            ? `Stopped at the limit of ${limit} spans across this session.`
            : `Loading it would pass the limit of ${limit} spans across this session. Collapse other runs, then expand it again.`;
      return (
        <>
          <SimpleTooltip
            button={
              <span>
                {load.started ? "Partly loaded" : "Not loaded"} ·{" "}
                {load.limit === "run" ? "run limit" : "session limit"}
              </span>
            }
            content={reason}
            disableHoverableContent
          />
          <LinkButton
            variant="secondary/small"
            to={v3RunPath(organization, project, environment, run)}
            onClick={(event) => {
              event.stopPropagation();
              track("open_run_page", { from: "row", reason: "cutOff" });
            }}
          >
            Open run page
          </LinkButton>
        </>
      );
    }
    default:
      return null;
  }
}

// Only the live run counts up; an older unfinished run shows when it started instead.
function RunDurationLabel({ run, isLive }: { run: SessionTraceRun; isLive: boolean }) {
  const active = useContext(TraceTabActiveContext);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useInterval({
    interval: 1_000,
    disabled: !isLive || !active,
    callback: () => setNowMs(Date.now()),
  });

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
