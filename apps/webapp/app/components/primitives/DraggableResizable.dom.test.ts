// @vitest-environment jsdom
//
// Drives the hook's own handlers in framer-motion's *real* callback order, not the
// pure math functions: framer-motion defers onPanStart/onPanEnd by a frame (its internal
// scheduler) while onPan fires synchronously, so a real gesture can deliver one or more
// onPan events before the onPanStart for that same gesture lands. A startRectRef-based
// implementation resets its baseline to the *already-moved* rect when the late onPanStart
// finally fires, corrupting every subsequent onPan in the gesture. This file proves the
// hook survives that ordering; draggableResizableMath.test.ts's pure-function tests can't,
// since they call the (already-fixed) math directly and have no callback ordering to get
// wrong.
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
