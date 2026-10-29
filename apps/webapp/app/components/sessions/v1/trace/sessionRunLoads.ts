import type { RunTraceStart } from "~/presenters/v3/TraceChunkPresenter.server";

/** At most this many runs fetch their spans at once, first chunk and later pages included. */
export const MAX_CONCURRENT_RUN_LOADS = 3;

/** Spans loaded across the session's runs, from the prod checks; matches the run page's cap. */
const SESSION_SPAN_BUDGET = 150_000;

/** Kept free for each run in flight: one later page. */
const PAGE_RESERVATION = 10_000;

type RunTraceUnavailableReason = Extract<RunTraceStart, { kind: "unavailable" }>["reason"];

type CutOffLimit = "session" | "run";

type SettledRunLoad =
  | { state: "progressive" }
  | { state: "empty" }
  | { state: "unavailable"; reason: RunTraceUnavailableReason }
  | { state: "logsDeleted" }
  | { state: "error"; message: string }
  /** Stopped at a limit: partway (`started`) or before its first chunk. */
  | { state: "cutOff"; limit: CutOffLimit; started: boolean; spanLimit: number };

/**
 * `loadId` identifies one load attempt from start to finish: a settle for an older attempt is
 * ignored, and the trace source is keyed by it so a new attempt always starts clean.
 */
export type SessionRunLoad =
  | { state: "idle" }
  /** `retryOf`: an in-place retry keeping that attempt's trace source and spans. */
  | { state: "queued"; retryOf?: number }
  | { state: "loading"; loadId: number }
  /** First chunk shown, later pages still loading; keeps its slot. `attempt` changes per retry. */
  | { state: "paging"; loadId: number; attempt: number }
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
  /** Spans on screen per run (below its hidden root). */
  spanCounts: Readonly<Record<string, number>>;
  /** Spans each run's trace holds, on screen or not: what the budget counts. */
  loadedSpans: Readonly<Record<string, number>>;
  /** Collapsed runs, least recently collapsed first: the order they're freed in. */
  collapsedOrder: readonly string[];
  /** The run holding the selected span: never freed. */
  selectedRunId: string | undefined;
  /** The session's newest run, when it's loaded. */
  newestRunId: string | undefined;
  budget: number;
};

export type SessionRunLoadsAction =
  /** The tree expanded or collapsed a run row. */
  | { type: "expanded"; runFriendlyId: string; expanded: boolean }
  /** Expand all: runs in the order they should load, newest first. */
  | { type: "expandedMany"; runFriendlyIds: string[] }
  /** The page opened on a link to this run: it expands and loads ahead of the others. */
  | { type: "deepLinked"; runFriendlyId: string }
  /** The runs page changed: which runs are in the run store, and which is newest. */
  | { type: "runsChanged"; withStatus: string[]; newestRunId: string | undefined }
  /** How many of a run's spans are on screen; 0 when its trace unmounts. */
  | { type: "spanCount"; runFriendlyId: string; count: number }
  /** How many spans a run's trace holds, sent as each chunk merges; 0 when it unmounts. */
  | { type: "spansLoaded"; runFriendlyId: string; loaded: number }
  | { type: "selected"; runFriendlyId: string | undefined }
  | { type: "settle"; runFriendlyId: string; loadId: number; outcome: SessionRunLoadOutcome }
  /** Retry a failed run: in place when some of its spans are on screen, else from the start. */
  | { type: "retry"; runFriendlyId: string }
  /** Frees runs back to idle, cancelling a fetch in flight (its late settle won't match). */
  | { type: "release"; runFriendlyIds: string[] };

/** What to do before a run fetches its next page. */
type PageDecision =
  | { kind: "grant" }
  | { kind: "free"; runFriendlyIds: string[] }
  | { kind: "cutOff" };

const IDLE: SessionRunLoad = { state: "idle" };

function isInFlight(
  load: SessionRunLoad
): load is Extract<SessionRunLoad, { state: "loading" | "paging" }> {
  return load.state === "loading" || load.state === "paging";
}

/** The current load attempt, if the run has one. */
export function runLoadId(load: SessionRunLoad): number | undefined {
  if (load.state === "queued") return load.retryOf;
  return "loadId" in load ? load.loadId : undefined;
}

/** Whether the run's trace source is mounted: collapsing keeps its spans, and so does a failure. */
export function isRunTraceMounted(load: SessionRunLoad): boolean {
  switch (load.state) {
    case "queued":
      return load.retryOf !== undefined;
    case "loading":
    case "paging":
    case "progressive":
    case "empty":
    case "error":
      return true;
    case "cutOff":
      return load.started;
    default:
      return false;
  }
}

/**
 * A run that just became the newest, replacing a known one, opens expanded, unless the user has
 * already expanded or collapsed it. Several new runs at once open only the newest.
 */
