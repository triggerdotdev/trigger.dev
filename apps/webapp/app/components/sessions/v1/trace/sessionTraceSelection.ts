import { runNodeId, SESSION_NODE_ID, spanNodeId, type SessionTreeRow } from "./buildSessionTree";

/** Search params of the session page's selection. */
export const SESSION_RUN_PARAM = "run";
export const SESSION_SPAN_PARAM = "span";
/** The span panel's tab, kept apart from the session details' `tab`. */
export const SESSION_SPAN_TAB_PARAM = "spanTab";

export type SessionTraceSelection =
  | { kind: "session" }
  | { kind: "run"; runFriendlyId: string }
  | { kind: "span"; runFriendlyId: string; spanId: string };

const RUN_FRIENDLY_ID = /^run_[a-z0-9]+$/;
const SPAN_ID = /^[a-zA-Z0-9_-]+$/;

/** A span without a valid run means nothing, so it falls back to the session. */
export function parseSessionTraceSelection(params: URLSearchParams): SessionTraceSelection {
  const run = params.get(SESSION_RUN_PARAM);
  if (!run || !RUN_FRIENDLY_ID.test(run)) return { kind: "session" };

  const span = params.get(SESSION_SPAN_PARAM);
  if (!span || !SPAN_ID.test(span)) return { kind: "run", runFriendlyId: run };
  return { kind: "span", runFriendlyId: run, spanId: span };
}

/** Values for `useSearchParams().replace`: undefined removes a param. */
export function selectionSearchValues(selection: SessionTraceSelection) {
  return {
    [SESSION_RUN_PARAM]: selection.kind === "session" ? undefined : selection.runFriendlyId,
    [SESSION_SPAN_PARAM]: selection.kind === "span" ? selection.spanId : undefined,
  };
}

export function isSameSelection(a: SessionTraceSelection, b: SessionTraceSelection) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "session" || b.kind === "session") return true;
  if (a.runFriendlyId !== b.runFriendlyId) return false;
  return a.kind !== "span" || b.kind !== "span" || a.spanId === b.spanId;
}

/** The tree node a selection points at. */
export function selectionNodeId(selection: SessionTraceSelection) {
  switch (selection.kind) {
    case "session":
      return SESSION_NODE_ID;
    case "run":
      return runNodeId(selection.runFriendlyId);
    case "span":
      return spanNodeId(selection.runFriendlyId, selection.spanId);
  }
}

/** The selection a row makes; undefined for rows that only label the list. */
export function rowSelection(row: SessionTreeRow<unknown>): SessionTraceSelection | undefined {
  switch (row.kind) {
    case "session":
      return { kind: "session" };
    case "run":
      return { kind: "run", runFriendlyId: row.run.friendlyId };
    case "span":
      return { kind: "span", runFriendlyId: row.runFriendlyId, spanId: row.spanId };
    default:
      return undefined;
  }
}

/**
 * The row the tree highlights for a selection. A span not in the tree yet (still loading, or
 * not in its run at all) highlights its run, so a missing span needs no URL rewrite.
 */
export function highlightedNodeId(
  selection: SessionTraceSelection,
  inTree: (nodeId: string) => boolean
): string | undefined {
  const nodeId = selectionNodeId(selection);
  if (inTree(nodeId)) return nodeId;
  if (selection.kind !== "span") return undefined;
  const runNode = runNodeId(selection.runFriendlyId);
  return inTree(runNode) ? runNode : undefined;
}
