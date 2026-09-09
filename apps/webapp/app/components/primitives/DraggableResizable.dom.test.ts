// @vitest-environment jsdom
// Real pointer gestures through framer-motion, plus a direct-handler pass that pins the
// onPan-before-onPanStart ordering framer can deliver (draggableResizableMath.test.ts
// only covers the math).
import { motion, type PanInfo } from "framer-motion";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { useDraggableResizable, type UseDraggableResizableOptions } from "./DraggableResizable";

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

async function dragBy(handle: Element, steps: { x: number; y: number }[]) {
  await act(async () => {
    handle.dispatchEvent(
      new PointerEvent("pointerdown", { ...POINTER_INIT, clientX: 0, clientY: 0 })
    );
    for (const step of steps) {
      handle.dispatchEvent(
        new PointerEvent("pointermove", { ...POINTER_INIT, clientX: step.x, clientY: step.y })
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const last = steps[steps.length - 1]!;
    handle.dispatchEvent(
      new PointerEvent("pointerup", { ...POINTER_INIT, clientX: last.x, clientY: last.y })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function panInfo(dx: number, dy: number): PanInfo {
  return {
    delta: { x: dx, y: dy },
    offset: { x: dx, y: dy },
    point: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
  };
}

/** A real dispatched event, so handlers reading `target` or client coordinates see the truth. */
function pointerEventOn(target: Element, type: string, at: { x: number; y: number }) {
  let captured!: PointerEvent;
  target.addEventListener(type, (event) => (captured = event as PointerEvent), { once: true });
  target.dispatchEvent(new PointerEvent(type, { ...POINTER_INIT, clientX: at.x, clientY: at.y }));
  return captured;
}

function renderBox(options: UseDraggableResizableOptions) {
  let handlers!: ReturnType<typeof useDraggableResizable>;
  function Harness() {
    const result = useDraggableResizable(options);
    // oxlint-disable-next-line react/globals -- test harness capturing the hook's return value.
    handlers = result;
    const { style, dragHandleProps, resizeHandleProps } = result;
    return createElement(
      "div",
      { "data-testid": "box", style },
      createElement(motion.div, { "data-testid": "drag", ...dragHandleProps }),
      createElement(motion.div, { "data-testid": "resize-e", ...resizeHandleProps("e") })
    );
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(Harness));
  });
  const query = (testId: string) =>
    container!.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
  return {
    box: () => query("box"),
    drag: () => query("drag"),
    resizeE: () => query("resize-e"),
    get handlers() {
      return handlers;
    },
  };
}

describe("useDraggableResizable driven by real pointer gestures", () => {
  const initial = { x: 100, y: 100, w: 300, h: 200 };
  const minSize = { w: 100, h: 80 };

  it("renders at the initial rect", () => {
    const view = renderBox({ initial, minSize });
    expect(view.box().style.left).toBe("100px");
    expect(view.box().style.top).toBe("100px");
    expect(view.box().style.width).toBe("300px");
  });

  it("drag: the box ends up at initial.x plus the gesture's cumulative delta", async () => {
    const view = renderBox({ initial, minSize });

    await dragBy(view.drag(), [
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ]);

    expect(view.box().style.left).toBe(`${initial.x + 30}px`);
  });

  it("resize: the box ends up at initial.w plus the gesture's cumulative delta", async () => {
    const view = renderBox({ initial, minSize });

    await dragBy(view.resizeE(), [
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ]);

    expect(view.box().style.width).toBe(`${initial.w + 30}px`);
  });

  it("resize: dragging the east edge inwards never shrinks past minSize", async () => {
    const view = renderBox({ initial, minSize });

    await dragBy(view.resizeE(), [
      { x: -200, y: 0 },
      { x: -400, y: 0 },
    ]);

    expect(view.box().style.width).toBe(`${minSize.w}px`);
  });
});

// Framer decides when onPanStart lands relative to onPan, so the ordering itself is
// pinned by driving the returned handlers directly with real dispatched events.
describe("useDraggableResizable when onPan lands before onPanStart", () => {
  const initial = { x: 100, y: 100, w: 300, h: 200 };
  const minSize = { w: 100, h: 80 };

  it("drag: still ends at initial.x plus the cumulative delta", () => {
    const view = renderBox({ initial, minSize });
    const event = pointerEventOn(view.drag(), "pointermove", { x: 10, y: 0 });

    act(() => view.handlers.dragHandleProps.onPan(event, panInfo(10, 0)));
    act(() => view.handlers.dragHandleProps.onPan(event, panInfo(10, 0)));
    act(() => view.handlers.dragHandleProps.onPanStart(event, panInfo(0, 0)));
    act(() => view.handlers.dragHandleProps.onPan(event, panInfo(10, 0)));

    expect(view.box().style.left).toBe(`${initial.x + 30}px`);
  });

  it("resize: still ends at initial.w plus the cumulative delta", () => {
    const view = renderBox({ initial, minSize });
    const event = pointerEventOn(view.resizeE(), "pointermove", { x: 10, y: 0 });
    const east = () => view.handlers.resizeHandleProps("e");

    act(() => east().onPan(event, panInfo(10, 0)));
    act(() => east().onPan(event, panInfo(10, 0)));
    act(() => east().onPanStart(event, panInfo(0, 0)));
    act(() => east().onPan(event, panInfo(10, 0)));

    expect(view.box().style.width).toBe(`${initial.w + 30}px`);
  });
});
