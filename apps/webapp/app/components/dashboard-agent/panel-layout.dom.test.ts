// @vitest-environment jsdom
import { Panel, PanelGroup, PanelResizer } from "@window-splitter/react";
import { createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// Dock zones read the pointer event's client coordinates, not PanInfo.point (which is page
// coordinates), so drag-to-dock tests build events carrying clientX/clientY.
function fakePointerEventAt(target: PointerEvent["target"], x: number, y: number): PointerEvent {
  return { target, clientX: x, clientY: y } as unknown as PointerEvent;
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
function renderFloatingAgentWindow(onRequestModeChange?: (mode: DashboardAgentMode) => void) {
  let latest!: FloatingDragProps;
  function Harness() {
    return createElement(
      FloatingAgentWindow,
      { mode: "floating", onRequestModeChange },
      (drag: FloatingDragProps) => {
        // oxlint-disable-next-line react/globals -- test harness capturing the render-prop's value.
        latest = drag;
        return createElement(
          "div",
          null,
          createElement("span", { "data-testid": "title" }, "Chat title"),
          createElement("button", { "data-agent-no-drag": "", "data-testid": "action" }, "Close")
        );
      }
    );
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

describe("FloatingAgentWindow's drag-to-dock zones", () => {
  it("shows the rightPanel hint while dragging near the right edge", () => {
    stubViewport(1200, 900);
    const view = renderFloatingAgentWindow();
    const target = view.titleEl() as unknown as PointerEvent["target"];

    act(() => {
      view.dragHandleProps.onPanStart!(fakePointerEventAt(target, 0, 0), fakePanInfo(0, 0));
      view.dragHandleProps.onPan!(fakePointerEventAt(target, 1190, 400), fakePanInfo(-20, 0));
    });

    expect(document.body.textContent).toContain("Dock right");
  });

  it("restores the pre-drag rect and calls onRequestModeChange(rightPanel) on release in the right zone", () => {
    stubViewport(1200, 900);
    const onRequestModeChange = vi.fn();
    const view = renderFloatingAgentWindow(onRequestModeChange);
    const target = view.titleEl() as unknown as PointerEvent["target"];
    const leftBeforeDrag = view.outerLeft();

    act(() => {
      view.dragHandleProps.onPanStart!(fakePointerEventAt(target, 0, 0), fakePanInfo(0, 0));
      view.dragHandleProps.onPan!(fakePointerEventAt(target, 1190, 400), fakePanInfo(-200, 0));
    });
    // The drag really did move the rect, so the restore below undoes a real change.
    expect(view.outerLeft()).not.toBe(leftBeforeDrag);

    act(() => {
      view.dragHandleProps.onPanEnd!(fakePointerEventAt(target, 1190, 400), fakePanInfo(0, 0));
    });

    expect(onRequestModeChange).toHaveBeenCalledTimes(1);
    expect(onRequestModeChange).toHaveBeenCalledWith("rightPanel");
    expect(view.outerLeft()).toBe(leftBeforeDrag);
    expect(document.body.textContent).not.toContain("Dock right");
  });

  it("shows the fullscreen hint and requests fullscreen on release near the top edge", () => {
    stubViewport(1200, 900);
    const onRequestModeChange = vi.fn();
    const view = renderFloatingAgentWindow(onRequestModeChange);
    const target = view.titleEl() as unknown as PointerEvent["target"];

    act(() => {
      view.dragHandleProps.onPanStart!(fakePointerEventAt(target, 0, 0), fakePanInfo(0, 0));
      view.dragHandleProps.onPan!(fakePointerEventAt(target, 500, 5), fakePanInfo(0, -20));
    });
    expect(document.body.textContent).toContain("Fullscreen");

    act(() => {
      view.dragHandleProps.onPanEnd!(fakePointerEventAt(target, 500, 5), fakePanInfo(0, 0));
    });

    expect(onRequestModeChange).toHaveBeenCalledTimes(1);
    expect(onRequestModeChange).toHaveBeenCalledWith("fullscreen");
  });

  it("does not change mode and updates the rect normally on release outside any zone", () => {
    stubViewport(1200, 900);
    const onRequestModeChange = vi.fn();
    const view = renderFloatingAgentWindow(onRequestModeChange);
    const target = view.titleEl() as unknown as PointerEvent["target"];
    const startLeft = view.outerLeft();

    act(() => {
      view.dragHandleProps.onPanStart!(fakePointerEventAt(target, 0, 0), fakePanInfo(0, 0));
      view.dragHandleProps.onPan!(fakePointerEventAt(target, 500, 400), fakePanInfo(-20, 0));
    });
    act(() => {
      view.dragHandleProps.onPanEnd!(fakePointerEventAt(target, 500, 400), fakePanInfo(0, 0));
    });

    expect(onRequestModeChange).not.toHaveBeenCalled();
    expect(view.outerLeft()).not.toBe(startLeft);
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
  it("pins the exact takeover classes, including the flex column that fills the takeover's height", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(FloatingAgentWindow, { mode: "fullscreen" }, () => null));
    });
    const outer = container.firstElementChild as HTMLDivElement;
    expect(outer.className).toBe("absolute inset-0 z-10 flex flex-col bg-background-bright");
    expect(outer.classList.contains("flex")).toBe(true);
    expect(outer.classList.contains("flex-col")).toBe(true);
    expect(outer.getAttribute("style")).toBeNull();
  });
});

// Mirrors DashboardAgent.tsx's grid: a content panel, a handle only in rightPanel mode,
// and an agent panel that's either sized (rightPanel) or truly collapsed (otherwise).
// A leftover fixed-pixel track from a hidden-not-unmounted handle, or from a "0px" panel
// that doesn't actually collapse, pushes the grid past its own container's width.
// The handle is ALWAYS mounted (only its `size` varies) — PanelGroup keys children by
// index after dropping falsy ones (@window-splitter/react's useIndexedChildren), so a
// conditionally-rendered handle shifts the agent panel's key on every mode switch and
// remounts the whole chat subtree beneath it.
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
        createElement(PanelResizer, {
          id: "dashboard-agent-handle",
          size: rightPanel ? "3px" : "0px",
        }),
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

describe("FloatingAgentWindow clears floating geometry when it docks", () => {
  it("leaves no stale position/left/top/width/height after a drag, then switching to rightPanel", () => {
    stubViewport(1200, 900);
    let latest!: FloatingDragProps;
    function Harness({ mode }: { mode: DashboardAgentMode }) {
      return createElement(FloatingAgentWindow, { mode }, (drag: FloatingDragProps) => {
        // oxlint-disable-next-line react/globals -- test harness capturing the render-prop's value.
        latest = drag;
        return null;
      });
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(Harness, { mode: "floating" }));
    });
    act(() => {
      latest.dragHandleProps.onPanStart!(fakeEvent, fakePanInfo(0, 0));
      latest.dragHandleProps.onPan!(fakeEvent, fakePanInfo(-40, -10));
    });

    act(() => {
      root!.render(createElement(Harness, { mode: "rightPanel" }));
    });

    const node = container.firstElementChild as HTMLDivElement;
    expect(node.style.position).toBe("");
    expect(node.style.left).toBe("");
    expect(node.style.top).toBe("");
    expect(node.style.width).toBe("");
    expect(node.style.height).toBe("");
  });

  // Mirrors FloatingAgentWindow's own style ternary directly against the resize path
  // (which changes width/height, not just position — resizeHandleProps isn't exposed
  // through the render prop, so this drives the same underlying hook instead).
  it("leaves no stale geometry after a resize (width/height change), then docking", () => {
    stubViewport(1200, 900);
    let latest!: ReturnType<typeof useDraggableResizable>;
    // Matches FloatingAgentWindow's own fix: an explicit reset object, not `undefined` —
    // a dropped style key isn't guaranteed to clear on every style-application layer.
    const clearedStyle = {
      position: undefined,
      left: undefined,
      top: undefined,
      width: undefined,
      height: undefined,
    };
    function Mirror({ docked }: { docked: boolean }) {
      // oxlint-disable-next-line react/globals -- test harness capturing the hook's return value.
      latest = useDraggableResizable({
        initial: initialFloatingRect(),
        minSize: FLOATING_MIN_SIZE,
        viewportPadding: FLOATING_MARGIN,
      });
      return createElement("div", { style: docked ? clearedStyle : latest.style });
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(Mirror, { docked: false }));
    });
    act(() => latest.resizeHandleProps("e").onPan(fakeEvent, fakePanInfo(60, 0)));

    act(() => {
      root!.render(createElement(Mirror, { docked: true }));
    });

    const node = container.firstElementChild as HTMLDivElement;
    expect(node.style.position).toBe("");
    expect(node.style.width).toBe("");
    expect(node.style.height).toBe("");
  });
});

