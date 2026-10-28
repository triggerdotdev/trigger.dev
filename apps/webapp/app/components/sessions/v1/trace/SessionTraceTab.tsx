import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { TreeView, useTree } from "~/components/primitives/TreeView/TreeView";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import { useInterval } from "~/hooks/useInterval";
import { cn } from "~/utils/cn";
import { isFinalRunStatus } from "~/v3/taskStatus";
import { buildSessionTree, isSelectableRow, type SessionTreeRow } from "./buildSessionTree";
import { initiallyExpandedRunFriendlyId, liveRunFriendlyId, runDuration } from "./sessionRunTiming";
import type { SessionTraceRun } from "./sessionTraceTypes";
import { runReasonLabel } from "./sessionTraceView";
import { RUNS_PAGE_SIZE, useSessionRunPages } from "./useSessionRunPages";

const ROW_HEIGHT_PX = 32;

// Spans arrive in a later change; until then a run row has nothing to graft.
const NO_SPANS = new Map();

/** The session's runs as one tree, newest page first, with earlier pages on request. */
export function SessionTraceTab({ runsPath }: { runsPath: string }) {
  const pages = useSessionRunPages(runsPath);

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
    />
  );
}

type Row = SessionTreeRow<unknown>;

function SessionTraceTree({
  runs,
  totalCount,
  canLoadEarlier,
  loadingEarlier,
  earlierError,
  onLoadEarlier,
}: {
  runs: SessionTraceRun[];
  totalCount: number;
  canLoadEarlier: boolean;
  loadingEarlier: boolean;
  earlierError: string | undefined;
  onLoadEarlier: () => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const tree = useMemo(
    () => buildSessionTree<unknown>({ runs, totalCount, spansByRun: NO_SPANS }),
    [runs, totalCount]
  );
  const rowsById = useMemo(() => new Map(tree.map((node) => [node.id, node.data])), [tree]);
  const liveRunId = liveRunFriendlyId(runs, totalCount);
  const oldestRunNodeId = tree.find((node) => node.data.kind === "run")?.id;
  // Captured once: runs added later (earlier pages, new runs) start collapsed.
  const [openRunId] = useState(() => initiallyExpandedRunFriendlyId(runs, totalCount));

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
    // An earlier page of one run swaps the load-earlier row for a run without changing the length.
    structureKey: oldestRunNodeId,
    parentRef,
    estimatedRowHeight: () => ROW_HEIGHT_PX,
    isCollapsedByDefault: (node) =>
      node.data.kind === "run" && node.data.run.friendlyId !== openRunId,
    canExpand: (node) => node.data.kind === "run" || node.hasChildren,
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

  const runNodeIds = tree.filter((node) => node.data.kind === "run").map((node) => node.id);
  const allExpanded = runNodeIds.every((id) => nodes[id]?.expanded);
  const toggleAll = () => {
    for (const id of runNodeIds) {
      if (allExpanded) collapseNode(id);
      else expandNode(id, false);
    }
  };

  return (
    <div className="grid h-full grid-rows-[2.25rem_1fr] overflow-hidden bg-background-bright">
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
      <TreeView
        parentRef={parentRef}
        virtualizer={virtualizer}
        staticRowHeight
        tree={tree}
        nodes={nodes}
        // No keyboard navigation until selection lands: keys would stop on label rows.
        getTreeProps={() => ({ ...getTreeProps(), onKeyDown: undefined })}
        getNodeProps={(id) => ({
          ...getNodeProps(id),
          onClick: () => {
            const row = rowsById.get(id);
            if (row && isSelectableRow(row)) selectNode(id);
          },
        })}
        parentClassName="h-full pl-3"
        renderNode={({ node, state }) => (
          <SessionTreeRowView
            row={node.data}
            level={node.level}
            isSelected={state.selected}
            isExpanded={state.expanded}
            canExpand={node.data.kind === "run" || node.hasChildren}
            onToggle={() => toggleExpandNode(node.id, false)}
            isLive={node.data.kind === "run" && node.data.run.friendlyId === liveRunId}
            canLoadEarlier={canLoadEarlier}
            loadingEarlier={loadingEarlier}
            earlierError={earlierError}
            onLoadEarlier={loadEarlier}
          />
        )}
      />
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
          <RunRowContent run={row.run} isLive={isLive} />
        </RowFrame>
      );
    case "span":
      return null;
  }
}

function RunRowContent({ run, isLive }: { run: SessionTraceRun; isLive: boolean }) {
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
