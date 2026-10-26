// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { SpanTreeRow } from "~/components/runs/v3/trace/TasksTreeView";
import type { TraceEvent } from "~/components/runs/v3/trace/types";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

const leaf = {
  id: "run-row",
  level: 1,
  hasChildren: false,
  data: {
    level: "TRACE",
    message: "Run 19",
    isError: false,
    isCancelled: false,
    isPartial: false,
    isRoot: false,
    style: {},
    properties: {},
  },
} as unknown as TraceEvent;

function render(canExpand: boolean, onChevronClick: () => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(SpanTreeRow, {
        node: leaf,
        isSelected: false,
        isExpanded: false,
        canExpand,
        showRootBadge: false,
        onChevronClick,
      })
    );
  });
  return container.querySelector("button")!;
}

describe("SpanTreeRow", () => {
  it("offers expand on a row with no loaded children when it can expand", () => {
    let clicks = 0;
    const button = render(true, () => clicks++);

    expect(button.getAttribute("aria-label")).toBe("Expand task");
    act(() => button.click());
    expect(clicks).toBe(1);
  });

  it("shows no chevron for a row that can't expand", () => {
    const button = render(false, () => {});

    expect(button.getAttribute("aria-label")).toBe("Select task");
    expect(button.querySelector("svg")).toBeNull();
  });
});