describe("DashboardAgent's degenerate grid tracks outside rightPanel", () => {
  it("keeps the handle mounted but collapses it and the agent panel to bare 0px tracks", () => {
    const group = renderDashboardAgentGrid(false);
    expect(group.querySelector('[data-splitter-type="handle"]')).not.toBeNull();
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

// Mirrors DashboardAgent.tsx's real PanelGroup/Panel/PanelResizer shape (not the
// FloatingAgentWindow-standalone test above, which never puts a handle between the
// panels and so is blind to the sibling-key-shift bug this pins).
function renderDashboardAgentGridTree(rightPanel: boolean, agentChild: ReactNode) {
  return createElement(
    PanelGroup,
    { orientation: "horizontal" },
    createElement(Panel, { id: "dashboard-content", min: "320px" }),
    createElement(PanelResizer, {
      id: "dashboard-agent-handle",
      size: rightPanel ? "3px" : "0px",
    }),
    createElement(
      Panel,
      {
        id: "dashboard-agent-panel",
        default: "380px",
        min: "320px",
        max: "720px",
        collapsible: true,
        collapsed: !rightPanel,
        collapsedSize: "0px",
      },
      agentChild
    )
  );
}

describe("DashboardAgent's real grid tree never remounts the chat across mode switches", () => {
  it("keeps the agent panel's child mounted across floating/rightPanel/fullscreen transitions", () => {
    let mounts = 0;
    function Marker() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return null;
    }

    // jsdom reports every rect as 0x0; the library divides by the group's measured
    // width when a mode switch changes a panel's size, so it needs a non-zero stand-in.
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 1000, height: 600, x: 0, y: 0, top: 0, left: 0 } as DOMRect);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const sequence: DashboardAgentMode[] = [
      "floating",
      "rightPanel",
      "floating",
      "fullscreen",
      "rightPanel",
    ];
    try {
      for (const mode of sequence) {
        act(() => {
          root!.render(renderDashboardAgentGridTree(mode === "rightPanel", createElement(Marker)));
        });
        expect(mounts).toBe(1);
      }
    } finally {
      rectSpy.mockRestore();
    }
  });
});
