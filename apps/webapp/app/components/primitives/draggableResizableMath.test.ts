import { describe, expect, it } from "vitest";
import {
  applyDragDelta,
  applyResizeDelta,
  clamp,
  clampPosition,
  clampRectToViewport,
  clampSize,
  resizeRect,
  type Rect,
} from "./draggableResizableMath";

describe("clamp", () => {
  it("clamps to the bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe("clampSize", () => {
  it("enforces the min size", () => {
    expect(clampSize({ w: 10, h: 10 }, { w: 100, h: 50 })).toEqual({ w: 100, h: 50 });
  });

  it("enforces the max size when given", () => {
    expect(clampSize({ w: 1000, h: 1000 }, { w: 100, h: 50 }, { w: 400, h: 300 })).toEqual({
      w: 400,
      h: 300,
    });
  });

  it("is a no-op within bounds", () => {
    expect(clampSize({ w: 200, h: 150 }, { w: 100, h: 50 }, { w: 400, h: 300 })).toEqual({
      w: 200,
      h: 150,
    });
  });
});

describe("clampPosition", () => {
  const viewport = { width: 1000, height: 800 };

  it("keeps a rect fully within the padded viewport", () => {
    expect(clampPosition({ x: -50, y: -50 }, { w: 300, h: 200 }, viewport, 10)).toEqual({
      x: 10,
      y: 10,
    });
    expect(clampPosition({ x: 5000, y: 5000 }, { w: 300, h: 200 }, viewport, 10)).toEqual({
      x: 690,
      y: 590,
    });
  });

  it("is a no-op when already inside bounds", () => {
    expect(clampPosition({ x: 100, y: 100 }, { w: 300, h: 200 }, viewport, 10)).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("falls back to padding when the box is larger than the viewport", () => {
    expect(clampPosition({ x: 100, y: 100 }, { w: 2000, h: 2000 }, viewport, 10)).toEqual({
      x: 10,
      y: 10,
    });
  });
});

describe("clampRectToViewport", () => {
  it("clamps position while leaving size untouched", () => {
    expect(
      clampRectToViewport({ x: -100, y: 50, w: 300, h: 200 }, { width: 1000, height: 800 }, 10)
    ).toEqual({ x: 10, y: 50, w: 300, h: 200 });
  });
});

describe("resizeRect", () => {
  const start = { x: 100, y: 100, w: 300, h: 200 };
  const minSize = { w: 100, h: 80 };
  // Generous viewport so it never becomes the binding constraint for `start`-based cases.
  const viewport = { width: 1000, height: 800 };
  const padding = 10;

  it("east edge grows width, keeps x/y", () => {
    expect(resizeRect("e", start, 50, 0, minSize, undefined, viewport, padding)).toEqual({
      x: 100,
      y: 100,
      w: 350,
      h: 200,
    });
  });

  it("south edge grows height, keeps x/y", () => {
    expect(resizeRect("s", start, 0, 40, minSize, undefined, viewport, padding)).toEqual({
      x: 100,
      y: 100,
      w: 300,
      h: 240,
    });
  });

  it("west edge shrinks width and moves x to keep the right edge fixed", () => {
    expect(resizeRect("w", start, 50, 0, minSize, undefined, viewport, padding)).toEqual({
      x: 150,
      y: 100,
      w: 250,
      h: 200,
    });
  });

  it("north edge shrinks height and moves y to keep the bottom edge fixed", () => {
    expect(resizeRect("n", start, 0, 30, minSize, undefined, viewport, padding)).toEqual({
      x: 100,
      y: 130,
      w: 300,
      h: 170,
    });
  });

  it("corner edges combine both axes", () => {
    expect(resizeRect("nw", start, 20, 20, minSize, undefined, viewport, padding)).toEqual({
      x: 120,
      y: 120,
      w: 280,
      h: 180,
    });
    expect(resizeRect("se", start, -20, -20, minSize, undefined, viewport, padding)).toEqual({
      x: 100,
      y: 100,
      w: 280,
      h: 180,
    });
  });

  it("respects min size when shrinking past it", () => {
    expect(resizeRect("e", start, -1000, 0, minSize, undefined, viewport, padding)).toEqual({
      x: 100,
      y: 100,
      w: 100,
      h: 200,
    });
    // west edge: width clamps to min, x stops moving with it
    expect(resizeRect("w", start, 1000, 0, minSize, undefined, viewport, padding)).toEqual({
      x: 300,
      y: 100,
      w: 100,
      h: 200,
    });
  });

  it("respects max size when growing past it", () => {
    const maxSize = { w: 400, h: 300 };
    expect(resizeRect("se", start, 1000, 1000, minSize, maxSize, viewport, padding)).toEqual({
      x: 100,
      y: 100,
      w: 400,
      h: 300,
    });
  });

  it("caps west-edge growth at maxSize.w and keeps the right edge fixed", () => {
    const maxSize = { w: 250, h: 300 };
    const result = resizeRect("w", start, -1000, 0, minSize, maxSize, viewport, padding);
    expect(result).toEqual({ x: 150, y: 100, w: 250, h: 200 });
    expect(result.x + result.w).toBe(start.x + start.w);
  });

  it("caps north-edge growth at maxSize.h and keeps the bottom edge fixed", () => {
    const maxSize = { w: 400, h: 150 };
    const result = resizeRect("n", start, 0, -1000, minSize, maxSize, viewport, padding);
    expect(result).toEqual({ x: 100, y: 150, w: 300, h: 150 });
    expect(result.y + result.h).toBe(start.y + start.h);
  });

  it("caps west-edge growth at the viewport padding and keeps the right edge fixed", () => {
    const nearLeftEdge = { x: 20, y: 100, w: 300, h: 200 };
    const result = resizeRect("w", nearLeftEdge, -10000, 0, minSize, undefined, viewport, padding);
    expect(result.x).toBe(padding);
    expect(result.x + result.w).toBe(nearLeftEdge.x + nearLeftEdge.w);
  });

  it("caps north-edge growth at the viewport padding and keeps the bottom edge fixed", () => {
    const nearTopEdge = { x: 100, y: 15, w: 300, h: 200 };
    const result = resizeRect("n", nearTopEdge, 0, -10000, minSize, undefined, viewport, padding);
    expect(result.y).toBe(padding);
    expect(result.y + result.h).toBe(nearTopEdge.y + nearTopEdge.h);
  });

  it("caps east-edge growth at the viewport padding", () => {
    const nearRightEdge = { x: 850, y: 100, w: 300, h: 200 };
    const result = resizeRect("e", nearRightEdge, 10000, 0, minSize, undefined, viewport, padding);
    expect(result.x).toBe(nearRightEdge.x);
    expect(result.x + result.w).toBe(viewport.width - padding);
  });
});

describe("resizeRect — minSize wins over a viewport-derived cap smaller than it", () => {
  const minSize = { w: 320, h: 360 };

  it("east: a narrow viewport still floors width at minSize.w", () => {
    const start = { x: 100, y: 50, w: 300, h: 400 };
    const viewport = { width: 350, height: 800 };
    expect(resizeRect("e", start, 1000, 0, minSize, undefined, viewport, 16).w).toBe(320);
  });

  it("south: a short viewport still floors height at minSize.h", () => {
    const start = { x: 50, y: 100, w: 400, h: 300 };
    const viewport = { width: 800, height: 400 };
    expect(resizeRect("s", start, 0, 1000, minSize, undefined, viewport, 16).h).toBe(360);
  });

  it("west: a small fixed right edge still floors width at minSize.w", () => {
    const start = { x: 10, y: 50, w: 50, h: 400 };
    const viewport = { width: 1000, height: 800 };
    expect(resizeRect("w", start, -1000, 0, minSize, undefined, viewport, 16).w).toBe(320);
  });

  it("north: a small fixed bottom edge still floors height at minSize.h", () => {
    const start = { x: 50, y: 10, w: 400, h: 50 };
    const viewport = { width: 1000, height: 800 };
    expect(resizeRect("n", start, 0, -1000, minSize, undefined, viewport, 16).h).toBe(360);
  });
});

// onPan can arrive before onPanStart, so these prove the delta-folding approach has no
// baseline to go stale across back-to-back gestures.
describe("applyResizeDelta / applyDragDelta — gesture sequencing", () => {
  const start: Rect = { x: 100, y: 100, w: 300, h: 200 };
  const minSize = { w: 100, h: 80 };
  const viewport = { width: 1000, height: 800 };
  const padding = 10;

  it("symptom 1: a second resize gesture on the same edge continues from the first gesture's end, with no reset between them", () => {
    let rect = start;
    // Gesture A: five 4px steps east (total +20).
    for (let i = 0; i < 5; i++) {
      rect = applyResizeDelta("e", rect, { x: 4, y: 0 }, minSize, undefined, viewport, padding);
    }
    expect(rect.w).toBe(320);

    // Gesture B starts immediately — no onPanStart-equivalent call, matching framer's
    // deferred-onPanStart timing where the first onPan of a new gesture can land first.
    for (let i = 0; i < 3; i++) {
      rect = applyResizeDelta("e", rect, { x: 10, y: 0 }, minSize, undefined, viewport, padding);
    }
    // Continues from gesture A's end (320), not from a stale baseline (e.g. back to 300).
    expect(rect.w).toBe(350);
  });

  it("symptom 2: a drag gesture right after a resize gesture continues from the resized rect, not a stale one", () => {
    let rect = applyResizeDelta(
      "se",
      start,
      { x: 50, y: 30 },
      minSize,
      undefined,
      viewport,
      padding
    );
    expect(rect).toEqual({ x: 100, y: 100, w: 350, h: 230 });

    // Drag starts immediately after, no reset — same race window as symptom 2.
    rect = applyDragDelta(rect, { x: 20, y: 5 }, viewport, padding);
    expect(rect).toEqual({ x: 120, y: 105, w: 350, h: 230 });
  });

  it("symptom 3/4: a resize right after a drag continues from the dragged position, never snapping back toward a stale/initial rect", () => {
    // Move well away from wherever `start` or a mount-time initial rect might sit.
    let rect = applyDragDelta(start, { x: 200, y: 150 }, viewport, padding);
    expect(rect).toEqual({ x: 300, y: 250, w: 300, h: 200 });

    // Resize must clamp against the current x/y (300, 250), not `start` — a stale baseline
    // would show up as x jumping back toward 690, the viewport-clamped position near the edge.
    rect = applyResizeDelta("e", rect, { x: 10, y: 0 }, minSize, undefined, viewport, padding);
    expect(rect.x).toBe(300);
    expect(rect.w).toBe(310);
  });

  it("dragging right never magnets to the viewport edge before the box actually reaches it", () => {
    let rect: Rect = { x: 500, y: 100, w: 300, h: 200 };
    // Small rightward steps, well short of the right edge (max x = 1000 - 10 - 300 = 690).
    for (let i = 0; i < 5; i++) {
      rect = applyDragDelta(rect, { x: 10, y: 0 }, viewport, padding);
    }
    expect(rect.x).toBe(550);
  });
});
