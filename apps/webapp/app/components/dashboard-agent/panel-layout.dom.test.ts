// @vitest-environment jsdom
import { Panel, PanelGroup, PanelResizer } from "@window-splitter/react";
import { createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import type { PanInfo } from "framer-motion";
import { useDraggableResizable } from "~/components/primitives/DraggableResizable";
import {
  FLOATING_HEIGHT,
  FLOATING_MARGIN,
  FLOATING_MIN_SIZE,
  FLOATING_WIDTH,
  FloatingAgentWindow,
  initialFloatingRect,
  type DashboardAgentMode,
  type FloatingDragProps,
} from "./panel-layout";

(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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

function stubViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
}

describe("initialFloatingRect", () => {
  it("docks bottom-right, sized to FLOATING_WIDTH/HEIGHT, padded by FLOATING_MARGIN", () => {
    stubViewport(1200, 900);
    expect(initialFloatingRect()).toEqual({
      x: 1200 - FLOATING_WIDTH - FLOATING_MARGIN,
      y: 900 - FLOATING_HEIGHT - FLOATING_MARGIN,
      w: FLOATING_WIDTH,
      h: FLOATING_HEIGHT,
    });
  });
});

function renderDraggableResizable() {
  let latest!: ReturnType<typeof useDraggableResizable>;
  function Harness() {
    // oxlint-disable-next-line react/globals -- test harness capturing the hook's return value.
    latest = useDraggableResizable({
      initial: initialFloatingRect(),
      minSize: FLOATING_MIN_SIZE,
      viewportPadding: FLOATING_MARGIN,
    });
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(Harness));
  });
  return {
    get current() {
      return latest;
    },
  };
}

const fakeEvent = {} as PointerEvent;
function fakePanInfo(dx: number, dy: number): PanInfo {
  return {
    delta: { x: dx, y: dy },
    offset: { x: dx, y: dy },
    point: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
  };
}

describe("the floating window's rect, wired with panel-layout's own constants", () => {
  it("renders at initialFloatingRect's position and size", () => {
    stubViewport(1200, 900);
    const hook = renderDraggableResizable();
    expect(hook.current.position).toEqual({
      x: 1200 - FLOATING_WIDTH - FLOATING_MARGIN,
      y: 900 - FLOATING_HEIGHT - FLOATING_MARGIN,
    });
    expect(hook.current.size).toEqual({ w: FLOATING_WIDTH, h: FLOATING_HEIGHT });
  });

  it("never shrinks below FLOATING_MIN_SIZE even against a viewport smaller than it", () => {
    stubViewport(300, 300);
    const hook = renderDraggableResizable();
    act(() => hook.current.resizeHandleProps("e").onPan(fakeEvent, fakePanInfo(0, 0)));
    expect(hook.current.size.w).toBe(FLOATING_MIN_SIZE.w);
  });
});

// Mirrors the real header: a title-like element (draggable) beside a
// `data-agent-no-drag` action (opted out), same as DashboardAgentHeader's button group.
function renderFloatingAgentWindow() {
  let latest!: FloatingDragProps;
  function Harness() {
    return createElement(FloatingAgentWindow, { mode: "floating" }, (drag: FloatingDragProps) => {
      // oxlint-disable-next-line react/globals -- test harness capturing the render-prop's value.
      latest = drag;
      return createElement(
        "div",
        null,
        createElement("span", { "data-testid": "title" }, "Chat title"),
        createElement("button", { "data-agent-no-drag": "", "data-testid": "action" }, "Close")
      );
    });
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(Harness));
  });
  return {
    get dragHandleProps() {
      return latest.dragHandleProps;
    },
    outerLeft: () => (container!.firstElementChild as HTMLDivElement).style.left,
    titleEl: () => container!.querySelector<HTMLElement>('[data-testid="title"]')!,
    actionEl: () => container!.querySelector<HTMLElement>('[data-testid="action"]')!,
  };
}