function newRunToOpen(
  current: SessionRunLoads,
  newestRunId: string | undefined
): string | undefined {
  const previous = current.newestRunId;
  if (!previous || !newestRunId || previous === newestRunId) return undefined;
  if (current.expanded.has(newestRunId) || current.collapsedOrder.includes(newestRunId)) {
    return undefined;
  }
  return newestRunId;
}

/**
 * Whether a run row opens expanded when it first appears in the tree. Asks the same question as
 * `runsChanged`, so the answer doesn't depend on whether that event has been handled yet.
 */
export function runOpensExpanded(
  loads: SessionRunLoads,
  runFriendlyId: string,
  newestRunId: string | undefined
): boolean {
  return loads.expanded.has(runFriendlyId) || newRunToOpen(loads, newestRunId) === runFriendlyId;
}

/** The starting state, with the run that opens expanded. */
export function createSessionRunLoads(
  expandedRunIds: string[] = [],
  { budget = SESSION_SPAN_BUDGET }: { budget?: number } = {}
): SessionRunLoads {
  return {
    loads: {},
    queue: [],
    nextLoadId: 1,
    expanded: new Set(expandedRunIds),
    withStatus: new Set(),
    spanCounts: {},
    loadedSpans: {},
    collapsedOrder: [],
    selectedRunId: undefined,
    newestRunId: undefined,
    budget,
  };
}

export function runLoad(loads: SessionRunLoads, runFriendlyId: string): SessionRunLoad {
  return loads.loads[runFriendlyId] ?? IDLE;
}

export function runSpanCount(loads: SessionRunLoads, runFriendlyId: string): number {
  return loads.spanCounts[runFriendlyId] ?? 0;
}

function runLoadedSpans(loads: SessionRunLoads, runFriendlyId: string): number {
  return loads.loadedSpans[runFriendlyId] ?? 0;
}

/**
 * Every decision about loading a run's trace lives here:
 * - An expanded run that is in the run store and idle loads, whenever that becomes true.
 * - Expanding a failed run reads it again, but only if none of its spans are on screen.
 * - At most 3 runs load at once; a run holds its slot until all its pages are in. The newest run
 *   starts first when it's queued.
 * - A run that settled with no spans becomes loaded when its first span arrives while tailing.
 * - When a newer run takes over, it expands; the previous newest run keeps its state, and is read
 *   afresh once if it was still empty.
 * - A deep-linked run expands first, so it loads ahead of every run but the newest.
 * - The span budget: a run starts or fetches a page only within it, after freeing the least
 *   recently collapsed runs if that's enough; the newest run is never held back. A run that would
 *   fit with its own page waits while others load, rather than being cut off.
 */
