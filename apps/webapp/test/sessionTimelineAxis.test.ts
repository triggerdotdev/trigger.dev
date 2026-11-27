import { describe, expect, it } from "vitest";
import {
  axisTickCount,
  buildSessionAxis,
  showsWholeSession,
  timelineZoomReducer,
  WHOLE_SESSION,
  windowAround,
  zoomWindow,
  type TimelineZoom,
  type TimelineZoomEvent,
} from "~/components/sessions/v1/trace/sessionTimelineAxis";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 13, 10, 0);
// Run 1 for 12m, a 3h wait, run 2 for 4m, a 5m wait, run 3 for 6m.
const runs = [
  { startMs: T0, endMs: T0 + 12 * MIN },
  { startMs: T0 + 12 * MIN + 3 * HOUR, endMs: T0 + 16 * MIN + 3 * HOUR },
  { startMs: T0 + 21 * MIN + 3 * HOUR, endMs: T0 + 27 * MIN + 3 * HOUR },
];

describe("session timeline axis", () => {
  it("keeps real time, waits included", () => {
    const axis = buildSessionAxis(runs);
    expect(axis.totalMs).toBe(27 * MIN + 3 * HOUR);
    expect(axis.toAxis(runs[1].startMs)).toBe(12 * MIN + 3 * HOUR);
    expect(axis.toReal(axis.toAxis(runs[2].endMs))).toBe(runs[2].endMs);
  });

  // Catches: the axis starting at the first run by number when an older run started earlier.
  it("starts at the earliest run, whatever order the runs come in", () => {
    const axis = buildSessionAxis([runs[2], runs[0], runs[1]]);
    expect(axis.toAxis(T0)).toBe(0);
    expect(axis.totalMs).toBe(27 * MIN + 3 * HOUR);
  });

  it("handles a run that starts before the previous one finished", () => {
    const overlapping = [
      { startMs: T0, endMs: T0 + 10 * MIN },
      { startMs: T0 + 8 * MIN, endMs: T0 + 14 * MIN },
    ];
    const axis = buildSessionAxis(overlapping);
    expect(axis.totalMs).toBe(14 * MIN);
    expect(axis.toAxis(overlapping[1].endMs)).toBe(14 * MIN);
  });

  it("zooms to a run with a little room either side", () => {
    const axis = buildSessionAxis(runs);
    const window = windowAround(axis, runs[1]);
    const start = axis.toAxis(runs[1].startMs);
    const end = axis.toAxis(runs[1].endMs);
    expect(window.startMs).toBeLessThan(start);
    expect(window.endMs).toBeGreaterThan(end);
    expect(window.endMs - window.startMs).toBeLessThan((end - start) * 1.1);
  });

  it("is empty but usable with no runs", () => {
    const axis = buildSessionAxis([]);
    expect(axis.totalMs).toBe(1);
    expect(axis.toAxis(T0)).toBe(0);
  });
});

