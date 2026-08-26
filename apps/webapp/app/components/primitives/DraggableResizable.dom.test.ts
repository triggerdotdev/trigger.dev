// @vitest-environment jsdom
//
// Framer-motion can deliver onPan before onPanStart for the same gesture (its scheduler
// defers onPanStart by a frame); a start-rect-ref implementation would corrupt its
// baseline when the late onPanStart lands. This drives the hook's real handlers to prove
// it survives that ordering, unlike the pure-math tests in draggableResizableMath.test.ts.
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import type { PanInfo } from "framer-motion";
import {
  useDraggableResizable,
  type UseDraggableResizableOptions,
  type UseDraggableResizableResult,
} from "./DraggableResizable";

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

function renderHook(options: UseDraggableResizableOptions) {
  let latest!: UseDraggableResizableResult;
  function Harness() {
    // oxlint-disable-next-line react/globals -- test harness capturing the hook's return value.
    latest = useDraggableResizable(options);
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

// `offset` is populated alongside `delta` (framer-motion always sends both) so a reverted
// offset+baseline implementation runs its real math instead of crashing on `undefined` —
// it must fail on the *value*, not on a missing field.
function fakePanInfo(deltaX: number, offsetX: number): PanInfo {
  return {
    delta: { x: deltaX, y: 0 },
    offset: { x: offsetX, y: 0 },
    point: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
  };
}

const fakeEvent = {} as PointerEvent;

describe("useDraggableResizable — framer's real onPan/onPanStart ordering", () => {
  const initial = { x: 100, y: 100, w: 300, h: 200 };
  const minSize = { w: 100, h: 80 };

  it("drag: two onPan events land before their onPanStart, and the gesture still ends up at initial.x + cumulative delta", () => {
    const hook = renderHook({ initial, minSize });

    act(() => hook.current.dragHandleProps.onPan(fakeEvent, fakePanInfo(10, 10)));
    act(() => hook.current.dragHandleProps.onPan(fakeEvent, fakePanInfo(10, 20)));
    // Late on purpose: framer-motion's onStart is scheduled via its frame queue, onMove isn't.
    act(() => hook.current.dragHandleProps.onPanStart(fakeEvent, fakePanInfo(0, 20)));
    act(() => hook.current.dragHandleProps.onPan(fakeEvent, fakePanInfo(10, 30)));

    expect(hook.current.position.x).toBe(initial.x + 30);
  });

  it("resize: two onPan events land before their onPanStart, and the gesture still ends up at initial.w + cumulative delta", () => {
    const hook = renderHook({ initial, minSize });

    act(() => hook.current.resizeHandleProps("e").onPan(fakeEvent, fakePanInfo(10, 10)));
    act(() => hook.current.resizeHandleProps("e").onPan(fakeEvent, fakePanInfo(10, 20)));
    act(() => hook.current.resizeHandleProps("e").onPanStart(fakeEvent, fakePanInfo(0, 20)));
    act(() => hook.current.resizeHandleProps("e").onPan(fakeEvent, fakePanInfo(10, 30)));

    expect(hook.current.size.w).toBe(initial.w + 30);
  });
});