describe("FloatingAgentWindow's drag-vs-click filter", () => {
  it("drags when a gesture starts on ordinary content, like the header title", () => {
    stubViewport(1200, 900);
    const view = renderFloatingAgentWindow();
    const startLeft = view.outerLeft();

    act(() => {
      const target = view.titleEl() as unknown as PointerEvent["target"];
      view.dragHandleProps.onPanStart!({ target } as PointerEvent, fakePanInfo(0, 0));
      view.dragHandleProps.onPan!({ target } as PointerEvent, fakePanInfo(-20, 0));
    });

    expect(view.outerLeft()).not.toBe(startLeft);
  });

  it("does not drag when a gesture starts on a data-agent-no-drag element", () => {
    stubViewport(1200, 900);
    const view = renderFloatingAgentWindow();
    const startLeft = view.outerLeft();

    act(() => {
      const target = view.actionEl() as unknown as PointerEvent["target"];
      view.dragHandleProps.onPanStart!({ target } as PointerEvent, fakePanInfo(0, 0));
      view.dragHandleProps.onPan!({ target } as PointerEvent, fakePanInfo(-20, 0));
    });

    expect(view.outerLeft()).toBe(startLeft);
  });

  it("does not leak a delta when onPan for a no-drag target lands before its onPanStart", () => {
    stubViewport(1200, 900);
    const view = renderFloatingAgentWindow();
    const startLeft = view.outerLeft();

    act(() => {
      const target = view.actionEl() as unknown as PointerEvent["target"];
      // Framer-motion's real ordering: onPan can arrive first.
      view.dragHandleProps.onPan!({ target } as PointerEvent, fakePanInfo(-20, 0));
      view.dragHandleProps.onPanStart!({ target } as PointerEvent, fakePanInfo(0, 0));
      view.dragHandleProps.onPan!({ target } as PointerEvent, fakePanInfo(-20, 0));
    });

    expect(view.outerLeft()).toBe(startLeft);
  });
});

describe("FloatingAgentWindow keeps its child mounted across every mode transition", () => {
  it("never remounts the child across any of the three modes (same tree shape always)", () => {
    let mounts = 0;
    function Marker() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return null;
    }
    function Harness({ mode }: { mode: DashboardAgentMode }) {
      return createElement(FloatingAgentWindow, { mode }, () => createElement(Marker));
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    // Every pairwise transition among the three modes, in both directions.
    const sequence: DashboardAgentMode[] = [
      "floating",
      "rightPanel",
      "floating",
      "fullscreen",
      "rightPanel",
      "fullscreen",
      "floating",
    ];
    for (const mode of sequence) {
      act(() => {
        root!.render(createElement(Harness, { mode }));
      });
      expect(mounts).toBe(1);
    }
  });
});

describe("FloatingAgentWindow's fullscreen geometry", () => {
  it("pins the exact takeover classes from before the mode switcher (8dea45a09)", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(FloatingAgentWindow, { mode: "fullscreen" }, () => null));
    });
    const outer = container.firstElementChild as HTMLDivElement;
    expect(outer.className).toBe("absolute inset-0 z-10 bg-background-bright");
    expect(outer.getAttribute("style")).toBeNull();
  });
});

// Mirrors DashboardAgent.tsx's grid: a content panel, a handle only in rightPanel mode,
// and an agent panel that's either sized (rightPanel) or truly collapsed (otherwise).
// A leftover fixed-pixel track from a hidden-not-unmounted handle, or from a "0px" panel
// that doesn't actually collapse, pushes the grid past its own container's width.
function renderDashboardAgentGrid(rightPanel: boolean) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(
        PanelGroup,
        { orientation: "horizontal" },
        createElement(Panel, { id: "dashboard-content", min: "320px" }),
        rightPanel
          ? createElement(PanelResizer, { id: "dashboard-agent-handle", size: "3px" })
          : null,
        createElement(Panel, {
          id: "dashboard-agent-panel",
          default: "380px",
          min: "320px",
          max: "720px",
          collapsible: true,
          collapsed: !rightPanel,
          collapsedSize: "0px",
        })
      )
    );
  });
  return container.firstElementChild as HTMLElement;
}

describe("DashboardAgent's degenerate grid tracks outside rightPanel", () => {
  it("unmounts the handle and collapses the agent panel to a bare 0px track", () => {
    const group = renderDashboardAgentGrid(false);
    expect(group.querySelector('[data-splitter-type="handle"]')).toBeNull();
    const columns = group.style.gridTemplateColumns;
    expect(columns.endsWith("0px")).toBe(true);
    expect(columns).not.toMatch(/\b3px\b/);
  });

  it("keeps the handle and a real sized track in rightPanel mode", () => {
    const group = renderDashboardAgentGrid(true);
    expect(group.querySelector('[data-splitter-type="handle"]')).not.toBeNull();
    expect(group.style.gridTemplateColumns).toMatch(/\b3px\b/);
  });
});
