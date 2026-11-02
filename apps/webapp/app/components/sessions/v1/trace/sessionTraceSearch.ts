import type { FlatTree } from "~/components/primitives/TreeView/TreeView";
import type { SessionTreeRow } from "./buildSessionTree";
import { runLoadBlock } from "./sessionRunFallback";
import { runLoad, type SessionRunLoad, type SessionRunLoads } from "./sessionRunLoads";
import type { SessionTraceRun } from "./sessionTraceTypes";
import type { LoadedRuns } from "./useSessionRunPages";

/**
 * `text` is lowercased when it's set, so matching doesn't redo it per row. `hiddenRuns`: runs
 * whose matches the user hid with the run's chevron during this search.
 */
export type SessionTraceFilter = { text: string; errorsOnly: boolean; hiddenRuns: string[] };

export const NO_FILTER: SessionTraceFilter = { text: "", errorsOnly: false, hiddenRuns: [] };

export function isFiltering(filter: SessionTraceFilter) {
  return filter.text !== "" || filter.errorsOnly;
}

type SpanFields = { message: string; isError: boolean };

// The filter value has to stay plain JSON for the tree, so its hidden runs become a Set once.
const hiddenSets = new WeakMap<string[], ReadonlySet<string>>();
function hiddenSet(hiddenRuns: string[]) {
  let set = hiddenSets.get(hiddenRuns);
  if (!set) {
    set = new Set(hiddenRuns);
    hiddenSets.set(hiddenRuns, set);
  }
  return set;
}

function spanMatches(filter: SessionTraceFilter, span: SpanFields) {
  if (filter.errorsOnly && !span.isError) return false;
  return filter.text === "" || span.message.toLowerCase().includes(filter.text);
}

/**
 * During a search a run's chevron is open when its results show: it has spans loaded or on
 * the way, and the user hasn't hidden them. A run that never loaded wasn't searched.
 */
export function runShowsResults(load: SessionRunLoad) {
  switch (load.state) {
    case "idle":
    case "unavailable":
    case "logsDeleted":
      return false;
    case "cutOff":
      return load.started;
    default:
      return true;
  }
}

/**
 * The session row always passes and run rows never do. The tree shows the children of a row that
 * passes, so every run row (and gap, "not loaded", "Load earlier") stays, while a run row
 * passing would show all its top-level spans. Spans pass on their message, like the run page.
 */
export function sessionRowPassesFilter(
  filter: SessionTraceFilter,
  row: SessionTreeRow<SpanFields>
): boolean {
  if (row.kind === "session") return true;
  if (row.kind !== "span") return false;
  if (hiddenSet(filter.hiddenRuns).has(row.runFriendlyId)) return false;
  return spanMatches(filter, row.span);
}

/** Spans that match, hidden runs included, for "N matches". */
export function countMatches(
  tree: FlatTree<SessionTreeRow<SpanFields>>,
  filter: SessionTraceFilter
): number {
  let count = 0;
  for (const node of tree) {
    if (node.data.kind === "span" && spanMatches(filter, node.data.span)) count++;
  }
  return count;
}

export type SearchCoverage = {
  /** Fully loaded runs, plus runs stopped at a limit, partway or before they started. */
  searched: number;
  /** Shown runs that can load here. */
  searchable: number;
  /** Stopped at a limit partway: only their loaded part was searched. */
  partly: number;
  /** Stopped at the span limit before they started: nothing of them was searched. */
  notLoaded: number;
  /** Failed to load: they show Retry on their row. */
  failed: number;
  /** Runs Load all opens, newest first: searchable, not searched and not expanded yet. */
  toLoad: string[];
};

/** "Searching X of Y shown runs": runs that can never load here are left out of both. */
export function searchCoverage({
  runs,
  view,
  loads,
}: {
  runs: SessionTraceRun[];
  view: LoadedRuns["view"];
  loads: SessionRunLoads;
}): SearchCoverage {
  const coverage = { searched: 0, searchable: 0, partly: 0, notLoaded: 0, failed: 0 };
  const toLoad: SessionTraceRun[] = [];
  for (const run of runs) {
    const load = runLoad(loads, run.friendlyId);
    if (runLoadBlock(run, view[run.friendlyId], load)) continue;
    coverage.searchable++;
    if (load.state === "progressive" || load.state === "empty") {
      coverage.searched++;
    } else if (load.state === "cutOff") {
      // Load all can't do more for these, so they count as done, with the reason shown.
      coverage.searched++;
      if (load.started) coverage.partly++;
      else coverage.notLoaded++;
    } else if (load.state === "error") {
      coverage.failed++;
    } else if (!loads.expanded.has(run.friendlyId)) {
      toLoad.push(run);
    }
  }
  toLoad.sort((a, b) => b.number - a.number);
  return { ...coverage, toLoad: toLoad.map((run) => run.friendlyId) };
}

/**
 * Runs to collapse when the search is cleared: the ones Load all opened, minus any the user
 * expanded or collapsed meanwhile, or holding the selection.
 */
export function runsToCollapseOnClear(
  openedForSearch: ReadonlySet<string>,
  keep: ReadonlySet<string>
): string[] {
  return [...openedForSearch].filter((id) => !keep.has(id));
}