export function sessionRunLoadsReducer(
  current: SessionRunLoads,
  action: SessionRunLoadsAction
): SessionRunLoads {
  switch (action.type) {
    case "expanded": {
      const { runFriendlyId: id } = action;
      if (current.expanded.has(id) === action.expanded) return current;
      if (!action.expanded) {
        const expanded = new Set(current.expanded);
        expanded.delete(id);
        const collapsedOrder = [...current.collapsedOrder.filter((other) => other !== id), id];
        return { ...current, expanded, collapsedOrder };
      }
      return loadWanted(expandRuns(current, [id]));
    }
    case "expandedMany": {
      const ids = action.runFriendlyIds.filter((id) => !current.expanded.has(id));
      if (ids.length === 0) return current;
      return loadWanted(expandRuns(current, ids));
    }
    case "deepLinked": {
      const { runFriendlyId: id } = action;
      const expanded = new Set([id, ...[...current.expanded].filter((other) => other !== id)]);
      const queue = current.queue.includes(id)
        ? [id, ...current.queue.filter((other) => other !== id)]
        : current.queue;
      const collapsedOrder = current.collapsedOrder.filter((other) => other !== id);
      return loadWanted({ ...current, expanded, queue, collapsedOrder });
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
      const opened = newRunToOpen(current, action.newestRunId);
      if (opened) next = { ...next, expanded: new Set([...next.expanded, opened]) };
      return loadWanted(next);
    }
    case "spanCount": {
      const { runFriendlyId: id, count } = action;
      const previous = runSpanCount(current, id);
      if (previous === count) return current;
      const load = runLoad(current, id);
      // A late count from a trace that was just freed.
      if (count > 0 && !isRunTraceMounted(load)) return current;

      const spanCounts = { ...current.spanCounts };
      if (count > 0) spanCounts[id] = count;
      else delete spanCounts[id];
      const loads =
        count > 0 && load.state === "empty"
          ? { ...current.loads, [id]: { state: "progressive" as const, loadId: load.loadId } }
          : current.loads;
      return { ...current, spanCounts, loads };
    }
    case "spansLoaded": {
      const { runFriendlyId: id, loaded } = action;
      const previous = runLoadedSpans(current, id);
      if (previous === loaded) return current;
      // A late count from a trace that was just freed.
      if (loaded > 0 && !isRunTraceMounted(runLoad(current, id))) return current;

      const loadedSpans = { ...current.loadedSpans };
      if (loaded > 0) loadedSpans[id] = loaded;
      else delete loadedSpans[id];
      const next = { ...current, loadedSpans };

      // The newest run's live tail is never held back; its growth frees collapsed runs instead.
      // Unlike a page, freeing helps even when it isn't enough: the tail grows either way.
      if (id !== current.newestRunId || loaded <= previous) return next;
      const over = loadedTotal(next) - next.budget;
      if (over <= 0) return next;
      const freeable = freeableRuns(next);
      return withoutLoads(next, takeUntil(next, freeable, over) ?? freeable);
    }
    case "selected": {
      if (current.selectedRunId === action.runFriendlyId) return current;
      return { ...current, selectedRunId: action.runFriendlyId };
    }
    case "settle": {
      const load = runLoad(current, action.runFriendlyId);
      if (!isInFlight(load) || load.loadId !== action.loadId) return current;

      const next: SessionRunLoad =
        action.outcome.state === "paging"
          ? {
              state: "paging",
              loadId: load.loadId,
              attempt: load.state === "paging" ? load.attempt : 0,
            }
          : { ...action.outcome, loadId: load.loadId };
      return startQueued({ ...current, loads: { ...current.loads, [action.runFriendlyId]: next } });
    }
    case "retry": {
      const { runFriendlyId: id } = action;
      const load = runLoad(current, id);
      if (load.state !== "error") return current;
      if (runSpanCount(current, id) === 0) return loadWanted(expandRuns(current, [id]));
      return startQueued({
        ...current,
        loads: { ...current.loads, [id]: { state: "queued", retryOf: load.loadId } },
        queue: [...current.queue, id],
      });
    }
    case "release": {
      const released = action.runFriendlyIds.filter((id) => id in current.loads);
      if (released.length === 0) return current;
      return loadWanted(withoutLoads(current, released));
    }
  }
}

/**
 * The page check's answer, and the event that carries it out. `loaded` is what the asking run's
 * trace holds right now, which can be ahead of the last count the reducer heard.
 */
export function pageCheck(
  current: SessionRunLoads,
  runFriendlyId: string,
  loaded = 0
): { allowed: boolean; action?: SessionRunLoadsAction } {
  const counted =
    loaded > runLoadedSpans(current, runFriendlyId)
      ? { ...current, loadedSpans: { ...current.loadedSpans, [runFriendlyId]: loaded } }
      : current;
  const decision = pageDecision(counted, runFriendlyId);
  switch (decision.kind) {
    case "grant":
      return { allowed: true };
    case "free":
      return {
        allowed: true,
        action: { type: "release", runFriendlyIds: decision.runFriendlyIds },
      };
    case "cutOff": {
      const load = runLoad(current, runFriendlyId);
      if (!isInFlight(load)) return { allowed: false };
      return {
        allowed: false,
        action: {
          type: "settle",
          runFriendlyId,
          loadId: load.loadId,
          outcome: { state: "cutOff", limit: "session", started: true, spanLimit: current.budget },
        },
      };
    }
  }
}

/**
 * Checked before each later page: within the budget (loaded spans plus a page per run in flight)
 * it goes ahead; past it, the least recently collapsed runs are freed if that's enough, else the
 * run stops. The newest run always goes ahead.
 */
function pageDecision(current: SessionRunLoads, runFriendlyId: string): PageDecision {
  if (runFriendlyId === current.newestRunId) return { kind: "grant" };
  const over = usedBudget(current) - current.budget;
  if (over <= 0) return { kind: "grant" };
  const toFree = takeUntil(current, freeableRuns(current), over);
  return toFree ? { kind: "free", runFriendlyIds: toFree } : { kind: "cutOff" };
}

