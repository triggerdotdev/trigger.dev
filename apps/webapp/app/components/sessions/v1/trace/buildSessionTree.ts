import type { FlatTree, FlatTreeItem } from "~/components/primitives/TreeView/TreeView";
import type { SessionTraceRun, SessionTraceSpan } from "./sessionTraceTypes";

/** Quiet periods longer than this between two runs fold into one row. */
export const GAP_FOLD_MS = 10 * 60_000;

export type SessionTreeRow<TSpanData> =
  | { kind: "session"; runCount: number }
  | { kind: "loadEarlier"; count: number }
  | { kind: "notLoaded"; count: number; olderRunFriendlyId: string; newerRunFriendlyId: string }
  | { kind: "gap"; durationMs: number }
  | { kind: "run"; run: SessionTraceRun; spansLoaded: boolean }
  | { kind: "span"; runFriendlyId: string; spanId: string; span: TSpanData };

type SessionTreeNode<TSpanData> = FlatTreeItem<SessionTreeRow<TSpanData>>;

const SESSION_NODE_ID = "session";
const LOAD_EARLIER_NODE_ID = "loadEarlier";

export function runNodeId(runFriendlyId: string) {
  return `run:${runFriendlyId}`;
}

export function spanNodeId(runFriendlyId: string, spanId: string) {
  return `${runFriendlyId}:${spanId}`;
}

/** Rows that only label the list: arrow keys skip them and they can't be selected. */
export function isSelectableRow(row: SessionTreeRow<unknown>) {
  return row.kind === "session" || row.kind === "run" || row.kind === "span";
}

/**
 * One flat list for the whole session: the session row, then runs oldest first, each followed
 * by its loaded spans. Runs can come from several pages; duplicates are merged by friendlyId,
 * the later copy winning, and missing run numbers between pages become a "not loaded" row.
 */
export function buildSessionTree<TSpanData>({
  runs,
  totalCount,
  spansByRun,
}: {
  runs: SessionTraceRun[];
  totalCount: number;
  /** Loaded events per run friendlyId, in trace order (parents before children). */
  spansByRun: ReadonlyMap<string, SessionTraceSpan<TSpanData>[]>;
}): FlatTree<SessionTreeRow<TSpanData>> {
  const session: SessionTreeNode<TSpanData> = {
    id: SESSION_NODE_ID,
    children: [],
    hasChildren: false,
    level: 0,
    data: { kind: "session", runCount: totalCount },
  };
  const tree: SessionTreeNode<TSpanData>[] = [session];

  const addSessionChild = (id: string, data: SessionTreeRow<TSpanData>) => {
    session.children.push(id);
    const node: SessionTreeNode<TSpanData> = {
      id,
      parentId: SESSION_NODE_ID,
      children: [],
      hasChildren: false,
      level: 1,
      data,
    };
    tree.push(node);
    return node;
  };

  const ordered = uniqueRunsOldestFirst(runs);
  const oldest = ordered[0];
  if (oldest && oldest.number > 1) {
    addSessionChild(LOAD_EARLIER_NODE_ID, { kind: "loadEarlier", count: oldest.number - 1 });
  }

  let previous: SessionTraceRun | undefined;
  for (const run of ordered) {
    if (previous) {
      const missing = run.number - previous.number - 1;
      if (missing > 0) {
        addSessionChild(`notLoaded:${run.friendlyId}`, {
          kind: "notLoaded",
          count: missing,
          olderRunFriendlyId: previous.friendlyId,
          newerRunFriendlyId: run.friendlyId,
        });
      } else {
        const gapMs = quietGapMs(previous, run);
        if (gapMs !== undefined && gapMs > GAP_FOLD_MS) {
          addSessionChild(`gap:${run.friendlyId}`, { kind: "gap", durationMs: gapMs });
        }
      }
    }

    const spans = spansByRun.get(run.friendlyId);
    const runNode = addSessionChild(runNodeId(run.friendlyId), {
      kind: "run",
      run,
      spansLoaded: spans !== undefined,
    });
    if (spans) graftSpans(tree, runNode, run.friendlyId, spans);
    previous = run;
  }

  session.hasChildren = session.children.length > 0;
  return tree;
}

function uniqueRunsOldestFirst(runs: SessionTraceRun[]) {
  const byId = new Map<string, SessionTraceRun>();
  for (const run of runs) byId.set(run.friendlyId, run);
  return [...byId.values()].sort((a, b) => a.number - b.number);
}

function quietGapMs(previous: SessionTraceRun, next: SessionTraceRun) {
  if (!previous.finishedAt || !next.createdAt) return undefined;
  return new Date(next.createdAt).getTime() - new Date(previous.finishedAt).getTime();
}

// The run's root span is hidden: the run row stands in for it, so its children move up to the run.
function graftSpans<TSpanData>(
  tree: SessionTreeNode<TSpanData>[],
  runNode: SessionTreeNode<TSpanData>,
  runFriendlyId: string,
  spans: SessionTraceSpan<TSpanData>[]
) {
  const grafted = new Map<string, SessionTreeNode<TSpanData>>();

  for (const span of spans) {
    if (span.level === 0) continue;

    const parent = (span.parentId && grafted.get(span.parentId)) || runNode;
    const node: SessionTreeNode<TSpanData> = {
      id: spanNodeId(runFriendlyId, span.id),
      parentId: parent.id,
      children: [],
      hasChildren: false,
      level: parent.level + 1,
      data: { kind: "span", runFriendlyId, spanId: span.id, span: span.data },
    };
    parent.children.push(node.id);
    parent.hasChildren = true;
    grafted.set(span.id, node);
    tree.push(node);
  }
}
