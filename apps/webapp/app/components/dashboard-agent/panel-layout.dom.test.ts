// @vitest-environment jsdom
import { createElement } from "react";
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

// Same render-hook pattern as DraggableResizable.dom.test.ts.
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
    return createElement(FloatingAgentWindow, { fullscreen: false }, (drag: FloatingDragProps) => {
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
});
