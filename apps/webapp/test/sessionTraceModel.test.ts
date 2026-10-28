import { millisecondsToNanoseconds } from "@trigger.dev/core/v3";
import { describe, expect, it } from "vitest";
import {
  GAP_FOLD_MS,
  buildSessionTree,
  isSelectableRow,
  runNodeId,
  spanNodeId,
  type SessionTreeRow,
} from "~/components/sessions/v1/trace/buildSessionTree";
import {
  MAX_CONCURRENT_RUN_LOADS,
  initialSessionRunLoads,
  runLoad,
  sessionRunLoadsReducer,
  type SessionRunLoads,
  type SessionRunLoadsAction,
} from "~/components/sessions/v1/trace/sessionRunLoads";
import {
  initiallyExpandedRunFriendlyId,
  liveRunFriendlyId,
  runDuration,
  runTimelineScale,
} from "~/components/sessions/v1/trace/sessionRunTiming";
import type {
  SessionTraceRun,
  SessionTraceSpan,
} from "~/components/sessions/v1/trace/sessionTraceTypes";
import {
  resolveSessionPageView,
  runReasonLabel,
} from "~/components/sessions/v1/trace/sessionTraceView";

const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const MINUTE = 60_000;

function run(number: number, overrides: Partial<SessionTraceRun> = {}): SessionTraceRun {
  // Back to back: each run starts a minute after the previous one finished.
  const start = number * 6 * MINUTE;
  return {
    number,
    friendlyId: `run_${number}`,
    reason: "continuation",
    afterCrash: false,
    status: "COMPLETED_SUCCESSFULLY",
    createdAt: iso(start),
    startedAt: iso(start + 1_000),
    finishedAt: iso(start + 5 * MINUTE),
    ...overrides,
  };
}

type SpanData = { message: string };

function span(id: string, level: number, parentId?: string): SessionTraceSpan<SpanData> {
  return { id, parentId, level, data: { message: id } };
}

function kinds(tree: { data: SessionTreeRow<SpanData> }[]) {
  return tree.map((node) => node.data.kind);
}

