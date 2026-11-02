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

export const SESSION_NODE_ID = "session";
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

// FNV-1a: a cheap hash so the tree's shape can be compared without keeping every id.
function hashString(hash: number, value: string) {
  let next = hash;
  for (let i = 0; i < value.length; i++) {
    next ^= value.charCodeAt(i);
    next = Math.imul(next, 16777619);
  }
  return next >>> 0;
}

const HASH_SEED = 2166136261;

/**
 * One flat list for the whole session: the session row, then runs oldest first, each followed
 * by its loaded spans. Runs can come from several pages; duplicates are merged by friendlyId,
 * the later copy winning, and missing run numbers between pages become a "not loaded" row.
 * `structureKey` changes whenever the rows or their nesting change, even at the same size.
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
}): { tree: FlatTree<SessionTreeRow<TSpanData>>; structureKey: string } {
  const session: SessionTreeNode<TSpanData> = {
    id: SESSION_NODE_ID,
    children: [],
    hasChildren: false,
    level: 0,
    data: { kind: "session", runCount: totalCount },
  };
  const tree: SessionTreeNode<TSpanData>[] = [session];
  let shape = HASH_SEED;

  const addSessionChild = (id: string, data: SessionTreeRow<TSpanData>) => {
    session.children.push(id);
    shape = hashString(shape, id);
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
    if (spans) {
      shape = hashString(shape, String(graftSpans(tree, runNode, run.friendlyId, spans)));
    }
    previous = run;
  }

  session.hasChildren = session.children.length > 0;
  return { tree, structureKey: `${tree.length}:${shape}` };
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

type GraftedSpans = { nodes: SessionTreeNode<unknown>[]; topLevelIds: string[]; shape: number };

// Keyed by a run's events array: a run whose events didn't change reuses its nodes.
const graftCache = new WeakMap<object, GraftedSpans>();

function graftSpans<TSpanData>(
  tree: SessionTreeNode<TSpanData>[],
  runNode: SessionTreeNode<TSpanData>,
  runFriendlyId: string,
  spans: SessionTraceSpan<TSpanData>[]
) {
  let grafted = graftCache.get(spans) as GraftedSpans | undefined;
  if (!grafted) {
    grafted = graftRun(runNode.id, runNode.level, runFriendlyId, spans);
    graftCache.set(spans, grafted);
  }
  // A run can have 150k spans: spreading that many arguments throws, so push one at a time.
  for (const id of grafted.topLevelIds) runNode.children.push(id);
  runNode.hasChildren = grafted.topLevelIds.length > 0;
  for (const node of grafted.nodes) tree.push(node as SessionTreeNode<TSpanData>);
  return grafted.shape;
}

// The run's root span is hidden: the run row stands in for it, so its children move up to the run.
function graftRun<TSpanData>(
  runNodeId: string,
  runLevel: number,
  runFriendlyId: string,
  spans: SessionTraceSpan<TSpanData>[]
): GraftedSpans {
  const byId = new Map<string, SessionTreeNode<TSpanData>>();
  const nodes: SessionTreeNode<TSpanData>[] = [];
  const topLevelIds: string[] = [];
  let shape = HASH_SEED;

  for (const span of spans) {
    if (span.level === 0) continue;

    const parent = span.parentId ? byId.get(span.parentId) : undefined;
    const node: SessionTreeNode<TSpanData> = {
      id: spanNodeId(runFriendlyId, span.id),
      parentId: parent?.id ?? runNodeId,
      children: [],
      hasChildren: false,
      level: (parent?.level ?? runLevel) + 1,
      data: { kind: "span", runFriendlyId, spanId: span.id, span: span.data },
    };
    if (parent) {
      parent.children.push(node.id);
      parent.hasChildren = true;
    } else {
      topLevelIds.push(node.id);
    }
    byId.set(span.id, node);
    nodes.push(node);
    shape = hashString(hashString(shape, node.id), node.parentId ?? "");
  }

  return { nodes: nodes as SessionTreeNode<unknown>[], topLevelIds, shape };
}
