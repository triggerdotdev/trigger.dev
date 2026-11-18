import { describe, expect, it } from "vitest";
import type { FlatTree } from "~/components/primitives/TreeView/TreeView";
import type { SessionTreeRow } from "~/components/sessions/v1/trace/buildSessionTree";
import {
  createSessionRunLoads,
  type SessionRunLoad,
  type SessionRunLoads,
} from "~/components/sessions/v1/trace/sessionRunLoads";
import {
  isFiltering,
  matchesByRun,
  NO_FILTER,
  runSearchMark,
  runShowsResults,
  runsToCollapseOnClear,
  searchBarSummary,
  searchCoverage,
  sessionRowPassesFilter,
  type SearchCoverage,
} from "~/components/sessions/v1/trace/sessionTraceSearch";
import type { SessionTraceRun } from "~/components/sessions/v1/trace/sessionTraceTypes";

function run(number: number, overrides: Partial<SessionTraceRun> = {}): SessionTraceRun {
  return {
    number,
    friendlyId: `run_${number}`,
    reason: "continuation",
    afterCrash: false,
    triggeredAt: "2026-10-20T10:00:00.000Z",
    status: "COMPLETED_SUCCESSFULLY",
    createdAt: "2026-10-20T10:00:00.000Z",
    startedAt: "2026-10-20T10:00:01.000Z",
    finishedAt: "2026-10-20T10:05:00.000Z",
    ...overrides,
  };
}

function loadsWith(
  states: Record<string, SessionRunLoad>,
  expanded: string[] = Object.keys(states)
): SessionRunLoads {
  return { ...createSessionRunLoads(expanded), loads: states };
}

type Row = SessionTreeRow<{ message: string; isError: boolean }>;
const spanRow = (message: string, isError = false, runFriendlyId = "run_1"): Row => ({
  kind: "span",
  runFriendlyId,
  spanId: "s1",
  span: { message, isError },
});
const filterOf = (text: string, errorsOnly = false, hiddenRuns: string[] = []) => ({
  text,
  errorsOnly,
  hiddenRuns,
});

describe("sessionRowPassesFilter", () => {
  it("always passes the session row and never a run row or a label row", () => {
    const filter = filterOf("x", true);
    expect(sessionRowPassesFilter(filter, { kind: "session", runCount: 2 } as Row)).toBe(true);
    expect(
      sessionRowPassesFilter(filter, { kind: "run", run: run(1), spansLoaded: true } as Row)
    ).toBe(false);
    expect(sessionRowPassesFilter(filter, { kind: "gap", durationMs: 1 } as Row)).toBe(false);
  });

  it("matches spans on their message, ignoring its case, and on errors", () => {
    expect(sessionRowPassesFilter(filterOf("tool"), spanRow("Tool call"))).toBe(true);
    expect(sessionRowPassesFilter(filterOf("llm"), spanRow("tool call"))).toBe(false);
    expect(sessionRowPassesFilter(filterOf("", true), spanRow("tool call"))).toBe(false);
    expect(sessionRowPassesFilter(filterOf("tool", true), spanRow("tool", true))).toBe(true);
  });

  it("hides the matches of runs hidden during the search", () => {
    const filter = filterOf("tool", false, ["run_2"]);
    expect(sessionRowPassesFilter(filter, spanRow("tool", false, "run_1"))).toBe(true);
    expect(sessionRowPassesFilter(filter, spanRow("tool", false, "run_2"))).toBe(false);
  });

  it("only filters when there's text or errors only is on", () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(isFiltering(filterOf("a"))).toBe(true);
    expect(isFiltering(filterOf("", true))).toBe(true);
  });
});