function expandRuns(current: SessionRunLoads, runFriendlyIds: string[]): SessionRunLoads {
  const expanded = new Set(current.expanded);
  const loads = { ...current.loads };
  const opened = new Set(runFriendlyIds);
  for (const id of runFriendlyIds) {
    expanded.add(id);
    const load = runLoad(current, id);
    // A failed run with nothing on screen, or one that couldn't start, is read again.
    const readAgain =
      (load.state === "error" && runSpanCount(current, id) === 0) ||
      (load.state === "cutOff" && !load.started);
    if (readAgain) delete loads[id];
  }
  const collapsedOrder = current.collapsedOrder.filter((id) => !opened.has(id));
  return { ...current, expanded, loads, collapsedOrder };
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
  if (runFriendlyIds.length === 0) return current;
  const removed = new Set(runFriendlyIds);
  const loads = { ...current.loads };
  const spanCounts = { ...current.spanCounts };
  const loadedSpans = { ...current.loadedSpans };
  for (const id of removed) {
    delete loads[id];
    delete spanCounts[id];
    delete loadedSpans[id];
  }
  return {
    ...current,
    loads,
    spanCounts,
    loadedSpans,
    queue: current.queue.filter((id) => !removed.has(id)),
    collapsedOrder: current.collapsedOrder.filter((id) => !removed.has(id)),
  };
}

function startQueued(current: SessionRunLoads): SessionRunLoads {
  let inFlight = inFlightCount(current);
  if (inFlight >= MAX_CONCURRENT_RUN_LOADS || current.queue.length === 0) return current;

  // The newest run never waits behind older runs: it's the one being watched.
  const newest = current.newestRunId;
  const queue =
    newest && current.queue.includes(newest)
      ? [newest, ...current.queue.filter((id) => id !== newest)]
      : [...current.queue];
  let next: SessionRunLoads = { ...current, loads: { ...current.loads }, queue };
  // Runs that would fit once the others finish stay queued, in order.
  const waiting: string[] = [];
  while (inFlight < MAX_CONCURRENT_RUN_LOADS) {
    const id = next.queue[0];
    if (!id) break;
    next = { ...next, queue: next.queue.slice(1) };
    const queued = runLoad(next, id);

    // An in-place retry keeps its attempt and pages again from its first chunk.
    if (queued.state === "queued" && queued.retryOf !== undefined) {
      next = {
        ...next,
        loads: {
          ...next.loads,
          [id]: { state: "paging", loadId: queued.retryOf, attempt: next.nextLoadId },
        },
        nextLoadId: next.nextLoadId + 1,
      };
      inFlight++;
      continue;
    }

    // Starting reserves a page like any run in flight.
    if (id !== next.newestRunId) {
      const over = loadedTotal(next) + PAGE_RESERVATION * (inFlight + 1) - next.budget;
      // Only over because of the other runs' pages: check again when one of them settles.
      if (over > 0 && inFlight > 0 && loadedTotal(next) + PAGE_RESERVATION <= next.budget) {
        waiting.push(id);
        continue;
      }
      if (over > 0) {
        const toFree = takeUntil(next, freeableRuns(next), over);
        if (!toFree) {
          next = settleAt(next, id, {
            state: "cutOff",
            limit: "session",
            started: false,
            spanLimit: next.budget,
          });
          continue;
        }
        next = withoutLoads(next, toFree);
      }
    }

    next = settleAt(next, id, { state: "loading" });
    inFlight++;
  }
  return waiting.length > 0 ? { ...next, queue: [...waiting, ...next.queue] } : next;
}

function settleAt(
  current: SessionRunLoads,
  runFriendlyId: string,
  load: SettledRunLoad | { state: "loading" }
): SessionRunLoads {
  return {
    ...current,
    loads: { ...current.loads, [runFriendlyId]: { ...load, loadId: current.nextLoadId } },
    nextLoadId: current.nextLoadId + 1,
  };
}

function inFlightCount(current: SessionRunLoads) {
  return Object.values(current.loads).filter(isInFlight).length;
}

function loadedTotal(current: SessionRunLoads) {
  let total = 0;
  for (const count of Object.values(current.loadedSpans)) total += count;
  return total;
}

function usedBudget(current: SessionRunLoads) {
  return loadedTotal(current) + PAGE_RESERVATION * inFlightCount(current);
}

// Collapsed runs holding spans that aren't loading, the newest or holding the selected span.
function freeableRuns(current: SessionRunLoads): string[] {
  return current.collapsedOrder.filter((id) => {
    if (id === current.newestRunId || id === current.selectedRunId) return false;
    if (runLoadedSpans(current, id) === 0) return false;
    const load = runLoad(current, id);
    return isRunTraceMounted(load) && !isInFlight(load) && load.state !== "queued";
  });
}

// The fewest runs from the front whose spans add up to `needed`, or undefined if they can't.
function takeUntil(current: SessionRunLoads, runFriendlyIds: string[], needed: number) {
  const taken: string[] = [];
  let freed = 0;
  for (const id of runFriendlyIds) {
    if (freed >= needed) break;
    taken.push(id);
    freed += runLoadedSpans(current, id);
  }
  return freed >= needed ? taken : undefined;
}

function sameMembers(set: ReadonlySet<string>, items: string[]) {
  return set.size === new Set(items).size && items.every((item) => set.has(item));
}