describe("buildSessionTree", () => {
  it("puts the session first, then runs oldest first, whatever order the pages arrive in", () => {
    const tree = buildSessionTree<SpanData>({
      runs: [run(3), run(2), run(1)],
      totalCount: 3,
      spansByRun: new Map(),
    });

    expect(tree.map((node) => node.id)).toEqual([
      "session",
      runNodeId("run_1"),
      runNodeId("run_2"),
      runNodeId("run_3"),
    ]);
    expect(tree[0]).toMatchObject({ level: 0, data: { kind: "session", runCount: 3 } });
    expect(tree[0]!.children).toEqual(tree.slice(1).map((node) => node.id));
    expect(tree[1]).toMatchObject({ level: 1, parentId: "session", hasChildren: false });
  });

  it("adds a load-earlier row counting the runs before the oldest shown run", () => {
    const tree = buildSessionTree<SpanData>({
      runs: [run(5), run(4)],
      totalCount: 5,
      spansByRun: new Map(),
    });

    expect(tree[1]!.data).toEqual({ kind: "loadEarlier", count: 3 });
  });

  it("has no load-earlier row when the first run is shown", () => {
    const tree = buildSessionTree<SpanData>({
      runs: [run(1)],
      totalCount: 1,
      spansByRun: new Map(),
    });

    expect(kinds(tree)).toEqual(["session", "run"]);
  });

  it("folds a quiet period over 10 minutes between two runs into one gap row", () => {
    const first = run(1, { finishedAt: iso(0) });
    const second = run(2, { createdAt: iso(GAP_FOLD_MS + 1) });
    const tree = buildSessionTree<SpanData>({
      runs: [first, second],
      totalCount: 2,
      spansByRun: new Map(),
    });

    expect(kinds(tree)).toEqual(["session", "run", "gap", "run"]);
    expect(tree[2]!.data).toEqual({ kind: "gap", durationMs: GAP_FOLD_MS + 1 });
  });

  it("adds no gap row for 10 minutes or less, or after a run with no finish time", () => {
    const tree = buildSessionTree<SpanData>({
      runs: [
        run(1, { finishedAt: iso(0) }),
        run(2, { createdAt: iso(GAP_FOLD_MS), finishedAt: null, status: "EXECUTING" }),
        run(3, { createdAt: iso(10 * GAP_FOLD_MS) }),
      ],
      totalCount: 3,
      spansByRun: new Map(),
    });

    expect(kinds(tree)).toEqual(["session", "run", "run", "run"]);
  });

  it("shows a not-loaded row between two pages, with the count from the run numbers", () => {
    const tree = buildSessionTree<SpanData>({
      runs: [run(50), run(49), run(3), run(2)],
      totalCount: 50,
      spansByRun: new Map(),
    });

    expect(kinds(tree)).toEqual([
      "session",
      "loadEarlier",
      "run",
      "run",
      "notLoaded",
      "run",
      "run",
    ]);
    expect(tree[4]!.data).toEqual({
      kind: "notLoaded",
      count: 45,
      olderRunFriendlyId: "run_3",
      newerRunFriendlyId: "run_49",
    });
  });

  it("merges a run that appears in two pages into one row, keeping the later copy", () => {
    const tree = buildSessionTree<SpanData>({
      runs: [run(2, { status: "EXECUTING" }), run(1), run(2, { status: "COMPLETED_SUCCESSFULLY" })],
      totalCount: 2,
      spansByRun: new Map(),
    });

    const runRows = tree.filter((node) => node.data.kind === "run");
    expect(runRows).toHaveLength(2);
    expect(runRows[1]!.data).toMatchObject({ run: { status: "COMPLETED_SUCCESSFULLY" } });
  });

  it("hides the run's root span and nests its spans under the run row, one level deeper", () => {
    const spans = [
      span("root", 0),
      span("attempt", 1, "root"),
      span("llm", 2, "attempt"),
      span("log", 1, "root"),
    ];
    const tree = buildSessionTree<SpanData>({
      runs: [run(1)],
      totalCount: 1,
      spansByRun: new Map([["run_1", spans]]),
    });

    const runNode = tree.find((node) => node.id === runNodeId("run_1"))!;
    expect(runNode.data).toMatchObject({ kind: "run", spansLoaded: true });
    expect(runNode.hasChildren).toBe(true);
    expect(runNode.children).toEqual([spanNodeId("run_1", "attempt"), spanNodeId("run_1", "log")]);

    const spanNodes = tree.filter((node) => node.data.kind === "span");
    expect(spanNodes.map((node) => [node.id, node.parentId, node.level])).toEqual([
      ["run_1:attempt", runNodeId("run_1"), 2],
      ["run_1:llm", "run_1:attempt", 3],
      ["run_1:log", runNodeId("run_1"), 2],
    ]);
    expect(spanNodes[1]!.data).toEqual({
      kind: "span",
      runFriendlyId: "run_1",
      spanId: "llm",
      span: { message: "llm" },
    });
  });

  it("puts spans whose parent isn't loaded yet under the run row", () => {
    const tree = buildSessionTree<SpanData>({
      runs: [run(1)],
      totalCount: 1,
      spansByRun: new Map([["run_1", [span("root", 0), span("orphan", 3, "not-loaded")]]]),
    });

    expect(tree.at(-1)).toMatchObject({ parentId: runNodeId("run_1"), level: 2 });
  });

  it("keeps span ids apart when two runs share a span id", () => {
    const tree = buildSessionTree<SpanData>({
      runs: [run(1), run(2)],
      totalCount: 2,
      spansByRun: new Map([
        ["run_1", [span("root", 0), span("same", 1, "root")]],
        ["run_2", [span("root", 0), span("same", 1, "root")]],
      ]),
    });

    const ids = tree.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("run_1:same");
    expect(ids).toContain("run_2:same");
  });

  it("marks a run with an empty event list as loaded with no children", () => {
    const tree = buildSessionTree<SpanData>({
      runs: [run(1)],
      totalCount: 1,
      spansByRun: new Map([["run_1", []]]),
    });

    expect(tree[1]).toMatchObject({ hasChildren: false, data: { spansLoaded: true } });
  });

  it("only lets session, run and span rows be selected", () => {
    expect(isSelectableRow({ kind: "session", runCount: 1 })).toBe(true);
    expect(isSelectableRow({ kind: "run", run: run(1), spansLoaded: false })).toBe(true);
    expect(isSelectableRow({ kind: "gap", durationMs: 1 })).toBe(false);
    expect(isSelectableRow({ kind: "loadEarlier", count: 1 })).toBe(false);
    expect(
      isSelectableRow({
        kind: "notLoaded",
        count: 1,
        olderRunFriendlyId: "a",
        newerRunFriendlyId: "b",
      })
    ).toBe(false);
  });
});