describe("searchCoverage", () => {
  it("counts loaded and limited runs as searched, failed ones apart, the rest to load", () => {
    const runs = [1, 2, 3, 4, 5, 6, 7].map((n) => run(n));
    const coverage = searchCoverage({
      runs,
      view: {},
      loads: loadsWith(
        {
          run_1: { state: "progressive", loadId: 1 },
          run_2: { state: "empty", loadId: 2 },
          run_3: { state: "cutOff", limit: "session", started: true, spanLimit: 10, loadId: 3 },
          run_4: { state: "cutOff", limit: "session", started: false, spanLimit: 10, loadId: 4 },
          run_5: { state: "paging", loadId: 5, attempt: 0 },
          run_6: { state: "error", message: "boom", loadId: 6 },
        },
        ["run_1", "run_2", "run_3", "run_4", "run_5", "run_6"]
      ),
    });

    expect(coverage).toEqual({
      searched: 4,
      searchable: 7,
      partly: 1,
      notLoaded: 1,
      failed: 1,
      toLoad: ["run_7"],
    });
  });

  it("leaves out runs that can't load here, so Load all can finish", () => {
    const runs = [run(1), run(2), run(3, { status: null }), run(4), run(5)];
    const coverage = searchCoverage({
      runs,
      view: {
        run_1: { unavailable: "logsDeleted", spanId: "a" },
        run_2: { spanId: "b" },
      },
      loads: loadsWith(
        {
          run_4: { state: "unavailable", reason: "legacyStore", loadId: 1 },
          run_5: { state: "logsDeleted", loadId: 2 },
        },
        []
      ),
    });

    expect(coverage).toMatchObject({ searched: 0, searchable: 1, toLoad: ["run_2"] });
  });

  it("lists runs to load newest first, skipping runs already expanded", () => {
    const runs = [run(3), run(1), run(4), run(2)];
    const coverage = searchCoverage({
      runs,
      view: {},
      loads: loadsWith({ run_2: { state: "queued" } }, ["run_2"]),
    });

    expect(coverage.toLoad).toEqual(["run_4", "run_3", "run_1"]);
    expect(coverage.searchable).toBe(4);
  });

  it("never leaves Load all with nothing to do while runs are unsearched and idle", () => {
    // Near the span limit: the runs Load all opened stopped before starting.
    const runs = [1, 2, 3].map((n) => run(n));
    const stopped = { state: "cutOff", limit: "session", started: false, spanLimit: 10 } as const;
    const coverage = searchCoverage({
      runs,
      view: {},
      loads: loadsWith({
        run_1: { state: "progressive", loadId: 1 },
        run_2: { ...stopped, loadId: 2 },
        run_3: { ...stopped, loadId: 3 },
      }),
    });

    expect(coverage).toMatchObject({ searched: 3, searchable: 3, notLoaded: 2, toLoad: [] });
  });
});

describe("runShowsResults", () => {
  it("shows a run's results only once it has spans loaded or on the way", () => {
    const stopped = { state: "cutOff", limit: "session", spanLimit: 10, loadId: 1 } as const;
    expect(runShowsResults({ state: "idle" })).toBe(false);
    expect(runShowsResults({ state: "logsDeleted", loadId: 1 })).toBe(false);
    expect(runShowsResults({ ...stopped, started: false })).toBe(false);
    expect(runShowsResults({ ...stopped, started: true })).toBe(true);
    expect(runShowsResults({ state: "queued" })).toBe(true);
    expect(runShowsResults({ state: "progressive", loadId: 1 })).toBe(true);
  });
});

describe("runsToCollapseOnClear", () => {
  it("collapses the runs Load all opened that the user didn't touch", () => {
    expect(
      runsToCollapseOnClear(new Set(["run_1", "run_2", "run_3"]), new Set(["run_2", "run_9"]))
    ).toEqual(["run_1", "run_3"]);
  });
});

describe("matchesByRun", () => {
  // Catches: per-run counts missing matches in runs hidden during the search.
  it("counts matches per run in one pass, hidden runs included", () => {
    const tree: FlatTree<Row> = [
      { id: "a", level: 1, hasChildren: false, data: spanRow("tool a", false, "run_1") },
      { id: "b", level: 1, hasChildren: false, data: spanRow("tool b", false, "run_1") },
      { id: "c", level: 1, hasChildren: false, data: spanRow("llm c", false, "run_2") },
      { id: "d", level: 1, hasChildren: false, data: spanRow("tool d", false, "run_3") },
    ];
    const { total, byRun } = matchesByRun(tree, filterOf("tool", false, ["run_3"]));
    expect(total).toBe(3);
    expect(byRun.get("run_1")).toBe(2);
    expect(byRun.get("run_2")).toBeUndefined();
    expect(byRun.get("run_3")).toBe(1);
  });
});

