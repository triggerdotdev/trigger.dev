import type { RunTraceStart } from "~/presenters/v3/TraceChunkPresenter.server";

/** At most this many runs fetch their spans at once, first chunk and later pages included. */
export const MAX_CONCURRENT_RUN_LOADS = 3;

type RunTraceUnavailableReason = Extract<RunTraceStart, { kind: "unavailable" }>["reason"];

type SettledRunLoad =
  | { state: "progressive" }
  | { state: "empty" }
  | { state: "unavailable"; reason: RunTraceUnavailableReason }
  | { state: "logsDeleted" }
  | { state: "error"; message: string };

/**
 * `loadId` identifies one load attempt from start to finish: a settle for an older attempt is
 * ignored, and the trace source is keyed by it so a new attempt always starts clean.
 */
export type SessionRunLoad =
  | { state: "idle" }
  | { state: "queued" }
  | { state: "loading"; loadId: number }
  /** First chunk shown, later pages still loading; keeps its slot. */
  | { state: "paging"; loadId: number }
  | (SettledRunLoad & { loadId: number });

/** Where a run's read got to: paging after its first chunk, or how it ended. */
export type SessionRunLoadOutcome = { state: "paging" } | SettledRunLoad;

export type SessionRunLoads = {
  loads: Readonly<Record<string, SessionRunLoad>>;
  /** Queued runs in request order. */
  queue: readonly string[];
  nextLoadId: number;
  /** Run rows that are expanded in the tree. */
  expanded: ReadonlySet<string>;
  /** Runs in the run store: only those have a trace to read. */
  withStatus: ReadonlySet<string>;
  /** Runs whose loaded trace has at least one span on screen. */
  withSpans: ReadonlySet<string>;
  /** The session's newest run, when it's loaded. */
  newestRunId: string | undefined;
};

export type SessionRunLoadsAction =
  /** The tree expanded or collapsed a run row. */
  | { type: "expanded"; runFriendlyId: string; expanded: boolean }
  /** The runs page changed: which runs are in the run store, and which is newest. */
  | { type: "runsChanged"; withStatus: string[]; newestRunId: string | undefined }
  /** A run's loaded trace went from no spans to some, or back (when it unmounts). */
  | { type: "spansChanged"; runFriendlyId: string; hasSpans: boolean }
  | { type: "settle"; runFriendlyId: string; loadId: number; outcome: SessionRunLoadOutcome }
  /** Frees runs back to idle, cancelling a fetch in flight (its late settle won't match). */
  | { type: "release"; runFriendlyIds: string[] };

const IDLE: SessionRunLoad = { state: "idle" };

function isInFlight(
  load: SessionRunLoad
): load is Extract<SessionRunLoad, { state: "loading" | "paging" }> {
  return load.state === "loading" || load.state === "paging";
}

/** The current load attempt, if the run has one. */
export function runLoadId(load: SessionRunLoad): number | undefined {
  return "loadId" in load ? load.loadId : undefined;
}

/** The starting state, with the run that opens expanded. */
export function createSessionRunLoads(expandedRunIds: string[] = []): SessionRunLoads {
  return {
    loads: {},
    queue: [],
    nextLoadId: 1,
    expanded: new Set(expandedRunIds),
    withStatus: new Set(),
    withSpans: new Set(),
    newestRunId: undefined,
  };
}

export function runLoad(loads: SessionRunLoads, runFriendlyId: string): SessionRunLoad {
  return loads.loads[runFriendlyId] ?? IDLE;
}

/**
 * Every decision about loading a run's trace lives here:
 * - An expanded run that is in the run store and idle loads, whenever that becomes true.
 * - Expanding a failed run reads it again, but only if none of its spans are on screen.
 * - At most 3 runs load at once; a run holds its slot until all its pages are in.
 * - A run that settled with no spans becomes loaded when its first span arrives while tailing.
 * - When a newer run takes over, the previous newest run is read afresh once if it was still empty.
 */
