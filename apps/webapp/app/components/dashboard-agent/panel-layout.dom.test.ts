// @vitest-environment jsdom
import { motion, type PanInfo } from "framer-motion";
import { createElement, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
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

const POINTER_INIT = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse" };

type Point = { x: number; y: number };

async function dispatchPointer(target: Element, type: string, at: Point) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent(type, { ...POINTER_INIT, clientX: at.x, clientY: at.y }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function pressAndMove(target: Element, steps: Point[]) {
  await dispatchPointer(target, "pointerdown", { x: 0, y: 0 });
  for (const step of steps) {
    await dispatchPointer(target, "pointermove", step);
  }
}

async function release(target: Element, at: Point) {
  await dispatchPointer(target, "pointerup", at);
}

async function gesture(target: Element, steps: Point[]) {
  await pressAndMove(target, steps);
  await release(target, steps[steps.length - 1]!);
}

function panInfo(dx: number, dy: number): PanInfo {
  return {
    delta: { x: dx, y: dy },
    offset: { x: dx, y: dy },
    point: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
  };
}

/** A real dispatched event, so the no-drag filter sees a real `target`. */
function pointerEventOn(target: Element, type: string, at: Point) {
  let captured!: PointerEvent;
  target.addEventListener(type, (event) => (captured = event as PointerEvent), { once: true });
  target.dispatchEvent(new PointerEvent(type, { ...POINTER_INIT, clientX: at.x, clientY: at.y }));
  return captured;
}

describe("initialFloatingRect", () => {
  it("docks bottom-right, sized to FLOATING_WIDTH/HEIGHT, padded by FLOATING_MARGIN", () => {
    expect(initialFloatingRect()).toEqual({
      x: window.innerWidth - FLOATING_WIDTH - FLOATING_MARGIN,
      y: window.innerHeight - FLOATING_HEIGHT - FLOATING_MARGIN,
      w: FLOATING_WIDTH,
      h: FLOATING_HEIGHT,
    });
  });
});

// Mirrors the real header: a title-like element (draggable) beside a
// `data-agent-no-drag` action (opted out), same as DashboardAgentHeader's button group.
function renderFloatingAgentWindow(
  onRequestModeChange?: (mode: DashboardAgentMode) => void,
  mode: DashboardAgentMode = "floating"
) {
  let latestDrag!: FloatingDragProps;
  function Harness({ current }: { current: DashboardAgentMode }) {
    return createElement(
      FloatingAgentWindow,
      { mode: current, onRequestModeChange },
      (drag: FloatingDragProps) => {
        // oxlint-disable-next-line react/globals -- test harness capturing the render-prop's value.
        latestDrag = drag;
        return createElement(
          motion.div,
          { "data-testid": "handle", className: drag.dragHandleClassName, ...drag.dragHandleProps },
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
    root!.render(createElement(Harness, { current: mode }));
  });
  const query = (selector: string) => container!.querySelector<HTMLElement>(selector)!;
  return {
    get dragHandleProps() {
      return latestDrag.dragHandleProps;
    },
    outer: () => container!.firstElementChild as HTMLDivElement,
    outerLeft: () => (container!.firstElementChild as HTMLDivElement).style.left,
    titleEl: () => query('[data-testid="title"]'),
    actionEl: () => query('[data-testid="action"]'),
    // The east edge is the only ew-resize handle pinned to the right.
    eastResizeEl: () => query(".cursor-ew-resize.right-0"),
    setMode(next: DashboardAgentMode) {
      act(() => {
        root!.render(createElement(Harness, { current: next }));
      });
    },
  };
}

describe("the floating window's rect, wired with panel-layout's own constants", () => {
  it("renders at initialFloatingRect's position and size", () => {
    const view = renderFloatingAgentWindow();
    expect(view.outer().style.left).toBe(
      `${window.innerWidth - FLOATING_WIDTH - FLOATING_MARGIN}px`
    );
    expect(view.outer().style.top).toBe(
      `${window.innerHeight - FLOATING_HEIGHT - FLOATING_MARGIN}px`
    );
    expect(view.outer().style.width).toBe(`${FLOATING_WIDTH}px`);
    // Above in-page z-50 chrome (e.g. CodeBlock's copy/expand toolbar); portals still win
    // ties on z-50 since they mount later in the DOM.
    expect(view.outer().className).toContain("z-50");
  });

  it("never shrinks below FLOATING_MIN_SIZE when the east edge is dragged inwards", async () => {
    const view = renderFloatingAgentWindow();

    await gesture(view.eastResizeEl(), [
      { x: -200, y: 0 },
      { x: -600, y: 0 },
    ]);

    expect(view.outer().style.width).toBe(`${FLOATING_MIN_SIZE.w}px`);
  });
});

describe("FloatingAgentWindow's drag-vs-click filter", () => {
  it("drags when a gesture starts on ordinary content, like the header title", async () => {
    const view = renderFloatingAgentWindow();
    const startLeft = view.outerLeft();

    await gesture(view.titleEl(), [{ x: -20, y: 400 }]);

    expect(view.outerLeft()).not.toBe(startLeft);
  });

  it("does not drag when a gesture starts on a data-agent-no-drag element", async () => {
    const view = renderFloatingAgentWindow();
    const startLeft = view.outerLeft();

    await gesture(view.actionEl(), [{ x: -20, y: 400 }]);

    expect(view.outerLeft()).toBe(startLeft);
  });

  // Framer decides when onPanStart lands relative to onPan, so this ordering is pinned by
  // driving the filter's handlers directly with real dispatched events.
  it("does not leak a delta when onPan for a no-drag target lands before its onPanStart", () => {
    const view = renderFloatingAgentWindow();
    const startLeft = view.outerLeft();
    const event = pointerEventOn(view.actionEl(), "pointermove", { x: -20, y: 400 });

    act(() => {
      view.dragHandleProps.onPan!(event, panInfo(-20, 0));
      view.dragHandleProps.onPanStart!(event, panInfo(0, 0));
      view.dragHandleProps.onPan!(event, panInfo(-20, 0));
    });

    expect(view.outerLeft()).toBe(startLeft);
  });
});

describe("FloatingAgentWindow's drag-to-dock zones", () => {
  const rightZonePoint = () => ({ x: window.innerWidth - 5, y: 400 });
  const topZonePoint = () => ({ x: 500, y: 5 });

  it("shows the rightPanel hint while dragging near the right edge", async () => {
    const view = renderFloatingAgentWindow();

    await pressAndMove(view.titleEl(), [{ x: -100, y: 400 }, rightZonePoint()]);

    expect(document.body.textContent).toContain("Dock right");
  });

  it("restores the pre-drag rect and requests rightPanel on release in the right zone", async () => {
    const modes: DashboardAgentMode[] = [];
    const view = renderFloatingAgentWindow((mode) => modes.push(mode));
    const leftBeforeDrag = view.outerLeft();

    await pressAndMove(view.titleEl(), [{ x: -100, y: 400 }]);
    // The drag really did move the rect, so the restore below undoes a real change.
    expect(view.outerLeft()).not.toBe(leftBeforeDrag);
    await dispatchPointer(view.titleEl(), "pointermove", rightZonePoint());

    await release(view.titleEl(), rightZonePoint());

    expect(modes).toEqual(["rightPanel"]);
    expect(view.outerLeft()).toBe(leftBeforeDrag);
    expect(document.body.textContent).not.toContain("Dock right");
  });

  it("shows the fullscreen hint and requests fullscreen on release near the top edge", async () => {
    const modes: DashboardAgentMode[] = [];
    const view = renderFloatingAgentWindow((mode) => modes.push(mode));

    await pressAndMove(view.titleEl(), [{ x: 500, y: 300 }, topZonePoint()]);
    expect(document.body.textContent).toContain("Fullscreen");

    await release(view.titleEl(), topZonePoint());

    expect(modes).toEqual(["fullscreen"]);
  });

  it("does not change mode and updates the rect normally on release outside any zone", async () => {
    const modes: DashboardAgentMode[] = [];
    const view = renderFloatingAgentWindow((mode) => modes.push(mode));
    const startLeft = view.outerLeft();

    await gesture(view.titleEl(), [{ x: -200, y: 400 }]);

    expect(modes).toEqual([]);
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

  // The dock hint is a conditional sibling rendered before the window. `{cond && …}` keeps
  // the slot when false, so the window keeps its position among the children and React
  // never remounts it — a remount here would kill the turn streaming inside the chat.
  it("never remounts the child while a dock hint appears and disappears", async () => {
    let mounts = 0;
    function Marker() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return null;
    }
    function Harness() {
      return createElement(FloatingAgentWindow, { mode: "floating" }, (drag: FloatingDragProps) =>
        createElement(
          motion.div,
          { "data-testid": "handle", ...drag.dragHandleProps },
          createElement("span", { "data-testid": "title" }, "Chat title"),
          createElement(Marker)
        )
      );
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(Harness));
    });
    const title = () => container!.querySelector<HTMLElement>('[data-testid="title"]')!;
    expect(mounts).toBe(1);

    // Into the right dock zone: the hint mounts as a sibling before the window.
    await pressAndMove(title(), [
      { x: -100, y: 400 },
      { x: window.innerWidth - 5, y: 400 },
    ]);
    expect(document.body.textContent).toContain("Dock right");
    expect(mounts).toBe(1);

    // Back out of every zone: the hint unmounts again.
    await dispatchPointer(title(), "pointermove", { x: 400, y: 400 });
    expect(document.body.textContent).not.toContain("Dock right");
    expect(mounts).toBe(1);

    await release(title(), { x: 400, y: 400 });
    expect(mounts).toBe(1);
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

describe("FloatingAgentWindow clears floating geometry when it docks", () => {
  it("leaves no stale position/left/top/width/height after a drag, then switching to rightPanel", async () => {
    const view = renderFloatingAgentWindow();
    await gesture(view.titleEl(), [{ x: -40, y: 400 }]);

    view.setMode("rightPanel");

    const node = view.outer();
    expect(node.style.position).toBe("");
    expect(node.style.left).toBe("");
    expect(node.style.top).toBe("");
    expect(node.style.width).toBe("");
    expect(node.style.height).toBe("");
  });

  it("leaves no stale geometry after a resize, then switching to rightPanel", async () => {
    const view = renderFloatingAgentWindow();
    await gesture(view.eastResizeEl(), [{ x: -60, y: 0 }]);

    view.setMode("rightPanel");

    const node = view.outer();
    expect(node.style.position).toBe("");
    expect(node.style.width).toBe("");
    expect(node.style.height).toBe("");
  });
});

// The header is the drag handle, and it holds real buttons (chat history, the mode
// toggle). A browser fires a click on release even when the pointer travelled, so the
// drag has to swallow it or letting go of a dragged window opens whatever sat underneath.
describe("FloatingAgentWindow's drag-then-click filter", () => {
  function renderHeaderLikeHandle() {
    const clicks: string[] = [];
    const modes: DashboardAgentMode[] = [];
    function Harness() {
      const [mode, setMode] = useState<DashboardAgentMode>("floating");
      // `flushSync` is what React itself does inside a discrete event: the docked handle
      // is on the page before the browser fires the click that follows this pointerup.
      const onRequestModeChange = (next: DashboardAgentMode) => {
        modes.push(next);
        flushSync(() => setMode(next));
      };
      return createElement(
        FloatingAgentWindow,
        { mode, onRequestModeChange },
        (drag: FloatingDragProps) =>
          createElement(
            motion.div,
            { "data-testid": "handle", ...drag.dragHandleProps },
            createElement("span", { "data-testid": "title" }, "Chat title"),
            createElement(
              "button",
              { "data-testid": "history", onClick: () => clicks.push("history") },
              "History"
            ),
            createElement(
              "button",
              {
                "data-agent-no-drag": "",
                "data-testid": "close",
                onClick: () => clicks.push("close"),
              },
              "Close"
            )
          )
      );
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(Harness));
    });
    const query = (selector: string) => container!.querySelector<HTMLElement>(selector)!;
    return {
      clicks,
      modes,
      titleEl: () => query('[data-testid="title"]'),
      historyEl: () => query('[data-testid="history"]'),
      closeEl: () => query('[data-testid="close"]'),
    };
  }

  /**
   * What the browser does on release: the click follows the pointerup in the same task,
   * with no chance for a timer to run in between.
   */
  async function releaseAndClick(target: Element, at: { x: number; y: number }) {
    await act(async () => {
      target.dispatchEvent(
        new PointerEvent("pointerup", { ...POINTER_INIT, clientX: at.x, clientY: at.y })
      );
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  async function clickOn(target: Element) {
    await act(async () => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it("swallows the click that ends a drag, so releasing the window opens nothing", async () => {
    const view = renderHeaderLikeHandle();

    await pressAndMove(view.historyEl(), [{ x: -20, y: 400 }]);
    await releaseAndClick(view.historyEl(), { x: -20, y: 400 });

    expect(view.clicks).toEqual([]);
  });

  it("docks on a zoned drop without letting that release open history", async () => {
    const view = renderHeaderLikeHandle();
    const rightZone = { x: window.innerWidth - 5, y: 400 };

    await pressAndMove(view.historyEl(), [{ x: -100, y: 400 }, rightZone]);
    await releaseAndClick(view.historyEl(), rightZone);

    expect(view.modes).toEqual(["rightPanel"]);
    expect(view.clicks).toEqual([]);
  });

  // The case above cannot tell the two apart: `act` batches the mode change, so the
  // floating handler is still the one on the fiber when the click dispatches. A browser
  // flushes the state update inside the discrete pointerup and dispatches the click
  // against the docked handle instead — which has to carry the swallow as well.
  it("keeps the swallow on the handle in every mode, not just the floating one", () => {
    for (const mode of ["floating", "rightPanel", "fullscreen"] as DashboardAgentMode[]) {
      const view = renderFloatingAgentWindow(undefined, mode);
      expect(typeof view.dragHandleProps.onClickCapture, mode).toBe("function");
      act(() => root!.unmount());
      container!.remove();
      root = undefined;
      container = undefined;
    }
  });

  it("lets a plain click through, so the header's buttons still work", async () => {
    const view = renderHeaderLikeHandle();

    await dispatchPointer(view.historyEl(), "pointerdown", { x: 0, y: 0 });
    await releaseAndClick(view.historyEl(), { x: 0, y: 0 });

    expect(view.clicks).toEqual(["history"]);
  });

  it("leaves a no-drag control clickable even after the pointer travelled on it", async () => {
    const view = renderHeaderLikeHandle();

    await pressAndMove(view.closeEl(), [{ x: -20, y: 400 }]);
    await releaseAndClick(view.closeEl(), { x: -20, y: 400 });

    expect(view.clicks).toEqual(["close"]);
  });

  it("goes back to letting clicks through once the drag is over", async () => {
    const view = renderHeaderLikeHandle();

    await pressAndMove(view.titleEl(), [{ x: -20, y: 400 }]);
    await releaseAndClick(view.historyEl(), { x: -20, y: 400 });
    expect(view.clicks).toEqual([]);

    await clickOn(view.historyEl());

    expect(view.clicks).toEqual(["history"]);
  });
});