describe("runDuration", () => {
  it("measures from start to finish", () => {
    expect(runDuration({ startedAt: iso(0), finishedAt: iso(40 * MINUTE) }, T0)).toEqual({
      ms: 40 * MINUTE,
      finished: true,
    });
  });

  it("counts up to now while the run is running", () => {
    expect(runDuration({ startedAt: iso(0), finishedAt: null }, T0 + 5_000)).toEqual({
      ms: 5_000,
      finished: false,
    });
  });

  it("has no duration before the run starts", () => {
    expect(runDuration({ startedAt: null, finishedAt: null }, T0)).toBeUndefined();
  });
});

describe("runTimelineScale", () => {
  it("stretches a long run's scale to its recorded finish when the root span has no duration", () => {
    const scale = runTimelineScale({
      run: { startedAt: iso(0), finishedAt: iso(40 * MINUTE) },
      traceDurationNs: millisecondsToNanoseconds(3 * MINUTE),
      rootStartedAt: iso(0),
      nowMs: T0 + 60 * MINUTE,
    });

    expect(scale).toEqual({
      durationNs: millisecondsToNanoseconds(40 * MINUTE),
      queuedDurationNs: undefined,
    });
  });

  it("keeps the trace's duration when its spans end after the recorded finish", () => {
    const scale = runTimelineScale({
      run: { startedAt: iso(0), finishedAt: iso(1_000) },
      traceDurationNs: millisecondsToNanoseconds(2_000),
      rootStartedAt: iso(0),
      nowMs: T0,
    });

    expect(scale.durationNs).toBe(millisecondsToNanoseconds(2_000));
  });

  it("takes queue time off the scale", () => {
    const scale = runTimelineScale({
      run: { startedAt: iso(30_000), finishedAt: iso(90_000) },
      traceDurationNs: 0,
      rootStartedAt: iso(0),
      nowMs: T0,
    });

    expect(scale).toEqual({
      durationNs: millisecondsToNanoseconds(60_000),
      queuedDurationNs: millisecondsToNanoseconds(30_000),
    });
  });

  it("runs to now for a run that hasn't finished", () => {
    const scale = runTimelineScale({
      run: { startedAt: iso(0), finishedAt: null },
      traceDurationNs: 0,
      rootStartedAt: iso(0),
      nowMs: T0 + 7_000,
    });

    expect(scale.durationNs).toBe(millisecondsToNanoseconds(7_000));
  });

  it("falls back to the trace's duration without a root start time", () => {
    expect(
      runTimelineScale({
        run: { startedAt: null, finishedAt: null },
        traceDurationNs: 123,
        rootStartedAt: undefined,
        nowMs: T0,
      })
    ).toEqual({ durationNs: 123, queuedDurationNs: undefined });
  });
});

describe("live and initially expanded run", () => {
  it("treats the newest run as live while it hasn't reached a final status", () => {
    const runs = [run(1), run(2, { status: "EXECUTING", finishedAt: null })];
    expect(liveRunFriendlyId(runs, 2)).toBe("run_2");
    expect(initiallyExpandedRunFriendlyId(runs, 2)).toBe("run_2");
  });

  it("never treats an older unfinished run as live", () => {
    const runs = [run(1, { status: "WAITING_TO_RESUME", finishedAt: null }), run(2)];
    expect(liveRunFriendlyId(runs, 2)).toBeUndefined();
    expect(initiallyExpandedRunFriendlyId(runs, 2)).toBe("run_2");
  });

  it("treats nothing as live when a newer run exists but isn't loaded", () => {
    const runs = [run(2), run(3, { status: "WAITING_TO_RESUME", finishedAt: null })];
    expect(liveRunFriendlyId(runs, 4)).toBeUndefined();
    expect(initiallyExpandedRunFriendlyId(runs, 4)).toBe("run_3");
  });

  it("isn't live before the newest run is in the run store", () => {
    expect(liveRunFriendlyId([run(1), run(2, { status: null })], 2)).toBeUndefined();
  });

  it("expands nothing in an empty session", () => {
    expect(initiallyExpandedRunFriendlyId([], 0)).toBeUndefined();
  });
});

