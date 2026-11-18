import type { FlatTree } from "~/components/primitives/TreeView/TreeView";
import { formatNumber } from "~/utils/numberFormatter";
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

export function matchesText(count: number) {
  return `${formatNumber(count)} match${count === 1 ? "" : "es"}`;
}

/** Matching spans in total and per run, hidden runs included, in one pass. */
export function matchesByRun(
  tree: FlatTree<SessionTreeRow<SpanFields>>,
  filter: SessionTraceFilter
): { total: number; byRun: Map<string, number> } {
  const byRun = new Map<string, number>();
  let total = 0;
  for (const node of tree) {
    if (node.data.kind !== "span" || !spanMatches(filter, node.data.span)) continue;
    total++;
    byRun.set(node.data.runFriendlyId, (byRun.get(node.data.runFriendlyId) ?? 0) + 1);
  }
  return { total, byRun };
}

/**
 * What a run row says about the search. Undefined: the row keeps its own load label (can't load,
 * failed, waiting, loading, or stopped before it started), which matters more.
 */
export type RunSearchMark =
  | { kind: "matches"; count: number; soFar: boolean; partly: boolean }
  | { kind: "noMatches" }
  | { kind: "notSearched" };

export function runSearchMark(load: SessionRunLoad, matches: number): RunSearchMark | undefined {
  switch (load.state) {
    case "idle":
      return { kind: "notSearched" };
    case "progressive":
    case "empty":
      return matches > 0
        ? { kind: "matches", count: matches, soFar: false, partly: false }
        : { kind: "noMatches" };
    case "paging":
      return matches > 0
        ? { kind: "matches", count: matches, soFar: true, partly: false }
        : undefined;
    case "cutOff":
      return load.started
        ? { kind: "matches", count: matches, soFar: false, partly: true }
        : undefined;
    default:
      return undefined;
  }
}

export type SearchBarSummary = {
  /** "Searched runs 8–27 · 6 matches", or "Searched 3 of 20 runs (8–27) · 6 matches". */
  text: string;
  /** Earlier runs that aren't shown: runs 1 to the oldest shown run. */
  earlier: { count: number; range: string } | undefined;
  /** Runs inside the shown range that sit behind "not loaded" rows. */
  gaps: { count: number; ranges: string[] } | undefined;
};

function runRange(from: number, to: number) {
  return from === to ? `${from}` : `${from}–${to}`;
}

export function searchBarSummary({
  runs,
  coverage,
  matches,
  tree,
}: {
  runs: Pick<SessionTraceRun, "number" | "friendlyId">[];
  coverage: SearchCoverage;
  matches: number;
  tree: FlatTree<SessionTreeRow<unknown>>;
}): SearchBarSummary {
  const numbers = runs.map((run) => run.number);
  const oldest = Math.min(...numbers);
  const newest = Math.max(...numbers);
  const range = runRange(oldest, newest);
  const numberById = new Map(runs.map((run) => [run.friendlyId, run.number]));
  let gapCount = 0;
  const ranges: string[] = [];
  for (const node of tree) {
    if (node.data.kind !== "notLoaded") continue;
    gapCount += node.data.count;
    const older = numberById.get(node.data.olderRunFriendlyId);
    const newer = numberById.get(node.data.newerRunFriendlyId);
    if (older !== undefined && newer !== undefined) ranges.push(runRange(older + 1, newer - 1));
  }

  const matchText = matchesText(matches);
  const cantLoad = runs.length - coverage.searchable;

  // Runs in gaps weren't searched: then the range only bounds the shown runs ("shown"), so the
  // bar never reads as if every run in it was searched.
  const shown = gapCount > 0 ? "shown " : "";
  let text: string;
  if (coverage.searchable === 0) {
    text = `None of the shown runs can be searched here (${range})`;
  } else if (coverage.searched < coverage.searchable) {
    text = `Searched ${coverage.searched} of ${coverage.searchable} ${shown}runs (${range}) · ${matchText}`;
  } else if (cantLoad > 0) {
    text = `Searched all ${coverage.searchable} ${shown}runs that can load (${range}) · ${matchText}`;
  } else if (gapCount > 0) {
    text = `Searched all ${runs.length} shown runs (${range}) · ${matchText}`;
  } else {
    text = `Searched ${runs.length === 1 ? "run" : "runs"} ${range} · ${matchText}`;
  }

  const earlier = oldest > 1 ? { count: oldest - 1, range: runRange(1, oldest - 1) } : undefined;

  return { text, earlier, gaps: gapCount > 0 ? { count: gapCount, ranges } : undefined };
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
