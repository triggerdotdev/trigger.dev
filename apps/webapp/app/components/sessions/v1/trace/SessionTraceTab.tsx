import {
  ArrowDownIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  InformationCircleIcon,
  ChevronRightIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
} from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";
import { animate, useReducedMotion } from "framer-motion";
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
import { Callout } from "~/components/primitives/Callout";
import { DateTime, formatDateTime, useUserTimeZone } from "~/components/primitives/DateTime";
import { lerp } from "~/utils/lerp";
import { useLocales } from "~/components/primitives/LocaleProvider";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PulsingDot } from "~/components/primitives/PulsingDot";
import { ShortcutKey, variants as shortcutKeyVariants } from "~/components/primitives/ShortcutKey";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type ResizableSnapshot,
} from "~/components/primitives/Resizable";
import { TextLink } from "~/components/primitives/TextLink";
import { Spinner } from "~/components/primitives/Spinner";
import * as Timeline from "~/components/primitives/Timeline";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { TreeView, useTree } from "~/components/primitives/TreeView/TreeView";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import {
  runStatusTitle,
  TaskRunStatusCombo,
  TaskRunStatusIcon,
} from "~/components/runs/v3/TaskRunStatus";
import { SpanTreeRow } from "~/components/runs/v3/trace/TasksTreeView";
import { KeyboardShortcuts } from "~/components/runs/v3/trace/TraceShortcuts";
import { TraceFilters } from "~/components/runs/v3/trace/TraceToolbar";
import type { TraceTimelineScale } from "~/components/runs/v3/trace/timelineScale";
import type { TraceEvent } from "~/components/runs/v3/trace/types";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useDimensions } from "~/hooks/useDimensions";
import { useInterval } from "~/hooks/useInterval";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { formatNumber } from "~/utils/numberFormatter";
import { v3RunPath } from "~/utils/pathBuilder";
import { isFailedRunStatus, isFinalRunStatus } from "~/v3/taskStatus";
import {
  buildSessionTree,
  isSelectableRow,
  LOAD_EARLIER_NODE_ID,
  runNodeId,
  SESSION_NODE_ID,
  spanNodeId,
  type SessionTreeRow,
} from "./buildSessionTree";
import { notShownText, runFactsOf, runLoadNote, type RunLoadNote } from "./sessionRunNote";
import {
  findIndexNear,
  NO_NEW_BELOW,
  pillLabel,
  pillUpdateDelayMs,
  TraceScrollModel,
  type NewBelow,
  type RowsView,
} from "./sessionTraceScroll";
import { RunTraceSource, type RunTraceSnapshot } from "./RunTraceSource";
import {
  sessionBarNotice,
  type BarNotice,
  isRunStarting,
  runLoadBlock,
  runsUnavailableBeforeRead,
  type RunLoadBlock,
} from "./sessionRunFallback";
import { traceFilterKey } from "~/components/runs/v3/trace/traceFilterKey";
import { SessionTimelineRow, type RowPlacement } from "./SessionTimelineRow";
import {
  axisTickCount,
  buildSessionAxis,
  clampWindow,
  showsWholeSession,
  timelineZoomReducer,
  WHOLE_SESSION,
  zoomWindow,
  type AxisWindow,
  type RunInterval,
  type SessionAxis,
} from "./sessionTimelineAxis";
import { type RunPanelData, useSessionPanelStore } from "./sessionPanelStore";
import {
  createSessionRunLoads,
  isRunReadSettled,
  isRunTraceMounted,
  pageCheck,
  runLoad,
  runLoadId,
  runSpanCount,
  sessionRunLoadsReducer,
  type SessionRunLoad,
  type SessionRunLoadOutcome,
  type SessionRunLoadsAction,
} from "./sessionRunLoads";
import {
  liveRunFriendlyId,
  newestRunFriendlyId,
  newRunsPollIntervalMs,
  runDuration,
  runMessageWait,
  runTimelineScale,
  type MessageWait,
} from "./sessionRunTiming";
import {
  adjacentRunNodeId,
  highlightedNodeId,
  isSameSelection,
  rowSelection,
  selectionNodeId,
  type SessionTraceSelection,
} from "./sessionTraceSelection";
import {
  isFiltering,
  matchesByRun,
  matchesText,
  NO_FILTER,
  runSearchMark,
  runShowsResults,
  runsToCollapseOnClear,
  searchBarSummary,
  searchCoverage,
  sessionRowPassesFilter,
  type RunSearchMark,
  type SearchBarSummary,
  type SearchCoverage,
  type SessionTraceFilter,
} from "./sessionTraceSearch";
import { newBudgetOutcomes, searchStarted, type BudgetOutcome } from "./sessionViewAnalytics";
import { useSessionViewAnalytics } from "./useSessionViewAnalytics";
import type { SessionTraceRun } from "./sessionTraceTypes";
import { SESSION_TREE_AUTOSAVE_ID, runReasonBadge, type RunReasonBadge } from "./sessionTraceView";
import {
  RUNS_FILL_MAX,
  RUNS_PAGE_SIZE,
  type LoadedRuns,
  deepLinkFailed,
  type NewestPageReason,
  useSessionRunPages,
} from "./useSessionRunPages";
import { useSessionTraceSelection } from "./useSessionTraceSelection";

const ROW_HEIGHT_PX = 32;
/** Below this, a mouse down and up on the timeline is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4;

// Like the run page: arrowing through rows doesn't write the URL on every step.
const SELECTION_URL_DEBOUNCE_MS = 250;

// Rows' clocks stop while the tab is hidden.
const TraceTabActiveContext = createContext(true);
// Every top-level run is the session's task, so the session row names it once.
const SessionTaskContext = createContext<string | undefined>(undefined);

type SessionTraceTabProps = {
  runsPath: string;
  taskIdentifier: string;
  treeSnapshot: ResizableSnapshot | undefined;
  /** False while the Conversation tab is shown: the tab stays mounted but makes no requests. */
  active: boolean;
  /** Closed and expired sessions start no more runs, so their empty state promises nothing. */
  sessionOpen: boolean;
};

/** The session's runs as one tree, newest page first, with earlier pages on request. */
export function SessionTraceTab(props: SessionTraceTabProps) {
  // The tree captures its deep link once at mount, so retrying a failed one starts it again.
  const [mount, setMount] = useState(0);
  return <SessionTraceTabContent key={mount} {...props} onRemount={() => setMount((n) => n + 1)} />;
}

function SessionTraceTabContent({
  runsPath,
  taskIdentifier,
  treeSnapshot,
  active,
  sessionOpen,
  onRemount,
}: SessionTraceTabProps & { onRemount: () => void }) {
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
  // A linked run whose page failed: keep it in the URL so Retry can read it again. A run in the
  // newest page loaded anyway, so it needs no notice.
  const showRunFailed = deepLinkFailed({
    deepLink: pages.deepLink,
    deepLinkRunId,
    selectedRunId: selection.kind === "session" ? undefined : selection.runFriendlyId,
    runs: pages.runs,
  });

  // The session details (a sibling) show what the newest read says about the session and its runs.
  const panelStore = useSessionPanelStore();
  useEffect(() => {
    if (pages.session && pages.runs) panelStore?.setSessionRead(pages.session, pages.runs);
  }, [panelStore, pages.session, pages.runs]);

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
        <Paragraph variant="small/dimmed">
          {sessionOpen ? "No runs yet. This page updates when one starts." : "No runs yet."}
        </Paragraph>
      </div>
    );
  }

  const failedRun = latestFinishedRunIfFailed(pages.runs);
  const liveRunId = liveRunFriendlyId(pages.runs, pages.totalCount);
  const liveRun = pages.runs.find((run) => run.friendlyId === liveRunId);

  return (
    <TraceTabActiveContext.Provider value={active}>
      <SessionTaskContext.Provider value={taskIdentifier}>
        <div className="flex h-full flex-col">
          {failedRun && <LatestRunFailedCallout run={failedRun} liveRun={liveRun} />}
          <div className="min-h-0 flex-1">
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
              notice={
                showRunFailed
                  ? { text: "Couldn't load that run", onRetry: onRemount }
                  : showRunNotFound
                    ? { text: "That run isn't in this session." }
                    : undefined
              }
              active={active}
            />
          </div>
        </div>
      </SessionTaskContext.Provider>
    </TraceTabActiveContext.Provider>
  );
}