describe("sessionRunLoadsReducer", () => {
  const apply = (...actions: SessionRunLoadsAction[]) =>
    actions.reduce<SessionRunLoads>(sessionRunLoadsReducer, initialSessionRunLoads);
  const states = (loads: SessionRunLoads, ids: string[]) =>
    ids.map((id) => runLoad(loads, id).state);
  const ids = Array.from({ length: 20 }, (_, i) => `run_${i + 1}`);

  function loadIdOf(loads: SessionRunLoads, id: string) {
    const load = runLoad(loads, id);
    if (load.state !== "loading" && load.state !== "paging") throw new Error(`${id} isn't loading`);
    return load.loadId;
  }

  function settle(
    loads: SessionRunLoads,
    id: string,
    outcome: Extract<SessionRunLoadsAction, { type: "settle" }>["outcome"]
  ) {
    return sessionRunLoadsReducer(loads, {
      type: "settle",
      runFriendlyId: id,
      loadId: loadIdOf(loads, id),
      outcome,
    });
  }

  it("loads at most 3 runs at once and queues the rest in request order", () => {
    const loads = apply({ type: "request", runFriendlyIds: ids });

    expect(states(loads, ids).filter((state) => state === "loading")).toHaveLength(
      MAX_CONCURRENT_RUN_LOADS
    );
    expect(states(loads, ["run_1", "run_2", "run_3", "run_4"])).toEqual([
      "loading",
      "loading",
      "loading",
      "queued",
    ]);
    expect(loads.queue).toEqual(ids.slice(3));
  });

  it("queues a run named twice in one request only once", () => {
    const loads = apply(
      { type: "request", runFriendlyIds: ids.slice(0, 3) },
      { type: "request", runFriendlyIds: ["run_9", "run_9"] }
    );

    expect(loads.queue).toEqual(["run_9"]);
  });

  it("gives every load its own id", () => {
    const loads = apply({ type: "request", runFriendlyIds: ids.slice(0, 3) });

    const loadIds = ids.slice(0, 3).map((id) => loadIdOf(loads, id));
    expect(new Set(loadIds).size).toBe(3);
  });

  it("starts the next queued run when one settles, including after a failure", () => {
    let loads = apply({ type: "request", runFriendlyIds: ids.slice(0, 5) });
    loads = settle(loads, "run_2", { state: "error", message: "boom" });
    loads = settle(loads, "run_1", { state: "progressive" });

    expect(states(loads, ids.slice(0, 5))).toEqual([
      "progressive",
      "error",
      "loading",
      "loading",
      "loading",
    ]);
    expect(loads.queue).toEqual([]);
  });

  it("keeps a run's slot while its later pages load", () => {
    let loads = apply({ type: "request", runFriendlyIds: ids.slice(0, 4) });
    loads = settle(loads, "run_1", { state: "paging" });

    expect(states(loads, ids.slice(0, 4))).toEqual(["paging", "loading", "loading", "queued"]);

    loads = settle(loads, "run_1", { state: "progressive" });
    expect(states(loads, ids.slice(0, 4))).toEqual([
      "progressive",
      "loading",
      "loading",
      "loading",
    ]);
  });

  it("ignores requests for runs that are queued, loading or loaded, without a new state", () => {
    let loads = apply({ type: "request", runFriendlyIds: ["run_1", "run_2", "run_3", "run_4"] });
    loads = settle(loads, "run_1", { state: "progressive" });

    const after = sessionRunLoadsReducer(loads, {
      type: "request",
      runFriendlyIds: ["run_1", "run_2", "run_4"],
    });
    expect(after).toBe(loads);
  });

  it("lets failed and empty runs be requested again", () => {
    let loads = apply({ type: "request", runFriendlyIds: ["run_1", "run_2"] });
    loads = settle(loads, "run_1", { state: "error", message: "boom" });
    loads = settle(loads, "run_2", { state: "empty" });
    loads = sessionRunLoadsReducer(loads, { type: "request", runFriendlyIds: ["run_1", "run_2"] });

    expect(states(loads, ["run_1", "run_2"])).toEqual(["loading", "loading"]);
  });

  it("ignores a settle for a run that isn't loading", () => {
    const before = apply({ type: "request", runFriendlyIds: ids.slice(0, 4) });
    const after = sessionRunLoadsReducer(before, {
      type: "settle",
      runFriendlyId: "run_4",
      loadId: 1,
      outcome: { state: "progressive" },
    });

    expect(after).toBe(before);
  });

  it("puts a settled run back to idle and drops a queued run when released", () => {
    let loads = apply({ type: "request", runFriendlyIds: ids.slice(0, 5) });
    loads = settle(loads, "run_1", { state: "progressive" });
    loads = sessionRunLoadsReducer(loads, {
      type: "release",
      runFriendlyIds: ["run_1", "run_5"],
    });

    expect(states(loads, ids.slice(0, 5))).toEqual([
      "idle",
      "loading",
      "loading",
      "loading",
      "idle",
    ]);
    expect(loads.queue).toEqual([]);
  });

  it("frees the slot of a run released mid-load, so a cancelled fetch can't block the queue", () => {
    let loads = apply({ type: "request", runFriendlyIds: ids.slice(0, 6) });
    loads = settle(loads, "run_3", { state: "paging" });
    loads = sessionRunLoadsReducer(loads, {
      type: "release",
      runFriendlyIds: ["run_1", "run_2", "run_3"],
    });

    expect(states(loads, ids.slice(0, 6))).toEqual([
      "idle",
      "idle",
      "idle",
      "loading",
      "loading",
      "loading",
    ]);
  });

  it("ignores a late settle from a cancelled fetch once the run is loading again", () => {
    let loads = apply({ type: "request", runFriendlyIds: ["run_1"] });
    const staleLoadId = loadIdOf(loads, "run_1");
    loads = sessionRunLoadsReducer(loads, { type: "release", runFriendlyIds: ["run_1"] });
    loads = sessionRunLoadsReducer(loads, { type: "request", runFriendlyIds: ["run_1"] });

    const after = sessionRunLoadsReducer(loads, {
      type: "settle",
      runFriendlyId: "run_1",
      loadId: staleLoadId,
      outcome: { state: "progressive" },
    });

    expect(after).toBe(loads);
    expect(loadIdOf(after, "run_1")).not.toBe(staleLoadId);
  });

  it("returns the same state when releasing runs it doesn't know", () => {
    const loads = apply({ type: "request", runFriendlyIds: ["run_1"] });

    expect(sessionRunLoadsReducer(loads, { type: "release", runFriendlyIds: ["run_9"] })).toBe(
      loads
    );
  });

  it("keeps unavailable and logs-deleted outcomes with their reason", () => {
    let loads = apply({ type: "request", runFriendlyIds: ["run_1", "run_2"] });
    loads = settle(loads, "run_1", { state: "unavailable", reason: "legacyStore" });
    loads = settle(loads, "run_2", { state: "logsDeleted" });

    expect(runLoad(loads, "run_1")).toEqual({ state: "unavailable", reason: "legacyStore" });
    expect(runLoad(loads, "run_2")).toEqual({ state: "logsDeleted" });
  });
});

