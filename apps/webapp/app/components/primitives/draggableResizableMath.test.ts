import { describe, expect, it } from "vitest";
import {
  clamp,
  clampPosition,
  clampRectToViewport,
  clampSize,
  resizeRect,
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

  it("east edge grows width, keeps x/y", () => {
    expect(resizeRect("e", start, 50, 0, minSize)).toEqual({ x: 100, y: 100, w: 350, h: 200 });
  });

  it("south edge grows height, keeps x/y", () => {
    expect(resizeRect("s", start, 0, 40, minSize)).toEqual({ x: 100, y: 100, w: 300, h: 240 });
  });

  it("west edge shrinks width and moves x to keep the right edge fixed", () => {
    expect(resizeRect("w", start, 50, 0, minSize)).toEqual({ x: 150, y: 100, w: 250, h: 200 });
  });

  it("north edge shrinks height and moves y to keep the bottom edge fixed", () => {
    expect(resizeRect("n", start, 0, 30, minSize)).toEqual({ x: 100, y: 130, w: 300, h: 170 });
  });

  it("corner edges combine both axes", () => {
    expect(resizeRect("nw", start, 20, 20, minSize)).toEqual({
      x: 120,
      y: 120,
      w: 280,
      h: 180,
    });
    expect(resizeRect("se", start, -20, -20, minSize)).toEqual({
      x: 100,
      y: 100,
      w: 280,
      h: 180,
    });
  });

  it("respects min size when shrinking past it", () => {
    expect(resizeRect("e", start, -1000, 0, minSize)).toEqual({ x: 100, y: 100, w: 100, h: 200 });
    // west edge: width clamps to min, x stops moving with it
    expect(resizeRect("w", start, 1000, 0, minSize)).toEqual({ x: 300, y: 100, w: 100, h: 200 });
  });

  it("respects max size when growing past it", () => {
    const maxSize = { w: 400, h: 300 };
    expect(resizeRect("se", start, 1000, 1000, minSize, maxSize)).toEqual({
      x: 100,
      y: 100,
      w: 400,
      h: 300,
    });
  });
});
