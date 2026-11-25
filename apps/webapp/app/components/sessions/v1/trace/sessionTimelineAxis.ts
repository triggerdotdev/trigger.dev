export type RunInterval = { startMs: number; endMs: number };

/** The session's runs on one time axis. Axis ms start at 0 at the oldest run. */
export type SessionAxis = {
  totalMs: number;
  toAxis: (realMs: number) => number;
  toReal: (axisMs: number) => number;
};

/** Real time for the whole session, from the first run's start to the last run's end. */
export function buildSessionAxis(runs: RunInterval[]): SessionAxis {
  if (runs.length === 0) return { totalMs: 1, toAxis: () => 0, toReal: () => 0 };
  const originMs = Math.min(...runs.map((run) => run.startMs));
  const endMs = Math.max(...runs.map((run) => Math.max(run.startMs, run.endMs)));
  const totalMs = Math.max(endMs - originMs, 1);
  return {
    totalMs,
    toAxis: (realMs) => Math.min(Math.max(realMs - originMs, 0), totalMs),
    toReal: (axisMs) => originMs + Math.min(Math.max(axisMs, 0), totalMs),
  };
}

/** The part of the axis the timeline shows: the whole session, or a zoomed-in range. */
export type AxisWindow = { startMs: number; endMs: number };

/** A run's range on the axis with a little room either side, so its bar doesn't touch the edges. */
export function windowAround(axis: SessionAxis, run: RunInterval): AxisWindow {
  const startMs = axis.toAxis(run.startMs);
  const endMs = axis.toAxis(Math.max(run.startMs, run.endMs));
  const pad = Math.max((endMs - startMs) * 0.02, 1);
  return { startMs: Math.max(0, startMs - pad), endMs: Math.min(axis.totalMs, endMs + pad) };
}

/** What the timeline shows: the whole session, the run you opened, or a dragged range. */
export type TimelineZoom =
  | { kind: "whole" }
  | { kind: "run"; runFriendlyId: string }
  /** In epoch ms, so loading earlier runs (which moves the axis origin) keeps the same times. */
  | { kind: "range"; startMs: number; endMs: number };

export type TimelineZoomEvent =
  /** The open runs, read from the tree, so a click, an arrow key and a deep link do the same. */
  | { type: "openRunsChanged"; before: string[]; after: string[] }
  /** "View live run" / "Live run": back to that run, whatever the zoom was. */
  | { type: "showRun"; runFriendlyId: string }
  /** A drag or a sideways scroll, in epoch ms. */
  | { type: "range"; startMs: number; endMs: number }
  | { type: "reset" };

export const WHOLE_SESSION: TimelineZoom = { kind: "whole" };

/**
 * Every zoom rule. Opening one run zooms to it; opening several at once (Load all) shows the
 * whole session; closing the zoomed run zooms back out. Selecting a row never changes the zoom;
 * Reset zoom does.
 */
export function timelineZoomReducer(zoom: TimelineZoom, event: TimelineZoomEvent): TimelineZoom {
  switch (event.type) {
    case "openRunsChanged": {
      const before = new Set(event.before);
      const opened = event.after.filter((id) => !before.has(id));
      if (opened.length === 1) return { kind: "run", runFriendlyId: opened[0] };
      if (opened.length > 1) return WHOLE_SESSION;
      if (zoom.kind === "run" && !event.after.includes(zoom.runFriendlyId)) return WHOLE_SESSION;
      return zoom;
    }
    case "showRun":
      return { kind: "run", runFriendlyId: event.runFriendlyId };
    case "range":
      return { kind: "range", startMs: event.startMs, endMs: event.endMs };
    case "reset":
      return WHOLE_SESSION;
  }
}

/** The zoomed-out view ends 2% after the session, so a mark at the last moment stays visible. */
const AXIS_END_PAD = 1.02;

/** Keeps a dragged or panned range inside the session, at its length. */
export function clampWindow(range: AxisWindow, axis: SessionAxis): AxisWindow {
  // Up to the zoomed-out view's padded end, so a drag ending in that gutter isn't shifted.
  const endMs = axis.totalMs * AXIS_END_PAD;
  const length = Math.min(range.endMs - range.startMs, endMs);
  const startMs = Math.min(Math.max(0, range.startMs), endMs - length);
  return { startMs, endMs: startMs + length };
}

/** `runExtent` is undefined for a run that isn't loaded. */
type RunExtent = (runFriendlyId: string) => RunInterval | undefined;

/**
 * Whether a zoom shows the whole session: no zoom, or a run that isn't loaded or hasn't started
 * (a point; zooming to it would leave nothing to see). The run zoom is kept, so the view follows
 * the run once it has a length; panning and Reset zoom treat it as the whole session meanwhile.
 */
export function showsWholeSession(zoom: TimelineZoom, runExtent: RunExtent): boolean {
  if (zoom.kind !== "run") return zoom.kind === "whole";
  const extent = runExtent(zoom.runFriendlyId);
  return !extent || extent.endMs <= extent.startMs;
}

/** The part of the axis a zoom shows. */
export function zoomWindow(
  zoom: TimelineZoom,
  axis: SessionAxis,
  runExtent: RunExtent
): AxisWindow {
  if (zoom.kind === "range") {
    const originMs = axis.toReal(0);
    return clampWindow({ startMs: zoom.startMs - originMs, endMs: zoom.endMs - originMs }, axis);
  }
  if (zoom.kind === "run" && !showsWholeSession(zoom, runExtent)) {
    const extent = runExtent(zoom.runFriendlyId);
    if (extent) return windowAround(axis, extent);
  }
  // A little room at the end, like a zoomed run gets, so a mark at the last moment shows.
  return { startMs: 0, endMs: axis.totalMs * AXIS_END_PAD };
}
