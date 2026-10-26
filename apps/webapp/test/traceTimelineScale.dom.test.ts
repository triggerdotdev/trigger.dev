// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import * as Timeline from "~/components/primitives/Timeline";
import {
  TraceTimelineRowScale,
  TraceTimelineScaleProvider,
  type TraceTimelineScale,
} from "~/components/runs/v3/trace/timelineScale";
import { SpanTimelineRow } from "~/components/runs/v3/trace/TimelineView";
import type { TraceEvent } from "~/components/runs/v3/trace/types";

const SECOND_NS = 1_000_000_000;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
  }
  container?.remove();
  container = undefined;
  root = undefined;
});

function span(id: string, offsetNs: number, durationNs: number): TraceEvent {
  return {
    id,
    data: {
      level: "TRACE",
      message: id,
      offset: offsetNs,
      duration: durationNs,
      timelineEvents: [],
      isError: false,
      isCancelled: false,
      isPartial: false,
      style: {},
    },
  } as unknown as TraceEvent;
}

function row(node: TraceEvent) {
  return createElement(SpanTimelineRow, {
    node,
    isSelected: false,
    showDuration: true,
    isTopSpan: false,
    disableAnimations: true,
    onClick: () => {},
  });
}

function render(children: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(
        Timeline.Root,
        { durationMs: 100_000, scale: 0, minWidth: 1000, maxWidth: 1000 },
        children
      )
    );
  });
  return container;
}

/** The `left` / `width` of each span bar, as percentages. */
function bars(el: HTMLElement) {
  return Array.from(el.querySelectorAll<HTMLElement>(".timeline-span")).map((bar) => {
    const style = (bar.parentElement as HTMLElement).style;
    return { left: parseFloat(style.left), width: parseFloat(style.width) };
  });
}

const scale = (seconds: number): TraceTimelineScale => ({
  durationNs: seconds * SECOND_NS,
  queuedDurationNs: undefined,
});

describe("SpanTimelineRow scale", () => {
  it("places the same offset differently on two rows with different scales", () => {
    const node = span("a", 2 * SECOND_NS, 1 * SECOND_NS);
    const el = render([
      createElement(TraceTimelineRowScale, { key: "short", scale: scale(4) }, row(node)),
      createElement(TraceTimelineRowScale, { key: "long", scale: scale(40) }, row(node)),
    ]);

    const [short, long] = bars(el);
    // 2s of a 4s run (shown as 4.2s with headroom) vs 2s of a 40s run (42s)
    expect(short.left).toBeCloseTo((2 / 4.2) * 100, 3);
    expect(long.left).toBeCloseTo((2 / 42) * 100, 3);
    expect(short.width).toBeCloseTo((1 / 4.2) * 100, 3);
    expect(long.width).toBeCloseTo((1 / 42) * 100, 3);
  });

  it("uses the surrounding Timeline.Root range under a plain provider", () => {
    const el = render(
      createElement(
        TraceTimelineScaleProvider,
        { scale: scale(100) },
        row(span("b", 10 * SECOND_NS, 5 * SECOND_NS))
      )
    );

    const [bar] = bars(el);
    expect(bar.left).toBeCloseTo(10, 3);
    expect(bar.width).toBeCloseTo(5, 3);
  });

  it("keeps bars finite on a run with no duration yet", () => {
    const el = render(
      createElement(TraceTimelineRowScale, { scale: scale(0) }, row(span("d", 0, 0)))
    );

    const [bar] = bars(el);
    expect(Number.isFinite(bar.left)).toBe(true);
    expect(Number.isFinite(bar.width)).toBe(true);
  });

  it("clamps an in-progress span to its own run's duration", () => {
    const running = { ...span("c", 1 * SECOND_NS, 0) };
    const el = render(
      createElement(TraceTimelineRowScale, { scale: scale(3) }, row(running as TraceEvent))
    );

    const [bar] = bars(el);
    // runs from 1s to the run's 3s end
    expect(bar.left).toBeCloseTo((1 / 3.15) * 100, 3);
    expect(bar.width).toBeCloseTo((2 / 3.15) * 100, 3);
  });
});