describe("runSearchMark", () => {
  // Catches: an unloaded run reading as "no matches" instead of "not searched".
  it("marks a run that never loaded as not searched", () => {
    expect(runSearchMark({ state: "idle" }, 0)).toEqual({ kind: "notSearched" });
  });

  // Catches: a loaded run with no matches not being dimmed, or one with matches being dimmed.
  it("gives a loaded run its match count, or marks it as having none", () => {
    expect(runSearchMark({ state: "progressive", loadId: 1 }, 4)).toMatchObject({
      kind: "matches",
      count: 4,
    });
    expect(runSearchMark({ state: "empty", loadId: 1 }, 0)).toEqual({ kind: "noMatches" });
  });

  // Catches: a still-paging run looking finished, or losing its spinner before any match.
  it("says matches so far while later pages load", () => {
    expect(runSearchMark({ state: "paging", loadId: 1, attempt: 0 }, 2)).toMatchObject({
      soFar: true,
    });
    expect(runSearchMark({ state: "paging", loadId: 1, attempt: 0 }, 0)).toBeUndefined();
  });

  // Catches: a partly loaded run with no matches dimmed as if its search were complete.
  it("marks a partly loaded run as partly searched, even with no matches", () => {
    const partly = {
      state: "cutOff",
      limit: "session",
      started: true,
      spanLimit: 150_000,
      loadId: 1,
    } as const;
    expect(runSearchMark(partly, 0)).toMatchObject({ kind: "matches", partly: true });
  });

  // Catches: search marks hiding Retry, "Waiting to load…" or the span-limit label.
  it("leaves the row's own label for loads that matter more", () => {
    expect(runSearchMark({ state: "queued" }, 0)).toBeUndefined();
    expect(runSearchMark({ state: "loading", loadId: 1 }, 0)).toBeUndefined();
    expect(runSearchMark({ state: "error", message: "x", loadId: 1 }, 0)).toBeUndefined();
    expect(
      runSearchMark(
        { state: "cutOff", limit: "session", started: false, spanLimit: 1, loadId: 1 },
        0
      )
    ).toBeUndefined();
  });
});

describe("searchBarSummary", () => {
  const coverageOf = (overrides: Partial<SearchCoverage>): SearchCoverage => ({
    searched: 0,
    searchable: 0,
    partly: 0,
    notLoaded: 0,
    failed: 0,
    toLoad: [],
    ...overrides,
  });
  const gapTree: FlatTree<SessionTreeRow<unknown>> = [
    {
      id: "notLoaded:run_30",
      level: 1,
      hasChildren: false,
      data: {
        kind: "notLoaded",
        count: 27,
        olderRunFriendlyId: "run_2",
        newerRunFriendlyId: "run_30",
      },
    },
  ];
  const aroundGap = [run(1), run(2), run(30), run(31)];

  // Catches: earlier runs not counted, or counted when run 1 is shown.
  it("counts the earlier runs that aren't loaded", () => {
    const earlier = (runs: SessionTraceRun[]) =>
      searchBarSummary({ runs, coverage: coverageOf({}), matches: 0, tree: [] }).earlier;
    expect(earlier(Array.from({ length: 20 }, (_, i) => run(i + 8)))?.count).toBe(7);
    expect(earlier([run(1), run(2)])).toBeUndefined();
  });

  // Catches: runs in gaps missing from the "not shown" count, or named with the wrong numbers.
  it("counts runs in gaps between shown pages, with their numbers", () => {
    const summary = searchBarSummary({
      runs: aroundGap,
      coverage: coverageOf({ searched: 4, searchable: 4 }),
      matches: 2,
      tree: gapTree,
    });
    expect(summary.gaps).toEqual({ count: 27, ranges: ["3–29"] });
  });

  // Catches: "Searched runs 1–31" (or "… that can load (1–31)") claiming runs in gaps that
  // weren't searched (review rounds 1 and 2, 2026-10-30).
  it("never reads as if the whole range was searched when runs sit in gaps", () => {
    const text = (coverage: SearchCoverage) =>
      searchBarSummary({ runs: aroundGap, coverage, matches: 0, tree: gapTree }).text;
    for (const coverage of [
      coverageOf({ searched: 4, searchable: 4 }),
      coverageOf({ searched: 3, searchable: 3 }),
      coverageOf({ searched: 1, searchable: 4 }),
    ]) {
      expect(text(coverage)).toMatch(/shown runs/);
    }
  });
});
