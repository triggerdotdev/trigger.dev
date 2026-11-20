// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceEvent } from "~/components/runs/v3/trace/types";
import type { SessionTreeRow } from "~/components/sessions/v1/trace/buildSessionTree";
import { SessionTimelineRow } from "~/components/sessions/v1/trace/SessionTimelineRow";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

const spanData = {
  level: "LOG",
  message: "log",
  offset: 0,
  duration: 0,
  isError: false,
  isPartial: false,
  isCancelled: false,
  timelineEvents: [],
  style: {},
} as unknown as TraceEvent["data"];

function renderRow(row: SessionTreeRow<TraceEvent["data"]>, onClick: () => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(SessionTimelineRow, {
        node: { id: "node", level: 1, hasChildren: false, data: row },
        row,
        isSelected: false,
        scale: { durationNs: 1_000_000_000, queuedDurationNs: undefined },
        isLiveRun: false,
        onClick,
      })
    );
  });
}

describe("SessionTimelineRow", () => {
  // Catches: the outer row and the span's own row both handling one click.
  it("calls onClick once for a click on a span's bar", () => {
    let clicks = 0;
    renderRow(
      { kind: "span", runFriendlyId: "run_1", spanId: "s1", span: spanData },
      () => clicks++
    );

    // The innermost element: its click bubbles through every handler in the row.
    const innermost = [...container!.querySelectorAll("*")].at(-1) as HTMLElement;
    act(() => innermost.click());

    expect(clicks).toBe(1);
  });

  it("calls onClick once for a click on a run's bar", () => {
    let clicks = 0;
    renderRow(
      { kind: "run", run: { friendlyId: "run_1", status: "COMPLETED_SUCCESSFULLY" } } as never,
      () => clicks++
    );

    act(() => (container!.firstElementChild as HTMLElement).click());

    expect(clicks).toBe(1);
  });
});