export function sessionRunLoadsReducer(
  current: SessionRunLoads,
  action: SessionRunLoadsAction
): SessionRunLoads {
  switch (action.type) {
    case "expanded": {
      const { runFriendlyId: id } = action;
      if (current.expanded.has(id) === action.expanded) return current;
      const expanded = new Set(current.expanded);
      if (action.expanded) expanded.add(id);
      else expanded.delete(id);
      const next = { ...current, expanded };

      const load = runLoad(current, id);
      if (action.expanded && load.state === "error" && !current.withSpans.has(id)) {
        return loadWanted(enqueue(next, [id]));
      }
      return loadWanted(next);
    }
    case "runsChanged": {
      const sameStatus = sameMembers(current.withStatus, action.withStatus);
      if (sameStatus && current.newestRunId === action.newestRunId) return current;

      let next: SessionRunLoads = {
        ...current,
        withStatus: sameStatus ? current.withStatus : new Set(action.withStatus),
        newestRunId: action.newestRunId,
      };
      const previous = current.newestRunId;
      if (
        previous &&
        previous !== action.newestRunId &&
        runLoad(next, previous).state === "empty"
      ) {
        next = withoutLoads(next, [previous]);
      }
      return loadWanted(next);
    }
    case "spansChanged": {
      const { runFriendlyId: id, hasSpans } = action;
      if (current.withSpans.has(id) === hasSpans) return current;
      const withSpans = new Set(current.withSpans);
      if (hasSpans) withSpans.add(id);
      else withSpans.delete(id);

      const load = runLoad(current, id);
      const loads =
        hasSpans && load.state === "empty"
          ? { ...current.loads, [id]: { state: "progressive" as const, loadId: load.loadId } }
          : current.loads;
      return { ...current, withSpans, loads };
    }
    case "settle": {
      const load = runLoad(current, action.runFriendlyId);
      if (!isInFlight(load) || load.loadId !== action.loadId) return current;

      const next: SessionRunLoad = { ...action.outcome, loadId: load.loadId };
      return startQueued({ ...current, loads: { ...current.loads, [action.runFriendlyId]: next } });
    }
    case "release": {
      const released = action.runFriendlyIds.filter((id) => id in current.loads);
      if (released.length === 0) return current;
      return loadWanted(withoutLoads(current, released));
    }
  }
}

// Queues expanded runs that can load and aren't loaded, then fills free slots.
function loadWanted(current: SessionRunLoads): SessionRunLoads {
  const wanted = [...current.expanded].filter(
    (id) => current.withStatus.has(id) && runLoad(current, id).state === "idle"
  );
  return startQueued(wanted.length > 0 ? enqueue(current, wanted) : current);
}

function enqueue(current: SessionRunLoads, runFriendlyIds: string[]): SessionRunLoads {
  const loads = { ...current.loads };
  for (const id of runFriendlyIds) loads[id] = { state: "queued" };
  return { ...current, loads, queue: [...current.queue, ...runFriendlyIds] };
}

function withoutLoads(current: SessionRunLoads, runFriendlyIds: string[]): SessionRunLoads {
  const removed = new Set(runFriendlyIds);
  const loads = { ...current.loads };
  for (const id of removed) delete loads[id];
  return { ...current, loads, queue: current.queue.filter((id) => !removed.has(id)) };
}

function startQueued(current: SessionRunLoads): SessionRunLoads {
  let inFlight = Object.values(current.loads).filter(isInFlight).length;
  if (inFlight >= MAX_CONCURRENT_RUN_LOADS || current.queue.length === 0) return current;

  const loads = { ...current.loads };
  const queue = [...current.queue];
  let nextLoadId = current.nextLoadId;
  while (inFlight < MAX_CONCURRENT_RUN_LOADS) {
    const id = queue.shift();
    if (!id) break;
    loads[id] = { state: "loading", loadId: nextLoadId++ };
    inFlight++;
  }
  return { ...current, loads, queue, nextLoadId };
}

function sameMembers(set: ReadonlySet<string>, items: string[]) {
  return set.size === new Set(items).size && items.every((item) => set.has(item));
}