describe("session timeline zoom", () => {
  const run = (id: string): TimelineZoom => ({ kind: "run", runFriendlyId: id });
  // The tab looks runs up by ID; the same lookup over this file's runs.
  const loaded = new Map([
    ["run_1", runs[0]],
    ["run_2", runs[1]],
    ["run_3", runs[2]],
  ]);
  const extentOf = (id: string) => loaded.get(id);

  const open = (before: string[], after: string[]): TimelineZoomEvent => ({
    type: "openRunsChanged",
    before,
    after,
  });

  it("zooms to a run you open, and to the next one you open", () => {
    const zoomed = timelineZoomReducer(WHOLE_SESSION, open([], ["a"]));
    expect(zoomed).toEqual(run("a"));
    expect(timelineZoomReducer(zoomed, open(["a"], ["a", "b"]))).toEqual(run("b"));
  });

  it("shows the whole session when several runs open at once", () => {
    expect(timelineZoomReducer(run("a"), open(["a"], ["a", "b", "c"]))).toEqual(WHOLE_SESSION);
  });

  it("zooms out when the zoomed run closes, not when another run does", () => {
    expect(timelineZoomReducer(run("a"), open(["a", "b"], ["b"]))).toEqual(WHOLE_SESSION);
    expect(timelineZoomReducer(run("a"), open(["a", "b"], ["a"]))).toEqual(run("a"));
  });

  it("goes back to a run from any zoom when asked to show it", () => {
    const show: TimelineZoomEvent = { type: "showRun", runFriendlyId: "a" };
    const range: TimelineZoom = { kind: "range", startMs: T0, endMs: T0 + MIN };
    expect(timelineZoomReducer(range, show)).toEqual(run("a"));
    expect(timelineZoomReducer(WHOLE_SESSION, show)).toEqual(run("a"));
  });

  it("keeps a dragged range when a run closes", () => {
    const range: TimelineZoom = { kind: "range", startMs: T0, endMs: T0 + MIN };
    expect(timelineZoomReducer(range, open(["a"], []))).toBe(range);
  });

  // Catches: Load earlier moving the axis start shifting a dragged range.
  it("keeps a range on the same real times when earlier runs load", () => {
    const range: TimelineZoom = { kind: "range", startMs: runs[2].startMs, endMs: runs[2].endMs };
    const later = buildSessionAxis(runs.slice(1));
    const all = buildSessionAxis(runs);
    const before = zoomWindow(range, later, extentOf);
    const after = zoomWindow(range, all, extentOf);
    expect(later.toReal(before.startMs)).toBe(all.toReal(after.startMs));
    expect(later.toReal(before.endMs)).toBe(all.toReal(after.endMs));
  });

  it("zooms to a loaded run with a little room either side", () => {
    const axis = buildSessionAxis(runs);
    expect(zoomWindow(run("run_2"), axis, extentOf)).toEqual(windowAround(axis, runs[1]));
  });

  // Catches: a queued run (a point) zooming to a sliver with its marker clipped at the edge.
  it("shows the whole session for a run that hasn't started", () => {
    const axis = buildSessionAxis(runs);
    const point = (id: string) =>
      id === "queued" ? { startMs: runs[2].endMs, endMs: runs[2].endMs } : undefined;
    expect(zoomWindow(run("queued"), axis, point)).toEqual(zoomWindow(WHOLE_SESSION, axis, point));
  });

  // Catches: a sideways scroll on a queued run's overview swapping the run zoom for a fixed range
  // (PR review), and Reset zoom looking active there.
  it("treats a run zoom on a queued or unloaded run as the whole session", () => {
    const point = (id: string) =>
      id === "queued" ? { startMs: runs[2].endMs, endMs: runs[2].endMs } : extentOf(id);
    expect(showsWholeSession(run("queued"), point)).toBe(true);
    expect(showsWholeSession(run("gone"), point)).toBe(true);
    expect(showsWholeSession(run("run_2"), point)).toBe(false);
    expect(showsWholeSession(WHOLE_SESSION, point)).toBe(true);
    expect(showsWholeSession({ kind: "range", startMs: T0, endMs: T0 + MIN }, point)).toBe(false);
  });

  it("shows the whole session for a zoomed run that isn't loaded", () => {
    const axis = buildSessionAxis(runs);
    expect(zoomWindow(run("gone"), axis, extentOf)).toEqual(
      zoomWindow(WHOLE_SESSION, axis, extentOf)
    );
  });

  // Catches: the first two tick labels printed on top of each other in a narrow timeline.
  it("shows fewer ticks when the header is too narrow for five labels", () => {
    expect(axisTickCount(700, true)).toBe(5);
    expect(axisTickCount(320, true)).toBe(3);
    expect(axisTickCount(150, true)).toBe(2);
    expect(axisTickCount(450, false)).toBe(5);
  });

  // Catches: labels at thirds while the rows' gridlines sit at quarters.
  it("only picks counts whose labels land on the quarter gridlines", () => {
    for (let width = 100; width <= 900; width += 10) {
      expect([2, 3, 5]).toContain(axisTickCount(width, false));
      expect([2, 3, 5]).toContain(axisTickCount(width, true));
    }
  });
});