describe("resolveSessionPageView", () => {
  const resolve = (
    params: { view?: string; raw?: string; channel?: string },
    traceEnabled = true
  ) =>
    resolveSessionPageView({
      view: params.view,
      raw: params.raw,
      channel: params.channel,
      traceEnabled,
    });

  it("opens the Trace tab by default when the feature is on", () => {
    expect(resolve({})).toBe("trace");
  });

  it("always shows the conversation when the feature is off, whatever the URL says", () => {
    expect(resolve({}, false)).toBe("conversation");
    expect(resolve({ view: "trace" }, false)).toBe("conversation");
  });

  it("opens the conversation for existing Raw and channel links", () => {
    expect(resolve({ raw: "1" })).toBe("conversation");
    expect(resolve({ channel: "events" })).toBe("conversation");
  });

  it("follows an explicit view over Raw and channel params", () => {
    expect(resolve({ view: "trace", raw: "1" })).toBe("trace");
    expect(resolve({ view: "conversation" })).toBe("conversation");
  });

  it("ignores an unknown view", () => {
    expect(resolve({ view: "timeline" })).toBe("trace");
  });
});

describe("runReasonLabel", () => {
  it("names the known start reasons", () => {
    expect(runReasonLabel({ reason: "initial", afterCrash: false })).toBe("First run");
    expect(runReasonLabel({ reason: "continuation", afterCrash: false })).toBe(
      "Continued after the previous run ended"
    );
    expect(runReasonLabel({ reason: "upgrade", afterCrash: false })).toBe("Moved to a new version");
    expect(runReasonLabel({ reason: "manual", afterCrash: false })).toBe("Started manually");
  });

  it("says the run restarted after a crash, whatever its stored reason", () => {
    expect(runReasonLabel({ reason: "continuation", afterCrash: true })).toBe(
      "Restarted after the previous run crashed"
    );
  });

  it("shows a custom reason as it was sent", () => {
    expect(runReasonLabel({ reason: "handoff to billing agent", afterCrash: false })).toBe(
      "handoff to billing agent"
    );
  });
});
