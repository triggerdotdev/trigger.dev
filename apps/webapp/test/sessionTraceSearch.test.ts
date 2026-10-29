import { describe, expect, it } from "vitest";
import type { FlatTree } from "~/components/primitives/TreeView/TreeView";
import type { SessionTreeRow } from "~/components/sessions/v1/trace/buildSessionTree";
import {
  createSessionRunLoads,
  type SessionRunLoad,
  type SessionRunLoads,
} from "~/components/sessions/v1/trace/sessionRunLoads";
import {
  countMatches,
  isFiltering,
  NO_FILTER,
  runShowsResults,
  runsToCollapseOnClear,
  searchCoverage,
  sessionRowPassesFilter,
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

describe("countMatches", () => {
  it("counts matching spans, hidden runs included", () => {
    const tree: FlatTree<Row> = [
      { id: "session", level: 0, hasChildren: true, data: { kind: "session", runCount: 2 } as Row },
      { id: "a", level: 1, hasChildren: false, data: spanRow("tool a", false, "run_1") },
      { id: "b", level: 1, hasChildren: false, data: spanRow("llm b", false, "run_1") },
      { id: "c", level: 1, hasChildren: false, data: spanRow("tool c", false, "run_2") },
    ];
    expect(countMatches(tree, filterOf("tool", false, ["run_2"]))).toBe(2);
    expect(countMatches(tree, filterOf("zzz"))).toBe(0);
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