/** Says when the newest finished run failed, above the tree: the "is it broken now?" answer. */
function LatestRunFailedCallout({
  run,
  liveRun,
}: {
  run: SessionTraceRun;
  liveRun: SessionTraceRun | undefined;
}) {
  const track = useSessionViewAnalytics();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  if (!run.status) return null;
  return (
    <Callout
      variant="error"
      className="shrink-0 rounded-none border-x-0 border-t-0 shadow-none"
      cta={
        <LinkButton
          variant="secondary/small"
          to={v3RunPath(organization, project, environment, run)}
          onClick={() => track("open_run_page", { from: "callout", reason: "failed" })}
        >
          View run
        </LinkButton>
      }
    >
      <span className="flex flex-wrap items-center gap-x-1.5 text-sm text-text-bright">
        The latest run to finish, Run {run.number}, ended
        <TaskRunStatusCombo status={run.status} className="text-sm" />
        {run.finishedAt && (
          <span className="text-text-dimmed">
            <DateTime date={run.finishedAt} />
          </span>
        )}
        {liveRun && <span className="text-text-dimmed">· Run {liveRun.number} is running</span>}
      </span>
    </Callout>
  );
}

/** The newest run that has finished, when it failed. */
function finishedMs(run: SessionTraceRun) {
  return run.finishedAt ? Date.parse(run.finishedAt) : 0;
}

function latestFinishedRunIfFailed(runs: SessionTraceRun[]) {
  const finished = runs
    .filter((run) => run.status && isFinalRunStatus(run.status))
    // By when they finished: a continuation can finish before the run it continues.
    .sort((a, b) => finishedMs(b) - finishedMs(a) || b.number - a.number)[0];
  return finished?.status && isFailedRunStatus(finished.status) ? finished : undefined;
}

