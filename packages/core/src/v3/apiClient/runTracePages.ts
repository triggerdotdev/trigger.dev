import type {
  RetrieveRunTraceAttemptFailure,
  RetrieveRunTracePageResponseBody,
  RetrieveRunTracePageSpan,
} from "../schemas/api.js";

export type RunTraceNode = RetrieveRunTracePageSpan & { children: RunTraceNode[] };

type TracePage = Pick<RetrieveRunTracePageResponseBody, "data" | "attemptFailures">;

/**
 * Rebuilds the span tree from `retrieveRunTracePage` pages, in page order.
 *
 * Like the unpaged trace, a span still in progress under a finished ancestor takes the
 * ancestor's outcome: cancelled if the ancestor was cancelled, or errored if the ancestor
 * failed the span's attempt.
 */
export function assembleRunTracePages(pages: TracePage[]): RunTraceNode[] {
  const nodes = new Map<string, RunTraceNode>();
  for (const page of pages) {
    for (const span of page.data) {
      const existing = nodes.get(span.id);
      nodes.set(span.id, existing ? mergeRepeatedSpan(existing, span) : { ...span, children: [] });
    }
  }

  const failuresBySpanId = new Map<string, RetrieveRunTraceAttemptFailure[]>();
  for (const page of pages) {
    for (const failure of page.attemptFailures) {
      const failures = failuresBySpanId.get(failure.spanId) ?? [];
      failures.push(failure);
      failuresBySpanId.set(failure.spanId, failures);
    }
  }

  const ordered = [...nodes.values()].sort(byStart);
  for (const node of ordered) {
    applyFinishedAncestor(node, nodes, failuresBySpanId);
  }

  // Malformed parent links can form a loop; its spans become roots instead of vanishing.
  const inCycle = findCycleMembers(nodes);
  const roots: RunTraceNode[] = [];
  for (const node of ordered) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent && !inCycle.has(node.id)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function byStart(a: RunTraceNode, b: RunTraceNode): number {
  const diff = a.startTime.getTime() - b.startTime.getTime();
  return diff !== 0 ? diff : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function findCycleMembers(nodes: Map<string, RunTraceNode>): Set<string> {
  const inCycle = new Set<string>();
  const done = new Set<string>();
  for (const start of nodes.keys()) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let id: string | undefined = start;
    while (id && nodes.has(id) && !done.has(id) && !onPath.has(id)) {
      path.push(id);
      onPath.add(id);
      id = nodes.get(id)!.parentId;
    }
    if (id && onPath.has(id)) {
      for (const member of path.slice(path.indexOf(id))) inCycle.add(member);
    }
    for (const visited of path) done.add(visited);
  }
  return inCycle;
}

// A span's in-progress and final records can land on different pages, in either order.
function mergeRepeatedSpan(existing: RunTraceNode, span: RetrieveRunTracePageSpan): RunTraceNode {
  const finished = existing.isPartial && !span.isPartial ? { ...span, children: [] } : existing;
  const startTime = span.startTime < existing.startTime ? span.startTime : existing.startTime;
  return {
    ...finished,
    startTime,
    attemptNumber: finished.attemptNumber ?? existing.attemptNumber ?? span.attemptNumber,
  };
}

function applyFinishedAncestor(
  node: RunTraceNode,
  nodes: Map<string, RunTraceNode>,
  failuresBySpanId: Map<string, RetrieveRunTraceAttemptFailure[]>
) {
  if (node.level !== "TRACE" || !node.isPartial) return;

  const ancestor = findFinishedAncestor(node, nodes);
  if (!ancestor) return;

  const ancestorEnd = ancestor.startTime.getTime() + ancestor.duration / 1_000_000;
  // A span that started after its ancestor ended would otherwise get a negative duration.
  const durationToAncestorEnd = Math.max(0, (ancestorEnd - node.startTime.getTime()) * 1_000_000);

  if (ancestor.isCancelled) {
    node.isCancelled = true;
    node.isPartial = false;
    node.isError = false;
    node.duration = durationToAncestorEnd;
  }

  if (ancestor.isError && node.attemptNumber) {
    const failure = failuresBySpanId
      .get(ancestor.id)
      ?.find((f) => f.attemptNumber === node.attemptNumber && f.runId === node.runId);

    if (failure) {
      // Record it on this span too, so its own unfinished descendants inherit it.
      failuresBySpanId.set(node.id, [...(failuresBySpanId.get(node.id) ?? []), failure]);
      node.isError = true;
      node.isPartial = false;
      node.isCancelled = false;
      node.duration = durationToAncestorEnd;
    }
  }
}

function findFinishedAncestor(
  node: RunTraceNode,
  nodes: Map<string, RunTraceNode>
): RunTraceNode | undefined {
  const seen = new Set<string>([node.id]);
  let parent = node.parentId ? nodes.get(node.parentId) : undefined;
  while (parent && !seen.has(parent.id)) {
    if (parent.level === "TRACE" && !parent.isPartial) return parent;
    seen.add(parent.id);
    parent = parent.parentId ? nodes.get(parent.parentId) : undefined;
  }
  return undefined;
}