/** The live run, and whether it's a chat run waiting for the next message. */
type LiveRun = { wait: MessageWait | undefined };

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
  notice: BarNotice | undefined;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);

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

  // Nothing opens on its own, the live run or a new one included: opening one zooms the
  // timeline, and the tab shouldn't move while you're looking at something else.
  // A selection in the URL at mount whose run loaded: open there instead of at the bottom.
  const [deepLink] = useState(() => {
    if (selection.kind === "session") return undefined;
    if (!runs.some((run) => run.friendlyId === selection.runFriendlyId)) return undefined;
    return selection;
  });
  const [loads, reactDispatchLoads] = useReducer(sessionRunLoadsReducer, undefined, () => {
    const initial = createSessionRunLoads();
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

  // The side panel is a sibling: it reads what the runs route says about each run (with its span
  // id) and live panel data from the store, and works out its note from those facts.
  const panelStore = useSessionPanelStore();
  useEffect(() => {
    panelStore?.setRuns(
      Object.fromEntries(
        runs.map((run) => {
          const entry = view[run.friendlyId];
          return [run.friendlyId, { facts: runFactsOf(run, entry), spanId: entry?.spanId }];
        })
      )
    );
  }, [panelStore, runs, view]);
  const onPanelData = useCallback(
    (runFriendlyId: string, data: RunPanelData | undefined) =>
      panelStore?.setRunData(runFriendlyId, data),
    [panelStore]
  );

  const spansByRun = useMemo(
    () => new Map(Object.entries(snapshots).map(([id, snapshot]) => [id, snapshot.events])),
    [snapshots]
  );
  // A span turning into an error, or getting a new message, refilters the same tree.
  const filterKey = useMemo(
    () => (filtering ? traceFilterKey(Object.values(snapshots)) : undefined),
    [filtering, snapshots]
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

  // What reading each run found, for its panel note. These go with the tab.
  const loadNotes = useMemo(() => {
    const notes: Record<string, RunLoadNote> = {};
    for (const run of runs) {
      const note = runLoadNote(runLoad(loads, run.friendlyId));
      if (note) notes[run.friendlyId] = note;
    }
    return notes;
  }, [runs, loads]);
  useEffect(() => {
    panelStore?.setRunLoadNotes(loadNotes);
  }, [panelStore, loadNotes]);
  useEffect(() => () => panelStore?.setRunLoadNotes({}), [panelStore]);
  // Runs whose read has ended, so the panel can say a linked span never showed up.
  const settledRuns = useMemo(() => {
    const settled = new Set(runsUnavailable);
    for (const run of runs) {
      if (isRunReadSettled(runLoad(loads, run.friendlyId))) settled.add(run.friendlyId);
    }
    return settled;
  }, [runs, loads, runsUnavailable]);
  useEffect(() => {
    panelStore?.setSettledRuns(settledRuns);
  }, [panelStore, settledRuns]);
  useEffect(() => () => panelStore?.setSettledRuns(new Set()), [panelStore]);
  const rowCanExpand = (node: { data: Row; hasChildren: boolean }) =>
    node.data.kind === "run" ? !loadBlock(node.data.run) : node.hasChildren;
  // The cap and the session limit apply across runs, so they're said once in the bar.
  const barNotice = sessionBarNotice({ deepLink: notice, view, loads: loads.loads });

  // Only the live run's scale moves with the clock; the rest are fixed at page load.
  const [openedAtMs] = useState(() => Date.now());
  // A chat run waiting for a message has nothing moving, so the clock stops until it resumes.
  const liveSnapshot = liveRunId ? snapshots[liveRunId] : undefined;
  const liveWait = useMemo(() => runMessageWait(liveSnapshot), [liveSnapshot]);
  const [nowMs, setNowMs] = useState(openedAtMs);
  useInterval({
    interval: 1_000,
    disabled: !liveRunId || !active || !!liveWait,
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

  // One axis for the whole session: each run where it really happened, in real time.
  // From when it started (queue time isn't run time, same as the row's duration) to when it
  // finished, or now while it runs. A run that hasn't started (queued, or never recorded) is a
  // point at its trigger time, not a bar.
  const intervalOf = (run: SessionTraceRun): RunInterval => {
    const startMs = Date.parse(run.startedAt ?? run.createdAt ?? run.triggeredAt);
    if (!run.startedAt) return { startMs, endMs: startMs };
    const finished = run.status !== null && isFinalRunStatus(run.status);
    const endMs = run.finishedAt ? Date.parse(run.finishedAt) : finished ? startMs : nowMs;
    return { startMs, endMs: Math.max(startMs, endMs) };
  };
  // The run plus its loaded spans: a span can end after its run. The axis and a run's zoom use
  // this, so those spans aren't clipped; the run's bar stays the run's own time. Only a started
  // run with spans loaded, and only their real end (not the display scale, which runs to now).
  const extentOf = (run: SessionTraceRun): RunInterval => {
    const interval = intervalOf(run);
    const snapshot = snapshots[run.friendlyId];
    if (!run.startedAt || !snapshot?.rootStartedAt) return interval;
    const traceEndMs = new Date(snapshot.rootStartedAt).getTime() + snapshot.duration / 1_000_000;
    return { startMs: interval.startMs, endMs: Math.max(interval.endMs, traceEndMs) };
  };
  const axis = useMemo(
    () => buildSessionAxis(runs.map(extentOf)),
    // extentOf reads nowMs and the snapshots.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [runs, nowMs, snapshots]
  );

  // What the timeline shows. Every zoom rule lives in timelineZoomReducer; the tab only reports
  // what happened.
  const [zoom, dispatchZoom] = useReducer(timelineZoomReducer, WHOLE_SESSION);
  // A range is kept in real time; the axis starts at the oldest loaded run, which can move.
  const originMs = axis.toReal(0);
  const zoomToRange = (range: AxisWindow) =>
    dispatchZoom({
      type: "range",
      startMs: range.startMs + originMs,
      endMs: range.endMs + originMs,
    });
  const runExtent = (id: string) => {
    const run = runsById.get(id);
    return run ? extentOf(run) : undefined;
  };
  const targetWindow = zoomWindow(zoom, axis, runExtent);
  const wholeSession = showsWholeSession(zoom, runExtent);
  // Opening, closing or switching runs eases the zoom so you can see what happened; a drag or a
  // sideways scroll follows the pointer directly.
  const axisWindow = useEasedWindow(
    targetWindow,
    zoom.kind === "range" ? undefined : zoom.kind === "run" ? zoom.runFriendlyId : "whole",
    originMs
  );

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
    scrollToNode,
    virtualizer,
  } = useTree<Row, SessionTraceFilter>({
    tree,
    parentRef,
    estimatedRowHeight: () => ROW_HEIGHT_PX,
    // Arrow keys, Home and End skip the "not loaded" and "Load earlier" rows.
    canSelect: (node) => isSelectableRow(node.data),
    // The load reducer owns which runs are expanded: a deep link, or what the user opened.
    isCollapsedByDefault: (node) =>
      node.data.kind === "run" && !loadsRef.current.expanded.has(node.data.run.friendlyId),
    canExpand: rowCanExpand,
    structureKey,
    filterKey,
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

  // Built once per tree, and only while a deep link or a clear-search scroll needs it.
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

  // Every scroll decision lives in one model: the opening hold, reveals, anchoring, the pill.
  // The tab tells it what happened and applies the scrollTop it returns.
  const [scrollModel] = useState(
    () =>
      new TraceScrollModel({
        holdAtLatest: deepLink === undefined,
        // A deep link opens on its run row while the run loads.
        reveal: deepLink
          ? {
              id: runNodeId(deepLink.runFriendlyId),
              align: "center",
              cancelOnInteraction: true,
              waitForFilter: false,
            }
          : undefined,
        // Earlier runs land above the oldest run: never anchor on the rows above it.
        skipAnchor: (id) => id === SESSION_NODE_ID || id === LOAD_EARLIER_NODE_ID,
      })
  );
  const keyAt = (index: number) => {
    const key = virtualizer.options.getItemKey(index);
    return key === undefined ? undefined : String(key);
  };
  const rowsView = (scrollElement: HTMLElement): RowsView => {
    const count = virtualizer.options.count;
    // Rows differ in height: the virtualizer's measurements say where each one sits.
    const totalPx = virtualizer.getTotalSize();
    const rows = virtualizer.measurementsCache;
    return {
      topOf: (index) => rows[index]?.start ?? totalPx,
      heightOf: (index) => rows[index]?.size ?? 0,
      totalPx,
      indexAt: (px) => (count === 0 ? 0 : virtualizer.getVirtualItemForOffset(px).index),
      count,
      keyAt,
      visibleIndexOf: (id) =>
        nodes[id]?.visible ? findIndexNear(id, count - 1, count, keyAt) : -1,
      inTree: (id) => id in nodes,
      scrollTop: scrollElement.scrollTop,
      viewportPx: scrollElement.clientHeight,
    };
  };

  // The pill's count changes at most about once a second.
  const [pill, setPill] = useState<NewBelow>(NO_NEW_BELOW);
  const pendingPill = useRef<NewBelow>(NO_NEW_BELOW);
  const pillShownAt = useRef<number>();
  const pillTimer = useRef<ReturnType<typeof setTimeout>>();
  const showPillSoon = () => {
    if (pillTimer.current) return;
    pillTimer.current = setTimeout(
      () => {
        pillTimer.current = undefined;
        pillShownAt.current = Date.now();
        setPill(pendingPill.current);
      },
      pillUpdateDelayMs(pillShownAt.current, Date.now())
    );
  };
  const clearPill = () => {
    clearTimeout(pillTimer.current);
    pillTimer.current = undefined;
    pillShownAt.current = undefined;
    pendingPill.current = NO_NEW_BELOW;
    setPill(NO_NEW_BELOW);
  };
  useEffect(() => () => clearTimeout(pillTimer.current), []);

  // Shows what the model says about the pill, at most about once a second.
  const syncPill = () => {
    const next = scrollModel.pill;
    if (next === pendingPill.current) return;
    if (next === NO_NEW_BELOW) return clearPill();
    pendingPill.current = next;
    showPillSoon();
  };
  const applyScroll = (scrollElement: HTMLElement, scrollTop: number | undefined) => {
    if (scrollTop !== undefined) scrollElement.scrollTop = scrollTop;
    syncPill();
  };

  // Deep link: open the linked row's parents the first time it's in the tree, then the model
  // centres it once it's visible. It never selects, so it can't override a row picked meanwhile.
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
    expandNodes(ancestorsOf(target).filter((ancestor) => !nodes[ancestor]?.expanded));
    scrollModel.reveal({
      id: target,
      align: "center",
      cancelOnInteraction: true,
      waitForFilter: false,
    });
  }, [deepLink, deepLinkStillIntended, nodes, ancestorsOf, expandNodes, scrollModel]);
  // Scrolling, a click or a key in the tab means the user has moved on: stop holding the view at
  // the latest run and stop revealing a deep link.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const userMoved = () => {
      revealedDeepLink.current = true;
      scrollModel.interacted();
    };
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const event of events) {
      container.addEventListener(event, userMoved, { passive: true, once: true });
    }
    return () => {
      for (const event of events) container.removeEventListener(event, userMoved);
    };
  }, [scrollModel]);

  // The side panel opens a span once the tree has it, so a span route miss can't leave the page.
  // Read from the intended selection, so a clicked span is confirmed before its URL write.
  const intendedNodeId = selectionNodeId(intended);
  useEffect(() => {
    if (intended.kind !== "span" || !rowsById.has(intendedNodeId)) return;
    panelStore?.confirmSpan(intended.runFriendlyId, intended.spanId);
  }, [intended, intendedNodeId, rowsById, panelStore]);

  // Every change to the tree's rows (added, expanded, collapsed, filtered) goes through the model.
  // The newest run's spans are only walked when they changed, or when some weren't in the tree.
  const visibleRowsKey = virtualizer.options.getItemKey;
  const newestSnapshot = newestRunId ? snapshots[newestRunId] : undefined;
  const newestEvents = newestSnapshot?.events;
  const walkedEvents = useRef<typeof newestEvents>();
  useLayoutEffect(() => {
    const scrollElement = parentRef.current;
    if (!scrollElement) return;
    const walk = newestEvents !== walkedEvents.current || scrollModel.waitingForSpans;
    walkedEvents.current = newestEvents;
    // Its root span has no row (the run row stands in for it), so it's left out.
    const liveSpanIds = newestSnapshot?.liveSpanIds;
    const newestSpanIds: string[] = [];
    const liveNodeIds = new Set<string>();
    if (walk && newestRunId && newestEvents) {
      for (const event of newestEvents) {
        if (event.level === 0) continue;
        const nodeId = spanNodeId(newestRunId, event.id);
        newestSpanIds.push(nodeId);
        if (liveSpanIds?.has(event.id)) liveNodeIds.add(nodeId);
      }
    }
    const scrollTop = scrollModel.rowsChanged({
      view: rowsView(scrollElement),
      active,
      newestRunId,
      newestSpanIds,
      isLiveSpan: (id) => liveNodeIds.has(id),
      filterSettled: () =>
        tree.filter((node) => nodes[node.id]?.visible).length === virtualizer.options.count,
      visibleTargetOf: (id) => [id, ...ancestorsOf(id)].find((other) => nodes[other]?.visible),
    });
    applyScroll(scrollElement, scrollTop);
    // Runs on every row change; the helpers read the latest render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, visibleRowsKey, active]);

  const loadEarlier = onLoadEarlier;

  // The pill: a new run puts its row at the top, new spans scroll to the bottom.
  const pillText = pillLabel(pill);

  const onPillClick = () => {
    const scrollElement = parentRef.current;
    if (!scrollElement) return;
    applyScroll(scrollElement, scrollModel.pillClicked(rowsView(scrollElement)));
  };

  // Several run rows change in one tree pass; the load reducer still hears about each. Expand
  // all tells it first, newest first, so the newest runs load first; the per-row events that
  // follow change nothing.
  const runNodes = useMemo(() => tree.filter((node) => node.data.kind === "run"), [tree]);

  // Opening a run zooms the timeline to it; closing it zooms back out. Read from the tree, so a
  // click, an arrow key and a deep link all do the same.
  const expandedRunIds = runNodes.flatMap((node) =>
    node.data.kind === "run" && nodes[node.id]?.expanded ? [node.data.run.friendlyId] : []
  );
  const expandedKey = expandedRunIds.join(",");
  const [seenExpandedKey, setSeenExpandedKey] = useState("");
  if (expandedKey !== seenExpandedKey) {
    setSeenExpandedKey(expandedKey);
    dispatchZoom({
      type: "openRunsChanged",
      before: seenExpandedKey.split(",").filter(Boolean),
      after: expandedRunIds,
    });
  }
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
  // only Load all loads. Outside a search there's no Expand all: opening every run would load
  // every trace, so runs open one at a time.
  const allShown = hiddenRuns.size === 0;
  const expandAll = () => setFilter((prev) => ({ ...prev, hiddenRuns: [] }));
  const anyRunExpanded = expandedRunIds.length > 0;
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

  // Load all: Expand all's newest-first queue for the runs the search hasn't covered yet.
  const coverage = useMemo(() => searchCoverage({ runs, view, loads }), [runs, view, loads]);
  const matches = useMemo(
    () => (filtering ? matchesByRun(tree, filter) : undefined),
    [filtering, tree, filter]
  );
  // Scans the tree for gaps: only when a search's inputs change, not on every scroll render.
  const searchSummary = useMemo(
    () =>
      matches ? searchBarSummary({ runs, coverage, matches: matches.total, tree }) : undefined,
    [matches, runs, coverage, tree]
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
    // The tree drops the filter a render later: the model waits for that, then keeps the selected
    // row (or the old top row, or its run if that collapsed) in view.
    if (target) {
      scrollModel.reveal({
        id: target,
        align: selectedRow ? "center" : "start",
        cancelOnInteraction: false,
        waitForFilter: true,
      });
    }
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

  // Level keys open spans only inside runs that are already open. The tree's own expandLevel
  // would also reopen a closed run whose spans are cached, without the load reducer hearing of it.
  // Collapsing a level likewise leaves closed runs' spans as they were.
  const inOpenRun = (node: (typeof tree)[number]) =>
    node.hasChildren &&
    node.data.kind === "span" &&
    !!nodes[runNodeId(node.data.runFriendlyId)]?.expanded;
  const expandWithinOpenRuns = (level: number) =>
    expandNodes(
      tree
        .filter((node) => inOpenRun(node) && node.level <= level && !nodes[node.id]?.expanded)
        .map((node) => node.id)
    );
  const collapseWithinOpenRuns = (level: number) =>
    collapseNodes(
      tree
        .filter((node) => inOpenRun(node) && node.level === level && nodes[node.id]?.expanded)
        .map((node) => node.id)
    );
  const collapseToLevel = (level: number) =>
    level <= 1 ? collapseAllRuns() : collapseWithinOpenRuns(level);
  const toggleLevel = (level: number) => {
    if (level <= 1) return collapseAllRuns();
    // Judged on what's showing: a closed run's cached spans would keep the toggle stuck open.
    const first = tree.find((node) => node.level === level && inOpenRun(node));
    if (!first) return;
    const state = nodes[first.id];
    if (state?.expanded && state.visible) collapseWithinOpenRuns(level);
    else expandWithinOpenRuns(level);
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
      if (event.key === "ArrowRight") expandWithinOpenRuns(level);
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
  const placementForRow = (row: Row): RowPlacement | undefined => {
    if (row.kind === "run") {
      const interval = intervalOf(row.run);
      return {
        kind: "bar",
        startMs: axis.toAxis(interval.startMs),
        endMs: axis.toAxis(interval.endMs),
      };
    }
    if (row.kind === "span") {
      const run = runsById.get(row.runFriendlyId);
      const scale = scaleOfRun(row.runFriendlyId);
      if (!run || !scale) return undefined;
      const originMs = traceOriginMs(run, snapshots[row.runFriendlyId], scale);
      return { kind: "span", scale, originMs: axis.toAxis(originMs) };
    }
    return undefined;
  };

  const windowMs = Math.max(axisWindow.endMs - axisWindow.startMs, 1);
  // While zoomed in, a sideways scroll (trackpad, or Shift + wheel) moves along the session.
  const onTimelineWheel = (event: React.WheelEvent<HTMLElement>) => {
    if (wholeSession) return;
    // Mostly sideways only: a trackpad's vertical scroll carries a little deltaX too.
    const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const dx = sideways ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (dx === 0) return;
    const shift = (dx / event.currentTarget.getBoundingClientRect().width) * windowMs;
    // Clamped first, so a later Load earlier (which moves the axis start) keeps what you saw.
    zoomToRange(
      clampWindow({ startMs: axisWindow.startMs + shift, endMs: axisWindow.endMs + shift }, axis)
    );
  };
  // Nothing opens on its own, so the live run is one click away: open, zoom to, select and show
  // it. Like "N new runs", the button only shows while there's a live run you're not viewing:
  // zoomed to it with its row showing (collapsing the Session row keeps the zoom but hides it).
  // A queued run has no length yet, so its zoom still shows the whole session.
  const liveRunOpen = !!liveRunId && expandedRunIds.includes(liveRunId);
  const viewingLiveRun =
    !wholeSession &&
    zoom.kind === "run" &&
    zoom.runFriendlyId === liveRunId &&
    !!nodes[runNodeId(zoom.runFriendlyId)]?.visible;
  const showViewLiveRun = !!liveRunId && !viewingLiveRun;
  const viewLiveRun = () => {
    if (!liveRunId) return;
    const id = runNodeId(liveRunId);
    // The Session row can be collapsed over it.
    const closed = [...ancestorsOf(id), ...(liveRunOpen ? [] : [id])];
    expandNodes(closed.filter((nodeId) => !nodes[nodeId]?.expanded));
    dispatchZoom({ type: "showRun", runFriendlyId: liveRunId });
    selectRow(id);
    const reveal = { id, align: "start", cancelOnInteraction: true, waitForFilter: false } as const;
    const scrollElement = parentRef.current;
    if (scrollElement)
      applyScroll(scrollElement, scrollModel.reveal(reveal, rowsView(scrollElement)));
  };
  const selectAdjacentRun = (direction: "previous" | "next") => {
    const id = adjacentRunNodeId(tree, (id) => !!nodes[id]?.visible, selected, direction);
    if (id) selectRow(id);
  };

  return (
    <div
      ref={containerRef}
      className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[2.25rem_1fr_2.5rem] overflow-hidden bg-background-bright"
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
      <div className="flex min-w-0 items-center gap-2 border-b border-grid-bright px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-none">
          <TraceFilters
            onFilterTextChange={onFilterTextChange}
            errorsOnly={filter.errorsOnly}
            onErrorsOnlyChange={onErrorsOnlyChange}
            compactSearch
          />
          {filtering && searchSummary ? (
            <SearchCoverageNote
              coverage={coverage}
              summary={searchSummary}
              errorsOnly={filter.errorsOnly}
              onLoadAll={loadAllForSearch}
              canLoadEarlier={canLoadEarlier}
              onLoadEarlier={loadEarlier}
              onShowGap={() => {
                const gap = tree.find((node) => node.data.kind === "notLoaded");
                if (gap) scrollToNode(gap.id, "center");
              }}
            />
          ) : (
            barNotice && (
              <>
                {barNotice.hint ? (
                  <SimpleTooltip
                    button={
                      <span className="truncate text-xs text-text-dimmed">{barNotice.text}</span>
                    }
                    content={barNotice.hint}
                    disableHoverableContent
                  />
                ) : (
                  <span className="truncate text-xs text-text-dimmed">{barNotice.text}</span>
                )}
                {barNotice.onRetry && (
                  <>
                    <span className="text-xs text-text-dimmed">·</span>
                    <Button variant="secondary/small" onClick={barNotice.onRetry}>
                      Retry
                    </Button>
                  </>
                )}
              </>
            )
          )}
        </div>
        {showViewLiveRun && (
          <span className="flex shrink-0 duration-150 animate-in fade-in-0">
            <Button
              variant="secondary/small"
              className="text-text-bright"
              LeadingIcon={MagnifyingGlassPlusIcon}
              disabled={filtering}
              tooltip={
                filtering
                  ? "Clear the search to view the live run"
                  : "Zoom to the run that's running"
              }
              onClick={viewLiveRun}
            >
              View live run
            </Button>
          </span>
        )}
        {/* Stays in place, greyed out with the reason in its tooltip when it can't act. */}
        <Button
          variant="secondary/small"
          // A lavender outline while zoomed, so a zoomed view isn't mistaken for the whole session.
          className={
            wholeSession
              ? "shrink-0"
              : "shrink-0 border-lavender-500 group-hover/button:border-lavender-400"
          }
          LeadingIcon={MagnifyingGlassMinusIcon}
          disabled={wholeSession}
          tooltip={wholeSession ? "Showing the whole session" : undefined}
          onClick={() => dispatchZoom({ type: "reset" })}
        >
          Reset zoom
        </Button>
        <Button
          variant="tertiary/small"
          className="shrink-0"
          onClick={filtering ? toggleAll : collapseAll}
          disabled={!filtering && !anyRunExpanded}
        >
          {/* Both labels share one cell so the button keeps the wider one's width. */}
          <span className="inline-grid">
            <span className="invisible col-start-1 row-start-1">Collapse all</span>
            <span className="col-start-1 row-start-1 text-center">
              {filtering && !allShown ? "Expand all" : "Collapse all"}
            </span>
          </span>
        </Button>
      </div>
      <ResizablePanelGroup autosaveId={SESSION_TREE_AUTOSAVE_ID} snapshot={treeSnapshot}>
        {/* Tree + handle + timeline minimums fit the Trace pane's own 300px minimum; the run row
            drops its date when narrow. */}
        <ResizablePanel id="session-tree" default="60%" min="175px">
          <div className="@container/session-tree relative grid h-full grid-rows-[2rem_1fr] overflow-hidden">
            {pillText && (
              <span className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 shadow-md duration-150 animate-in fade-in-0">
                <Button
                  variant="secondary/small"
                  className="text-text-bright"
                  onClick={onPillClick}
                  LeadingIcon={<PulsingDot className="h-2 w-2" />}
                  tooltip={pill.newRunId ? "Show the new run" : "Scroll to the newest spans"}
                >
                  {pillText}
                </Button>
              </span>
            )}
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
              parentClassName="pl-3 [scrollbar-width:none]!"
              renderNode={({ node, state }) =>
                node.data.kind === "span" ? (
                  <SpanTreeRow
                    node={{ ...node, data: node.data.span } as TraceEvent}
                    isSelected={state.selected}
                    isExpanded={state.expanded}
                    canExpand={node.hasChildren}
                    showRootBadge={false}
                    onChevronClick={() =>
                      node.hasChildren ? toggleExpandNode(node.id, false) : selectRow(node.id)
                    }
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
                    live={
                      node.data.kind === "run" && node.data.run.friendlyId === liveRunId
                        ? { wait: liveWait }
                        : undefined
                    }
                    load={
                      node.data.kind === "run"
                        ? runLoad(loads, node.data.run.friendlyId)
                        : undefined
                    }
                    spanCount={
                      node.data.kind === "run" ? runSpanCount(loads, node.data.run.friendlyId) : 0
                    }
                    loadBlock={node.data.kind === "run" ? loadBlock(node.data.run) : undefined}
                    searchMark={
                      node.data.kind === "run" && matches && !loadBlock(node.data.run)
                        ? runSearchMark(
                            runLoad(loads, node.data.run.friendlyId),
                            matches.byRun.get(node.data.run.friendlyId) ?? 0
                          )
                        : undefined
                    }
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
                if (element) {
                  scrollModel.scrolled(rowsView(element));
                  syncPill();
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
        <ResizablePanel id="session-timeline" default="40%" min="120px">
          <SessionTimelineColumn
            axis={axis}
            axisWindow={axisWindow}
            onWheel={onTimelineWheel}
            onZoomRange={zoomToRange}
          >
            <TreeView
              scrollRef={timelineScrollRef}
              virtualizer={virtualizer}
              staticRowHeight
              tree={tree}
              nodes={nodes}
              getNodeProps={getNodeProps}
              getTreeProps={() => ({ ...getTreeProps(), onKeyDown: undefined })}
              parentClassName="h-full"
              renderNode={({ node, state }) => (
                <SessionTimelineRow
                  node={node}
                  row={node.data}
                  isSelected={state.selected}
                  isExpanded={state.expanded}
                  placement={placementForRow(node.data)}
                  axisWindow={axisWindow}
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
            onExpandAll={filtering ? expandAll : undefined}
            onCollapseAll={collapseAll}
            onToggleLevel={toggleLevel}
            afterNavigation={
              <SessionRunShortcuts
                enabled={active}
                onPrevious={() => selectAdjacentRun("previous")}
                onNext={() => selectAdjacentRun("next")}
              />
            }
            trailing={<DragToZoomHint />}
          />
        </div>
      </div>
    </div>
  );
}

function SearchCoverageNote({
  coverage,
  summary,
  errorsOnly,
  onLoadAll,
  canLoadEarlier,
  onLoadEarlier,
  onShowGap,
}: {
  coverage: SearchCoverage;
  summary: SearchBarSummary;
  errorsOnly: boolean;
  onLoadAll: () => void;
  canLoadEarlier: boolean;
  onLoadEarlier: () => void;
  onShowGap: () => void;
}) {
  const { partly, toLoad } = coverage;
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-text-dimmed">
      {/* The action first: on a narrow tab the end of the sentence is what scrolls out of view. */}
      {toLoad.length > 0 && (
        <Button variant="tertiary/small" onClick={onLoadAll}>
          Load all {formatNumber(toLoad.length)}
        </Button>
      )}
      <span>{summary.text}</span>
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

      <RunsNotShownNote
        summary={summary}
        canLoadEarlier={canLoadEarlier}
        onLoadEarlier={onLoadEarlier}
        onShowGap={onShowGap}
      />
    </span>
  );
}

/** Shown runs the search can't reach: earlier runs and gaps, in one note with the details on hover. */
function RunsNotShownNote({
  summary,
  canLoadEarlier,
  onLoadEarlier,
  onShowGap,
}: {
  summary: SearchBarSummary;
  canLoadEarlier: boolean;
  onLoadEarlier: () => void;
  /** Scrolls to the first gap row, where its Load button is. */
  onShowGap: () => void;
}) {
  const { earlier, gaps } = summary;
  const count = (earlier?.count ?? 0) + (gaps?.count ?? 0);
  if (count === 0) return null;
  // Always a button, so the keyboard reaches it and the run numbers in its tooltip. Its name says
  // what a click does: load the earlier runs, or (gaps only) show the first gap, whose row has
  // its own Load button. While a page loads it's disabled rather than switching action.
  const runsNotShown = `${formatNumber(count)} ${count === 1 ? "run" : "runs"} not shown`;
  // One click loads one page: the runs just before the oldest shown.
  const page = earlier ? Math.min(earlier.count, RUNS_PAGE_SIZE) : 0;
  const pageRuns = earlier
    ? page === 1
      ? `run ${earlier.count}`
      : `runs ${earlier.count - page + 1}–${earlier.count}`
    : "";
  const action = earlier
    ? {
        label: `Load ${page} earlier ${page === 1 ? "run" : "runs"}`,
        hint: canLoadEarlier ? `Click to load ${pageRuns}.` : "Loading earlier runs…",
        run: onLoadEarlier,
        disabled: !canLoadEarlier,
      }
    : {
        label: "Show the first gap",
        hint: "Click to show the first gap.",
        run: onShowGap,
        disabled: false,
      };
  const label = (
    <>
      · {formatNumber(count)} not shown
      <InformationCircleIcon className="size-3.5" />
    </>
  );
  return (
    <SimpleTooltip
      asChild
      tabbable
      button={
        <button
          type="button"
          aria-label={`${action.label} (${runsNotShown})`}
          className="flex items-center gap-0.5 text-text-faint underline decoration-dotted underline-offset-2 hover:text-text-bright focus-custom"
          // aria-disabled, not disabled: it keeps its tooltip and its tab stop while loading.
          aria-disabled={action.disabled}
          onClick={action.disabled ? undefined : action.run}
        >
          {label}
        </button>
      }
      content={
        <div className="flex flex-col items-start gap-1 text-xs">
          {earlier && (
            <span>
              {earlier.count === 1 ? "Run" : "Runs"} {earlier.range}: earlier runs, not loaded.
            </span>
          )}
          {gaps && (
            <span>
              {gaps.ranges.map((range) => `Runs ${range}`).join(", ")}: in gaps, use the Load rows
              in the tree.
            </span>
          )}
          <span className="text-text-dimmed">{action.hint}</span>
        </div>
      }
      disableHoverableContent
    />
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

/**
 * Where a run's trace time starts, in real time: span offsets count from here. With queue time
 * taken off, that's when the run started; otherwise when its root span started.
 */
function traceOriginMs(
  run: SessionTraceRun,
  snapshot: RunTraceSnapshot | undefined,
  scale: TraceTimelineScale
) {
  if (scale.queuedDurationNs && run.startedAt) return Date.parse(run.startedAt);
  return new Date(snapshot?.rootStartedAt ?? run.createdAt ?? run.triggeredAt).getTime();
}

/** The session timeline: one axis for every run, showing `axisWindow` of it at the panel's width. */
function SessionTimelineColumn({
  axis,
  axisWindow,
  onWheel,
  onZoomRange,
  children,
}: {
  axis: SessionAxis;
  axisWindow: AxisWindow;
  onWheel: (event: React.WheelEvent<HTMLElement>) => void;
  onZoomRange: (range: AxisWindow) => void;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Measured on every resize (not once), so the timeline keeps filling its panel.
  const width = useDimensions(containerRef)?.width || 300;

  // Drag across the timeline to zoom to that range. Listeners live only for the drag.
  const [drag, setDrag] = useState<AxisWindow>();
  const dragged = useRef(false);
  const startDrag = (event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const { startMs, endMs } = axisWindow;
    const axisAt = (x: number) =>
      startMs + Math.min(1, Math.max(0, (x - rect.left) / rect.width)) * (endMs - startMs);
    const startX = event.clientX;
    const from = axisAt(startX);
    const rangeTo = (x: number) => {
      const to = axisAt(x);
      return { startMs: Math.min(from, to), endMs: Math.max(from, to) };
    };
    dragged.current = false;
    const onMove = (move: MouseEvent) => {
      if (!dragged.current && Math.abs(move.clientX - startX) < DRAG_THRESHOLD_PX) return;
      dragged.current = true;
      setDrag(rangeTo(move.clientX));
    };
    const onUp = (up: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDrag(undefined);
      if (!dragged.current) return;
      // The click that ends the drag is swallowed below; clear the flag if none comes.
      setTimeout(() => (dragged.current = false), 0);
      const range = rangeTo(up.clientX);
      if (range.endMs > range.startMs) onZoomRange(range);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    // Drag to zoom is a mouse shortcut; expanding a run zooms from the keyboard.
    <div
      ref={containerRef}
      role="presentation"
      className="h-full select-none overflow-hidden"
      onWheel={onWheel}
      onMouseDown={startDrag}
      onClickCapture={(event) => {
        // The mouse up that ends a drag also clicks a row; that isn't a selection.
        if (!dragged.current) return;
        dragged.current = false;
        event.stopPropagation();
      }}
    >
      <Timeline.Root
        startMs={axisWindow.startMs}
        durationMs={Math.max(axisWindow.endMs - axisWindow.startMs, 1)}
        scale={0}
        minWidth={width}
        maxWidth={width}
        className="relative h-full overflow-hidden"
      >
        <SessionCursorLine axis={axis} axisWindow={axisWindow} />
        <Timeline.Row className="grid h-full grid-rows-[2rem_1fr]">
          <SessionAxisHeader axis={axis} axisWindow={axisWindow} widthPx={width} />
          <Timeline.Row className="overflow-hidden">{children}</Timeline.Row>
        </Timeline.Row>
        {drag && (
          <Timeline.Span
            startMs={drag.startMs}
            durationMs={drag.endMs - drag.startMs}
            className="pointer-events-none top-0 z-10 h-full"
          >
            <div className="h-full border-x border-blue-500 bg-blue-500/20" />
          </Timeline.Span>
        )}
      </Timeline.Root>
    </div>
  );
}

/** Clock times along the axis, like the run page's tick labels. The date is on the cursor line. */
function SessionAxisHeader({
  axis,
  axisWindow,
  widthPx,
}: {
  axis: SessionAxis;
  axisWindow: AxisWindow;
  widthPx: number;
}) {
  const timeZone = useUserTimeZone();
  const locales = useLocales();
  const withSeconds = axis.toReal(axisWindow.endMs) - axis.toReal(axisWindow.startMs) < 10 * 60_000;
  const tickCount = axisTickCount(widthPx, withSeconds);
  return (
    <Timeline.Row className="h-full">
      <Timeline.EquallyDistribute count={tickCount}>
        {(ms: number, index: number) =>
          index === tickCount - 1 ? null : (
            <Timeline.Point
              ms={ms}
              className="relative top-2.5 text-xxs leading-3 text-text-dimmed"
            >
              {(ms) => (
                <div className={cn("whitespace-nowrap", index === 0 ? "ml-1" : "-translate-x-1/2")}>
                  {formatDateTime(
                    new Date(axis.toReal(ms)),
                    timeZone,
                    locales,
                    withSeconds,
                    true,
                    false
                  )}
                </div>
              )}
            </Timeline.Point>
          )
        }
      </Timeline.EquallyDistribute>
    </Timeline.Row>
  );
}

/** Near an edge the label slides so it stays inside, like the run page's cursor. */
const CURSOR_EDGE = 0.17;

/** The run page's cursor line: follows the pointer, with the date and time it's over on top. */
function SessionCursorLine({ axis, axisWindow }: { axis: SessionAxis; axisWindow: AxisWindow }) {
  return (
    <Timeline.FollowCursor>
      {(ms) => {
        const ratio =
          (ms - axisWindow.startMs) / Math.max(axisWindow.endMs - axisWindow.startMs, 1);
        const offset =
          ratio < CURSOR_EDGE
            ? lerp(0, 0.5, ratio / CURSOR_EDGE)
            : ratio > 1 - CURSOR_EDGE
              ? lerp(0.5, 1, (ratio - (1 - CURSOR_EDGE)) / CURSOR_EDGE)
              : 0.5;
        const date = new Date(axis.toReal(ms));
        return (
          <div className="relative z-50 flex h-full flex-col">
            <div className="relative flex h-6 items-end">
              <div
                className="absolute w-fit whitespace-nowrap rounded-sm border border-border-bright bg-background-hover px-1 py-0.5 text-xxs tabular-nums text-text-bright"
                style={{ left: `${offset * 100}%`, transform: `translateX(-${offset * 100}%)` }}
              >
                <DateTime
                  date={date}
                  showTooltip={false}
                  includeYear={date.getFullYear() !== new Date().getFullYear()}
                />
              </div>
            </div>
            <div className="w-px grow border-r border-border-bright" />
          </div>
        );
      }}
    </Timeline.FollowCursor>
  );
}

/**
 * `target`, eased over a moment whenever `easeKey` changes to a new defined value; otherwise
 * `target` itself. Reduced motion jumps.
 */
function useEasedWindow(
  target: AxisWindow,
  easeKey: string | undefined,
  /** The axis start in real time. The ease runs in real time, so a moved origin can't skew it. */
  originMs: number
): AxisWindow {
  const reduceMotion = useReducedMotion();
  const [eased, setEased] = useState<AxisWindow>();
  const shown = eased
    ? { startMs: eased.startMs - originMs, endMs: eased.endMs - originMs }
    : target;
  // What was drawn last commit, in real time: the effect below runs before it's updated.
  const shownRef = useRef<AxisWindow>({
    startMs: shown.startMs + originMs,
    endMs: shown.endMs + originMs,
  });
  const lastKey = useRef(easeKey);
  useLayoutEffect(() => {
    if (easeKey === lastKey.current) return;
    lastKey.current = easeKey;
    const from = shownRef.current;
    if (easeKey === undefined || reduceMotion) return setEased(undefined);
    const to = { startMs: target.startMs + originMs, endMs: target.endMs + originMs };
    // Before paint, so the first frame doesn't flash the end state.
    setEased(from);
    const controls = animate(0, 1, {
      duration: 0.25,
      ease: "easeOut",
      onUpdate: (p) =>
        setEased({
          startMs: from.startMs + (to.startMs - from.startMs) * p,
          endMs: from.endMs + (to.endMs - from.endMs) * p,
        }),
      onComplete: () => setEased(undefined),
    });
    return () => controls.stop();
    // Eases toward the target as it was when the key changed; later ticks land after.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [easeKey]);
  useLayoutEffect(() => {
    shownRef.current = { startMs: shown.startMs + originMs, endMs: shown.endMs + originMs };
  });
  return shown;
}

function SessionTreeRowView({
  row,
  level,
  isSelected,
  isExpanded,
  canExpand,
  onToggle,
  live,
  load,
  spanCount,
  loadBlock,
  searchMark,
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
  live: LiveRun | undefined;
  load: SessionRunLoad | undefined;
  spanCount: number;
  loadBlock: RunLoadBlock | undefined;
  searchMark: RunSearchMark | undefined;
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
        <RowFrame level={level} noHover>
          {/* A faded run icon, so the row reads as "more runs here", not as one of them. */}
          <RunIcon name="task" spanName="run" className="size-5 min-w-5 opacity-40" />
          {earlierError ? (
            <span className="flex-1 text-xs text-error">
              Couldn't load earlier runs. Try again.
            </span>
          ) : (
            <span className="flex-1 truncate text-xs text-text-dimmed">
              {row.count} {row.count === 1 ? "run" : "runs"} not shown
            </span>
          )}
          <Button
            variant="secondary/small"
            className="mr-2 shrink-0"
            disabled={!canLoadEarlier || loadingEarlier}
            LeadingIcon={loadingEarlier ? Spinner : ArrowUpIcon}
            onClick={(event) => {
              event.stopPropagation();
              onLoadEarlier();
            }}
          >
            {loadingEarlier
              ? "Loading runs…"
              : `Load ${count} earlier run${count === 1 ? "" : "s"}`}
          </Button>
        </RowFrame>
      );
    }
    case "notLoaded": {
      // Filled from the newer side, so the runs appear under this row and it stays in place.
      const count = Math.min(row.count, RUNS_FILL_MAX);
      const filling = fillingRunFriendlyId === row.newerRunFriendlyId;
      return (
        <RowFrame level={level}>
          <span className="flex flex-1 items-center justify-center gap-1.5 pr-2">
            <Button
              variant="secondary/small"
              disabled={olderLoadBusy}
              LeadingIcon={filling ? Spinner : ArrowDownIcon}
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
              count !== row.count && (
                <span className="text-xs text-text-faint">{row.count} not loaded</span>
              )
            )}
          </span>
        </RowFrame>
      );
    }
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
          <SessionRowLabel />
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
          dimmed={searchMark?.kind === "noMatches"}
        >
          <RunRowContent
            run={row.run}
            live={live}
            isSelected={isSelected}
            load={load}
            spanCount={spanCount}
            loadBlock={loadBlock}
            searchMark={searchMark}
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
  live,
  isSelected,
  load,
  spanCount,
  loadBlock,
  searchMark,
  checkedAtMs,
  onRetry,
}: {
  run: SessionTraceRun;
  live: LiveRun | undefined;
  isSelected: boolean;
  load: SessionRunLoad | undefined;
  spanCount: number;
  loadBlock: RunLoadBlock | undefined;
  searchMark: RunSearchMark | undefined;
  checkedAtMs: number;
  onRetry: (runFriendlyId: string) => void;
}) {
  const badge = runReasonBadge(run);
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
      {!run.status && <NotInRunStoreLabel starting={isRunStarting(run, checkedAtMs)} />}
      {badge && <RunReasonBadgeView badge={badge} />}
      {/* Only link to the run page when it can show the trace. */}
      {loadBlock?.kind === "unavailable" &&
      loadBlock.reason !== "noSpans" &&
      loadBlock.reason !== "anchorMissing" ? (
        <TraceUnavailableBadge run={run} />
      ) : (
        loadBlock &&
        loadBlock.kind !== "notInRunStore" && (
          <RunReasonBadgeView
            badge={{
              label:
                loadBlock.kind === "logsDeleted"
                  ? "Logs deleted"
                  : loadBlock.reason === "noSpans"
                    ? "No spans"
                    : "Trace unavailable",
              tone: "neutral",
              tooltip: notShownText(loadBlock),
            }}
          />
        )
      )}
      <span className="ml-auto flex shrink-0 items-center gap-3 pr-2 text-xs tabular-nums text-text-dimmed">
        {/* A narrow tree drops the date first, so duration and status stay readable. */}
        <span className="hidden text-text-faint @sm/session-tree:inline">
          <DateTime
            date={run.startedAt ?? run.triggeredAt}
            // The year only when it isn't this one, like most dashboards.
            includeYear={
              new Date(run.startedAt ?? run.triggeredAt).getFullYear() !== new Date().getFullYear()
            }
            includeSeconds={false}
          />
        </span>
        <span className="flex min-w-14 items-center justify-end gap-1.5">
          {/* Not in the run store: the label by its name says so, and there's no duration yet. */}
          {loadBlock?.kind === "notInRunStore" ? null : loadBlock ? (
            <RunDurationLabel run={run} live={live} />
          ) : searchMark?.kind === "noMatches" ? null : searchMark && load ? (
            <RunSearchMarkView mark={searchMark} load={load} run={run} isSelected={isSelected} />
          ) : load && hasLoadStatus(load) ? (
            <RunLoadStatus
              run={run}
              load={load}
              spanCount={spanCount}
              isSelected={isSelected}
              onRetry={onRetry}
            />
          ) : (
            <RunDurationLabel run={run} live={live} />
          )}
        </span>
        {/* The run page's status: an icon at the row's end, its name on hover. */}
        {run.status ? (
          <SimpleTooltip
            button={<TaskRunStatusIcon status={run.status} className="size-4" />}
            content={runStatusTitle(run.status)}
            disableHoverableContent
          />
        ) : (
          // Keeps the date and duration lined up with rows that have a status.
          <span className="size-4" />
        )}
      </span>
    </>
  );
}

/** Drag has no key, so its legend entry shows the zoom icon in a key-shaped box instead. */
function DragToZoomHint() {
  return (
    <div className="flex items-center gap-0.5">
      <span className={cn(shortcutKeyVariants.medium, "ml-0 mr-0 px-0.5")}>
        <MagnifyingGlassPlusIcon className="size-3" />
      </span>
      <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
        Drag to zoom
      </Paragraph>
    </div>
  );
}

function SessionRowLabel() {
  const taskIdentifier = useContext(SessionTaskContext);
  return (
    <span className="min-w-0 truncate text-sm text-text-bright">
      Session
      {taskIdentifier && (
        <span className="font-mono text-xs text-text-dimmed"> · {taskIdentifier}</span>
      )}
    </span>
  );
}

/** j / k move between runs, as on the run page; Esc goes back to the session (tree handler). */
function SessionRunShortcuts({
  enabled,
  onPrevious,
  onNext,
}: {
  enabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  useShortcutKeys({ shortcut: { key: "j" }, action: onPrevious, disabled: !enabled });
  useShortcutKeys({ shortcut: { key: "k" }, action: onNext, disabled: !enabled });
  return (
    <>
      <div className="flex items-center gap-0.5">
        <ShortcutKey shortcut={{ key: "j" }} variant="medium" className="ml-0 mr-0" />
        <ShortcutKey shortcut={{ key: "k" }} variant="medium" className="ml-0 mr-0" />
        <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
          Previous/next run
        </Paragraph>
      </div>
      <div className="flex items-center gap-0.5">
        <ShortcutKey shortcut={{ key: "esc" }} variant="medium" className="ml-0 mr-0" />
        <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
          Session
        </Paragraph>
      </div>
    </>
  );
}

function NotInRunStoreLabel({ starting }: { starting: boolean }) {
  return (
    <SimpleTooltip
      button={
        <span className="shrink-0 text-xs text-text-faint">
          {starting ? "Starting…" : "Unavailable"}
        </span>
      }
      content={notShownText({ kind: starting ? "starting" : "neverStarted" })}
      disableHoverableContent
    />
  );
}

/** A plain element, not a component, so a tooltip's `asChild` can wrap it. */
function runBadgeClassName(tone: RunReasonBadge["tone"]) {
  return cn(
    "min-w-0 max-w-[12rem] truncate rounded-sm border px-1 text-xxs leading-4",
    tone === "warning" ? "border-warning/60 text-warning" : "border-grid-bright text-text-dimmed"
  );
}

function runBadgeLabel(label: string, tone: RunReasonBadge["tone"]) {
  return <span className={runBadgeClassName(tone)}>{label}</span>;
}

function RunReasonBadgeView({ badge }: { badge: RunReasonBadge }) {
  const label = runBadgeLabel(badge.label, badge.tone);
  if (!badge.tooltip) return label;
  return (
    <SimpleTooltip
      button={label}
      content={badge.tooltip}
      // Above, it sits exactly over the row before and reads like a row of its own.
      side="right"
      className="max-w-xs"
      disableHoverableContent
      asChild
    />
  );
}

/** During a search: the run's matches, or that it wasn't searched yet. */
function RunSearchMarkView({
  mark,
  load,
  run,
  isSelected,
}: {
  mark: RunSearchMark;
  load: SessionRunLoad;
  run: SessionTraceRun;
  isSelected: boolean;
}) {
  if (mark.kind === "notSearched") return <span className="text-text-faint">Not searched</span>;
  if (mark.kind !== "matches") return null;
  return (
    <>
      {mark.soFar && <Spinner className="size-3" />}
      <span className={mark.count > 0 ? "text-text-bright" : undefined}>
        {matchesText(mark.count)}
        {mark.soFar ? " so far" : ""}
      </span>
      {mark.partly && load.state === "cutOff" && (
        <>
          <SimpleTooltip
            button={<span className="text-text-faint">· partly</span>}
            content={notShownText({
              kind: "cutOff",
              started: load.started,
              limit: load.limit,
              spanLimit: load.spanLimit,
            })}
            disableHoverableContent
          />
          {/* Its other spans are only on the run page. */}
          <RunPageIconLink run={run} reason="cutOff" isSelected={isSelected} />
        </>
      )}
    </>
  );
}

function TraceUnavailableBadge({ run }: { run: SessionTraceRun }) {
  const track = useSessionViewAnalytics();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const runPath = v3RunPath(organization, project, environment, run);
  const open = () => track("open_run_page", { from: "badge", reason: "unavailable" });
  // The badge is itself the link, so Tab reaches it and Enter opens the run page (a tooltip
  // can't take focus). The tooltip's View run link is the same link for the pointer.
  return (
    <SimpleTooltip
      asChild
      tabbable
      side="right"
      button={
        <Link
          to={runPath}
          className={cn(
            runBadgeClassName("neutral"),
            "focus-custom hover:border-text-dimmed hover:text-text-bright"
          )}
          onClick={(event) => {
            event.stopPropagation();
            open();
          }}
        >
          Trace available on run page
        </Link>
      }
      content={
        <TextLink to={runPath} onClick={open}>
          View run
        </TextLink>
      }
    />
  );
}

function RunPageIconLink({
  run,
  reason,
  isSelected,
}: {
  run: SessionTraceRun;
  reason: string;
  isSelected: boolean;
}) {
  const track = useSessionViewAnalytics();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  return (
    <SimpleTooltip
      asChild
      tabbable
      button={
        <Link
          to={v3RunPath(organization, project, environment, run)}
          aria-label="View run"
          // Hidden with opacity, not visibility, so it stays in the Tab order and shows on focus.
          className={cn(
            "flex size-5 items-center justify-center rounded-sm text-text-dimmed hover:bg-surface-control hover:text-text-bright focus-custom focus-visible:opacity-100 group-hover/sessionrow:pointer-events-auto group-hover/sessionrow:opacity-100",
            isSelected ? "opacity-100" : "pointer-events-none opacity-0"
          )}
          onClick={(event) => {
            event.stopPropagation();
            track("open_run_page", { from: "row", reason });
          }}
        >
          <ArrowTopRightOnSquareIcon className="size-3.5" />
        </Link>
      }
      content="View run"
      disableHoverableContent
    />
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
  isSelected,
  onRetry,
}: {
  run: SessionTraceRun;
  load: SessionRunLoad;
  spanCount: number;
  isSelected: boolean;
  onRetry: (runFriendlyId: string) => void;
}) {
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
          <RunPageIconLink run={run} reason="cutOff" isSelected={isSelected} />
        </>
      );
    }
    default:
      return null;
  }
}

// Only the live run counts up; an older unfinished run shows none (its start is beside it).
function RunDurationLabel({ run, live }: { run: SessionTraceRun; live: LiveRun | undefined }) {
  const active = useContext(TraceTabActiveContext);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useInterval({
    interval: 1_000,
    disabled: !live || !!live.wait || !active,
    callback: () => setNowMs(Date.now()),
  });

  const duration = runDuration(run, nowMs);
  if (!duration) return run.status && !isFinalRunStatus(run.status) ? <>Queued</> : null;
  if (duration.finished) return <>{formatDurationMilliseconds(duration.ms, { style: "short" })}</>;
  if (live?.wait) {
    // A fixed label: a counter changing every minute would pull the eye for nothing.
    const sinceMs = live.wait.sinceMs;
    return sinceMs === undefined ? (
      <>Waiting for message</>
    ) : (
      <SimpleTooltip
        button={<span>Waiting for message</span>}
        content={
          <>
            Idle since <DateTime date={new Date(sinceMs)} />
          </>
        }
        disableHoverableContent
      />
    );
  }
  // Counts up like the runs list's LiveTimer; the status icon already says it's running.
  if (live) {
    return <>{formatDurationMilliseconds(duration.ms, { style: "short", maxDecimalPoints: 0 })}</>;
  }
  return null;
}

function RowFrame({
  level,
  isSelected = false,
  canExpand = false,
  isExpanded = false,
  onToggle,
  dimmed = false,
  noHover = false,
  children,
}: {
  level: number;
  /** Not clickable (only its button is), so it doesn't hover: the "Load earlier" row. */
  noHover?: boolean;
  isSelected?: boolean;
  canExpand?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
  /** A searched run with no matches: still readable, but out of the way. */
  dimmed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "group/sessionrow flex items-center overflow-hidden rounded-l-sm",
        "h-8",
        noHover
          ? undefined
          : isSelected
            ? "bg-grid-dimmed hover:bg-grid-bright"
            : "hover:bg-grid-dimmed",
        dimmed && "opacity-60"
      )}
    >
      {/* Laid out like the run page's rows: indent and arrow flush, so each level steps in. */}
      <div className="flex shrink-0 items-center self-stretch">
        {Array.from({ length: level }).map((_, index) => (
          <div key={index} className="w-2 shrink-0 self-stretch border-r border-grid-bright" />
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
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pl-1">{children}</div>
    </div>
  );
}
